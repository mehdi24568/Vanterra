/**
 * Simulation Engine - a small causal process model of the facility.
 *
 * Faults are injected as changes to *physical parameters* (bearing wear, fan state,
 * joint resistance). Everything an operator later sees - pressure instability, a falling
 * reactor level, rising motor currents - emerges from the model equations below; no
 * symptom is scripted per signal, and no ground truth leaves this module except as
 * ordinary sensor readings.
 */
import { Rng } from '../core/rng';
import { clamp } from '../core/format';
import type { RawReading, ScenarioInfo, SourceEvent } from '../core/types';
import { SOURCE_UNIT_OVERRIDES } from './facility';

export const SIM_EPOCH_MS = Date.UTC(2026, 0, 12, 6, 0, 0);
export const SIM_DT_S = 0.25;

const TWO_PI = Math.PI * 2;
const SQRT3_PF = 1.732 * 0.86;

export const SCENARIOS: ScenarioInfo[] = [
  {
    id: 'pump-bearing',
    name: 'Feed pump bearing degradation',
    kind: 'anomaly',
    summary: 'Progressive mechanical wear in feed pump P-101 over ~90 s.',
    phases: [
      'Vibration on P-101 drifts above its learned baseline',
      'Bearing temperature starts to climb',
      'Discharge pressure on PL-110 becomes unstable; motor M-101 draws more current',
      'Delivered flow falls behind demand; reactor RX-301 level begins to drop',
      'Filler FL-310 is starved if no action is taken',
    ],
  },
  {
    id: 'cooling-fan',
    name: 'Cooling tower fan trip',
    kind: 'anomaly',
    summary: 'The CT-401 fan trips; heat rejection collapses and propagates into the process.',
    phases: [
      'CT-401 reports a tripped fan; fan current falls to zero',
      'Basin temperature rises quickly',
      'Trim chiller CH-402 loads up to compensate, then saturates',
      'Cooling-water supply temperature (PL-410) rises',
      'Process cooler HX-201 outlet and reactor RX-301 temperatures follow',
    ],
  },
  {
    id: 'mcc-sag',
    name: 'MCC-520 supply voltage depression',
    kind: 'anomaly',
    summary: 'A developing high-resistance joint at the MCC-520 incomer depresses bus voltage.',
    phases: [
      'MCC-520 bus voltage sags while MCC-510 stays healthy',
      'Incomer joint temperature rises',
      'Every motor fed from MCC-520 draws more current at the same moment',
      'Winding temperatures on those motors begin to climb',
    ],
  },
  {
    id: 'reduced-rate',
    name: 'Throughput change to 70 %',
    kind: 'normal',
    summary: 'Planned rate reduction. Baselines are re-learned; no anomalies are expected.',
    phases: ['Plant rate ramps from current value to 70 %', 'Detection re-learns baselines for 120 s'],
  },
  {
    id: 'full-rate',
    name: 'Throughput change to 100 %',
    kind: 'normal',
    summary: 'Planned return to nominal rate. Baselines are re-learned; no anomalies are expected.',
    phases: ['Plant rate ramps to 100 %', 'Detection re-learns baselines for 120 s'],
  },
  {
    id: 'pump-changeover',
    name: 'Feed pump duty changeover',
    kind: 'normal',
    summary: 'Routine duty/standby swap between P-101 and P-102 (also a valid response to a P-101 problem).',
    phases: [
      'Standby pump runs up while the duty pump runs down (10 s)',
      'Flow and header pressure remain continuous',
      'Baselines for both pump trains are re-learned',
    ],
  },
  {
    id: 'clear-faults',
    name: 'Clear injected faults',
    kind: 'normal',
    summary: 'Simulated repair: removes all injected faults and lets the process recover.',
    phases: ['Fault parameters reset', 'Process variables return to baseline', 'Open anomalies clear on their own'],
  },
];

interface Faults {
  /** 0..1 - mechanical degradation of P-101. */
  wearP101: number;
  fanTripped: boolean;
  /** Fractional voltage drop across the MCC-520 incomer joint. */
  sag520: number;
}

interface ProcessState {
  t: number;
  rate: number;
  rateTarget: number;
  duty: 'A' | 'B';
  n1: number;
  n2: number;
  distDemand: number;
  tankLevel: number;
  brg1: number;
  brg2: number;
  brg401: number;
  wind101: number;
  wind102: number;
  wind301: number;
  wind320: number;
  wind340: number;
  wind401: number;
  airflow: number;
  fanI: number;
  /** Cooling-tower fan speed setpoint (fraction) held by PLC-500, and the drive's actual speed. */
  fanSpeedSp: number;
  fanSpeed: number;
  basinT: number;
  chLoad: number;
  cws: number;
  tpo: number;
  rxLevel: number;
  rxTemp: number;
  fillRate: number;
  packRate: number;
  palletRate: number;
  availFill: number;
  availPack: number;
  availPal: number;
  acTemp: number;
  i510: number;
  i520: number;
  txLoad: number;
  txOil: number;
  bus510T: number;
  bus520T: number;
}

/** Instantaneous (algebraic) quantities computed each step from the state. */
interface Derived {
  vTx: number;
  v510: number;
  v520: number;
  demand: number;
  q: number;
  pd: number;
  suction: number;
  vib1: number;
  vib2: number;
  i101: number;
  i102: number;
  i301: number;
  i320: number;
  i340: number;
  i401: number;
  iAC: number;
  chCurrent: number;
  cwFlow: number;
  cwr: number;
  hxDp: number;
  qOut: number;
  speed320: number;
  speed340: number;
  airP: number;
  fillSp: number;
}

const lag = (current: number, target: number, tau: number, dt: number) => current + ((target - current) * dt) / tau;

export class SimulationEngine {
  readonly dtS = SIM_DT_S;
  private rng: Rng;
  private seed: number;
  private s!: ProcessState;
  private d!: Derived;
  private faults!: Faults;
  private active = new Map<string, number>();
  private pendingEvents: SourceEvent[] = [];

  constructor(seed: number) {
    this.seed = seed;
    this.rng = new Rng(seed);
    this.initialise();
  }

  get timeMs(): number {
    return SIM_EPOCH_MS + Math.round(this.s.t * 1000);
  }

  get activeScenarios(): string[] {
    return [...this.active.keys()];
  }

  get operatingPoint(): { rate: number; rateTarget: number; duty: 'A' | 'B' } {
    return { rate: this.s.rate, rateTarget: this.s.rateTarget, duty: this.s.duty };
  }

  reset(seed = this.seed): void {
    this.seed = seed;
    this.rng = new Rng(seed);
    this.active.clear();
    this.pendingEvents = [];
    this.initialise();
  }

  private initialise(): void {
    this.faults = { wearP101: 0, fanTripped: false, sag520: 0 };
    this.s = {
      t: 0,
      rate: 1,
      rateTarget: 1,
      duty: 'A',
      n1: 1,
      n2: 0,
      distDemand: 0,
      tankLevel: 70,
      brg1: 56,
      brg2: 24,
      brg401: 54,
      wind101: 68,
      wind102: 24,
      wind301: 68,
      wind320: 68,
      wind340: 68,
      wind401: 68,
      airflow: 1,
      fanI: 38,
      fanSpeedSp: 1,
      fanSpeed: 1,
      basinT: 24,
      chLoad: 0.25,
      cws: 22,
      tpo: 34.9,
      rxLevel: 62,
      rxTemp: 44.4,
      fillRate: 240,
      packRate: 20,
      palletRate: 20,
      availFill: 100,
      availPack: 100,
      availPal: 100,
      acTemp: 78,
      i510: 322,
      i520: 246,
      txLoad: 337,
      txOil: 58,
      bus510T: 42,
      bus520T: 42,
    };
    // Settle the lagged states to a true steady state (noise-free) so the first
    // recorded sample is already at equilibrium.
    for (let i = 0; i < 6000; i++) this.advance(this.dtS, false);
    this.s.t = 0;
    this.advance(0, false);
  }

  // ---------------------------------------------------------------- scenarios

  trigger(id: string): boolean {
    const info = SCENARIOS.find((sc) => sc.id === id);
    if (!info) return false;
    const t = this.timeMs;
    const sim = (title: string, detail: string, assetIds: string[] = []) =>
      this.pendingEvents.push({ t, kind: 'simulation_control', title, detail, assetIds, scenarioId: id });

    switch (id) {
      case 'pump-bearing':
      case 'cooling-fan':
      case 'mcc-sag':
        if (this.active.has(id)) return false;
        this.active.set(id, this.s.t);
        sim(`Scenario injected: ${info.name}`, 'Simulation control. Not visible to detection or reasoning.');
        return true;
      case 'reduced-rate':
      case 'full-rate': {
        const target = id === 'reduced-rate' ? 0.7 : 1;
        if (Math.abs(this.s.rateTarget - target) < 1e-6) return false;
        this.s.rateTarget = target;
        const rampS = Math.abs(target - this.s.rate) / 0.015;
        this.pendingEvents.push({
          t,
          kind: 'operating_point_change',
          title: `Plant rate setpoint changed to ${Math.round(target * 100)} %`,
          detail: 'Commanded operating-point change. Baselines are re-learned once the plant has settled.',
          assetIds: [],
          rebaseline: { assetIds: 'all', holdS: rampS + 120 },
          scenarioId: id,
        });
        return true;
      }
      case 'pump-changeover': {
        this.s.duty = this.s.duty === 'A' ? 'B' : 'A';
        const [to, from] = this.s.duty === 'A' ? ['P-101', 'P-102'] : ['P-102', 'P-101'];
        const assetIds = ['P-101', 'P-102', 'M-101', 'M-102', 'PL-100', 'PL-110'];
        this.pendingEvents.push({
          t,
          kind: 'equipment_state_change',
          title: `Feed pump duty changeover: ${from} → ${to}`,
          detail: `Commanded changeover. ${to} takes duty, ${from} goes to standby.`,
          assetIds,
          rebaseline: { assetIds, holdS: 150 },
          scenarioId: id,
        });
        return true;
      }
      case 'clear-faults':
        this.active.clear();
        this.faults = { wearP101: 0, fanTripped: false, sag520: 0 };
        this.s.fanSpeedSp = 1;
        sim('Simulation: injected faults cleared', 'Simulated repair and configuration restore. Process variables will recover on their own.');
        return true;
      default:
        return false;
    }
  }

  /**
   * A controller setting written through the (simulated) engineering path. Only the
   * cooling-tower fan speed setpoint is wired into the process model. Deliberately
   * not announced on the operations channel: the plant simply responds to it.
   */
  setControlParameter(parameterId: string, value: number): boolean {
    if (parameterId !== 'PLC-500:CT401_FAN_SPEED_SP') return false;
    this.s.fanSpeedSp = clamp(value / 100, 0, 1);
    return true;
  }

  private updateFaults(): void {
    const elapsed = (id: string) => {
      const start = this.active.get(id);
      return start === undefined ? -1 : this.s.t - start;
    };
    const eBearing = elapsed('pump-bearing');
    if (eBearing >= 0) this.faults.wearP101 = 0.85 * clamp(eBearing / 90, 0, 1);
    const eFan = elapsed('cooling-fan');
    if (eFan >= 3) this.faults.fanTripped = true;
    const eSag = elapsed('mcc-sag');
    if (eSag >= 0) this.faults.sag520 = 0.12 * clamp(eSag / 25, 0, 1);
  }

  // ------------------------------------------------------------------ dynamics

  private advance(dt: number, noisy: boolean): void {
    const s = this.s;
    const f = this.faults;
    s.t += dt;
    const ambient = 24 + 0.5 * Math.sin((TWO_PI * s.t) / 240);
    const wetBulb = 18 + 0.05 * Math.sin((TWO_PI * s.t) / 310 + 1);

    // Operating point and duty selection.
    s.rate += clamp(s.rateTarget - s.rate, -0.015 * dt, 0.015 * dt);
    s.n1 += clamp((s.duty === 'A' ? 1 : 0) - s.n1, -dt / 10, dt / 10);
    s.n2 += clamp((s.duty === 'B' ? 1 : 0) - s.n2, -dt / 10, dt / 10);
    if (noisy && dt > 0) {
      // Slow demand disturbance (Ornstein-Uhlenbeck) - gives the plant some life.
      s.distDemand += (-s.distDemand / 8) * dt + 0.6 * Math.sqrt((2 * dt) / 8) * this.rng.gauss();
    }

    // Electrical supply (uses last step's currents - breaks the algebraic loop).
    const vTx = 401 - 2 * (s.txLoad / 337);
    const v510 = vTx - s.i510 / 322;
    const v520 = (vTx - s.i520 / 246) * (1 - f.sag520);
    const vf510 = v510 / 398;
    const vf520 = v520 / 398;

    // Feed pumps.
    const wear = f.wearP101;
    const cap1 = s.n1 * 1.12 * (1 - 0.3 * wear);
    const cap2 = s.n2 * 1.12;
    const cap = cap1 + cap2;
    const demand = clamp(120 * s.rate + 2 * (62 - s.rxLevel) + s.distDemand, 0, 140);
    const q = Math.min(demand, 120 * cap);
    const q1 = cap > 1e-6 ? (q * cap1) / cap : 0;
    const q2 = q - q1;
    const headFactor = Math.min(1, s.n1 * (1 - 0.25 * wear) + s.n2);
    const fluct = s.n1 * wear * (0.45 * Math.sin(TWO_PI * 0.7 * s.t) + 0.25 * Math.sin(TWO_PI * 1.9 * s.t + 1));
    const pd = headFactor * (6.2 - 0.4 * ((q / 120) ** 2 - 1)) + fluct;
    const vib1 = s.n1 * (2.2 + 9 * wear ** 1.3) + (1 - s.n1) * 0.15;
    const vib2 = s.n2 * 2.0 + (1 - s.n2) * 0.15;
    // Friction heating grows with the square of wear, so temperature trails vibration.
    s.brg1 = lag(s.brg1, ambient + s.n1 * (28 + 54 * wear * wear + (4 * q1) / 120), 25, dt);
    s.brg2 = lag(s.brg2, ambient + s.n2 * (27 + (4 * q2) / 120), 25, dt);
    const i101 = (86 * (0.38 * s.n1 + (0.62 * q1) / 120) * (1 + 0.32 * wear)) / vf510;
    const i102 = (86 * (0.38 * s.n2 + (0.62 * q2) / 120)) / vf510;
    s.wind101 = lag(s.wind101, ambient + 44 * (i101 / 86) ** 2, 40, dt);
    s.wind102 = lag(s.wind102, ambient + 44 * (i102 / 86) ** 2, 40, dt);

    // Feed tank (level-controlled make-up).
    s.tankLevel = clamp(s.tankLevel + (120 * s.rate + 6 * (70 - s.tankLevel) - q) * dt * 0.002, 0, 100);
    const suction = 0.35 + 0.0125 * s.tankLevel - 0.15 * (q / 120) ** 2;

    // Cooling loop: tower -> pump -> trim chiller -> process cooler -> tower.
    // The fan drive ramps to the speed setpoint held by PLC-500. At full speed these
    // expressions reduce exactly to the original model, so existing runs are unchanged.
    s.fanSpeed = lag(s.fanSpeed, s.fanSpeedSp, 3, dt);
    const full = s.fanSpeed === 1;
    s.airflow = lag(s.airflow, f.fanTripped ? 0.12 : full ? 1 : 0.12 + 0.88 * s.fanSpeed, 4, dt);
    s.fanI = lag(s.fanI, f.fanTripped ? 0 : (full ? 38 : 38 * (0.12 + 0.88 * s.fanSpeed ** 3)) / vf510, 0.8, dt);
    const cwFlow = 200;
    const heatLoad = (q * (68 - s.tpo)) / (120 * 33.1);
    s.basinT = lag(s.basinT, wetBulb + 6 * heatLoad + (14.5 * (1 - s.airflow)) / 0.88, 30, dt);
    s.chLoad = lag(s.chLoad, clamp((s.basinT - 22) / 8, 0, 1), 6, dt);
    s.cws = lag(s.cws, s.basinT - 8 * s.chLoad, 8, dt);
    const chCurrent = (42 + 108 * s.chLoad) / vf510;
    const eff = clamp((0.72 * Math.sqrt(cwFlow / 200)) / Math.max(0.3, q / 120) ** 0.4, 0, 0.92);
    s.tpo = lag(s.tpo, 68 - eff * (68 - s.cws), 12, dt);
    const cwr = s.cws + (q / cwFlow) * (68 - s.tpo);
    const hxDp = 1.1 * (q / 120) ** 2;
    const i401 = 64 / vf510;
    s.brg401 = lag(s.brg401, ambient + 30, 25, dt);
    s.wind401 = lag(s.wind401, ambient + 44 * (i401 / 64) ** 2, 40, dt);

    // Reactor and product transfer.
    const starve = clamp(s.rxLevel / 30, 0, 1);
    const qOut = 120 * s.rate * starve;
    s.rxLevel = clamp(s.rxLevel + (q - qOut) * dt * 0.0125, 0, 100);
    s.rxTemp = lag(s.rxTemp, s.tpo + 9.5, 45, dt);
    const i301 = (54 * (0.55 + (0.45 * s.rxLevel) / 62)) / vf520;
    s.wind301 = lag(s.wind301, ambient + 44 * (i301 / 54) ** 2, 40, dt);

    // Plant air.
    const iAC = 61 / vf520;
    s.acTemp = lag(s.acTemp, 54 + ambient + 30 * ((iAC / 61) ** 2 - 1), 30, dt);
    const airP = 7.0;

    // Packaging line.
    const slip = 1 - 0.04 * ((1 / vf520) ** 2 - 1);
    const speed320 = 0.8 * slip;
    const speed340 = 0.8 * slip;
    const fillSp = 240 * s.rate;
    s.fillRate = lag(s.fillRate, Math.min(fillSp * starve, 300 * (speed320 / 0.8)), 2, dt);
    s.packRate = lag(s.packRate, s.fillRate / 12, 4, dt);
    s.palletRate = lag(s.palletRate, s.packRate, 6, dt);
    const ratio = (actual: number, target: number) => 100 * Math.min(1, actual / Math.max(1e-6, target));
    s.availFill = lag(s.availFill, ratio(s.fillRate, fillSp), 60, dt);
    s.availPack = lag(s.availPack, ratio(s.packRate, fillSp / 12), 60, dt);
    s.availPal = lag(s.availPal, ratio(s.palletRate, fillSp / 12), 60, dt);
    const i320 = (22 * (0.6 + (0.4 * s.fillRate) / 240)) / vf520;
    const i340 = (22 * (0.6 + (0.4 * s.packRate) / 20)) / vf520;
    s.wind320 = lag(s.wind320, ambient + 44 * (i320 / 22) ** 2, 40, dt);
    s.wind340 = lag(s.wind340, ambient + 44 * (i340 / 22) ** 2, 40, dt);

    // Distribution boards and transformer.
    s.i510 = i101 + i102 + i401 + s.fanI + chCurrent + 65 / vf510;
    s.i520 = i301 + i320 + i340 + iAC + 87 / vf520;
    s.bus510T = lag(s.bus510T, ambient + 18 * (s.i510 / 322) ** 2, 35, dt);
    s.bus520T = lag(s.bus520T, ambient + 18 * (s.i520 / 246) ** 2 + 400 * f.sag520, 20, dt);
    s.txLoad = (SQRT3_PF * vTx * (s.i510 + s.i520)) / 1000;
    s.txOil = lag(s.txOil, ambient + 34 * (s.txLoad / 337) ** 2, 120, dt);

    this.d = {
      vTx,
      v510,
      v520,
      demand,
      q,
      pd,
      suction,
      vib1,
      vib2,
      i101,
      i102,
      i301,
      i320,
      i340,
      i401,
      iAC,
      chCurrent,
      cwFlow,
      cwr,
      hxDp,
      qOut,
      speed320,
      speed340,
      airP,
      fillSp,
    };
  }

  // -------------------------------------------------------------- measurement

  /** Advance one tick and return the sensor readings taken at the new time. */
  step(): { readings: RawReading[]; events: SourceEvent[] } {
    this.updateFaults();
    this.advance(this.dtS, true);
    const s = this.s;
    const d = this.d;
    const f = this.faults;
    const ts = this.timeMs;
    const readings: RawReading[] = [];
    const rng = this.rng;

    const emit = (tag: string, value: number, sigma: number, min = -Infinity) => {
      let val = Math.max(min, value + sigma * rng.gauss());
      const unit = SOURCE_UNIT_OVERRIDES[tag];
      if (unit === 'psi') val *= 14.5038;
      else if (unit === 'degF') val = val * 1.8 + 32;
      readings.push(unit ? { tag, ts, value: val, unit } : { tag, ts, value: val });
    };
    const kw = (volts: number, amps: number) => (SQRT3_PF * volts * amps) / 1000;
    const wear = f.wearP101;

    emit('TK-101.LEVEL', s.tankLevel, 0.12, 0);
    emit('TK-101.TEMP', 68, 0.15);
    emit('TK-102.LEVEL', 81, 0.1, 0);

    emit('P-101.VIB', d.vib1, 0.1 * (1 + wear) * (0.2 + 0.8 * s.n1), 0);
    emit('P-101.BRG_TEMP', s.brg1, 0.22);
    emit('P-101.STATUS', s.n1 > 0.5 ? 1 : 0, 0);
    emit('M-101.CURRENT', d.i101, 0.45 * (0.1 + 0.9 * s.n1), 0);
    emit('M-101.WIND_TEMP', s.wind101, 0.25);
    emit('M-101.POWER', kw(d.v510, d.i101), 0.3 * (0.1 + 0.9 * s.n1), 0);
    emit('M-101.STATUS', s.n1 > 0.5 ? 1 : 0, 0);

    emit('P-102.VIB', d.vib2, 0.1 * (0.2 + 0.8 * s.n2), 0);
    emit('P-102.BRG_TEMP', s.brg2, 0.22);
    emit('P-102.STATUS', s.n2 > 0.5 ? 1 : 0, 0);
    emit('M-102.CURRENT', d.i102, 0.45 * (0.1 + 0.9 * s.n2), 0);
    emit('M-102.WIND_TEMP', s.wind102, 0.25);
    emit('M-102.POWER', kw(d.v510, d.i102), 0.3 * (0.1 + 0.9 * s.n2), 0);
    emit('M-102.STATUS', s.n2 > 0.5 ? 1 : 0, 0);

    emit('LS-601.OIL_P', 2.4, 0.012);
    emit('LS-601.OIL_TEMP', 45 + 0.4 * Math.sin((TWO_PI * s.t) / 200), 0.15);

    emit('PL-100.PRESS', d.suction, 0.006, 0);
    emit('PL-110.PRESS', d.pd, 0.03 * (1 + 4 * wear * s.n1), 0);
    emit('PL-110.FLOW', d.q, 0.5, 0);
    emit('PL-110.FLOW_SP', d.demand, 0);

    emit('HX-201.T_OUT', s.tpo, 0.12);
    emit('HX-201.DP', d.hxDp, 0.008, 0);
    emit('PL-120.PRESS', d.pd - d.hxDp - 0.2, 0.03, 0);

    emit('RX-301.LEVEL', s.rxLevel, 0.15, 0);
    emit('RX-301.TEMP', s.rxTemp, 0.1);
    emit('M-301.CURRENT', d.i301, 0.3, 0);
    emit('M-301.WIND_TEMP', s.wind301, 0.25);
    emit('M-301.POWER', kw(d.v520, d.i301), 0.2, 0);
    emit('M-301.STATUS', 1, 0);
    emit('PL-130.FLOW', d.qOut, 0.5, 0);
    emit('PL-130.PRESS', 1.2 + 0.012 * s.rxLevel, 0.01, 0);

    emit('FL-310.RATE', s.fillRate, 1.1, 0);
    emit('FL-310.RATE_SP', d.fillSp, 0);
    emit('FL-310.AIR_P', d.airP - 0.4, 0.02, 0);
    emit('FL-310.AVAIL', s.availFill, 0);
    emit('CV-320.SPEED', d.speed320, 0.003, 0);
    emit('CV-320.VIB', 1.6, 0.08, 0);
    emit('M-320.CURRENT', d.i320, 0.14, 0);
    emit('M-320.WIND_TEMP', s.wind320, 0.25);
    emit('M-320.POWER', kw(d.v520, d.i320), 0.1, 0);
    emit('M-320.STATUS', 1, 0);
    emit('PK-330.RATE', s.packRate, 0.12, 0);
    emit('PK-330.AVAIL', s.availPack, 0);
    emit('CV-340.SPEED', d.speed340, 0.003, 0);
    emit('CV-340.VIB', 1.6, 0.08, 0);
    emit('M-340.CURRENT', d.i340, 0.14, 0);
    emit('M-340.WIND_TEMP', s.wind340, 0.25);
    emit('M-340.POWER', kw(d.v520, d.i340), 0.1, 0);
    emit('M-340.STATUS', 1, 0);
    emit('PZ-350.RATE', s.palletRate, 0.12, 0);
    emit('PZ-350.AVAIL', s.availPal, 0);

    emit('CT-401.FAN_CURRENT', s.fanI, f.fanTripped ? 0.02 : 0.25, 0);
    emit('CT-401.BASIN_TEMP', s.basinT, 0.1);
    emit('CT-401.FAN_VIB', 0.15 + 2.25 * clamp(s.fanI / 38, 0, 1.2), 0.09, 0);
    emit('CT-401.STATUS', f.fanTripped ? 2 : 1, 0);
    emit('P-401.VIB', 2.0, 0.09, 0);
    emit('P-401.BRG_TEMP', s.brg401, 0.22);
    emit('P-401.STATUS', 1, 0);
    emit('M-401.CURRENT', d.i401, 0.35, 0);
    emit('M-401.WIND_TEMP', s.wind401, 0.25);
    emit('M-401.POWER', kw(d.v510, d.i401), 0.25, 0);
    emit('M-401.STATUS', 1, 0);
    emit('CH-402.COMP_CURRENT', d.chCurrent, 0.5, 0);
    emit('CH-402.LOAD', s.chLoad * 100, 0.35, 0);
    emit('CH-402.POWER', kw(d.v510, d.chCurrent), 0.3, 0);
    emit('PL-400.PRESS', 3.4, 0.015, 0);
    emit('PL-410.TEMP', s.cws, 0.07);
    emit('PL-410.FLOW', d.cwFlow, 0.9, 0);
    emit('PL-420.TEMP', d.cwr, 0.12);

    emit('TX-501.LOAD', s.txLoad, 1.2, 0);
    emit('TX-501.OIL_TEMP', s.txOil, 0.15);
    emit('TX-501.LV_VOLT', d.vTx, 0.35);
    emit('MCC-510.VOLT', d.v510, 0.35);
    emit('MCC-510.CURRENT', s.i510, 1.0, 0);
    emit('MCC-510.BUS_TEMP', s.bus510T, 0.2);
    emit('MCC-520.VOLT', d.v520, 0.35);
    emit('MCC-520.CURRENT', s.i520, 0.9, 0);
    emit('MCC-520.BUS_TEMP', s.bus520T, 0.2);
    emit('AC-610.DISCH_P', d.airP, 0.02, 0);
    emit('AC-610.CURRENT', d.iAC, 0.3, 0);
    emit('AC-610.DISCH_TEMP', s.acTemp, 0.25);

    const events = this.pendingEvents;
    this.pendingEvents = [];
    return { readings, events };
  }
}
