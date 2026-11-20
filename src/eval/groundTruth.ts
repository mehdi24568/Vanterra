/**
 * Ground truth for the evaluation harness.
 *
 * The detection and reasoning engines never see which fault was injected. The
 * harness does: it knows the injected scenario (so the expected origin and the
 * expected leading explanation), and it derives *which signals the fault actually
 * moved* with a counterfactual twin run.
 *
 * Twin run: two simulators with the same seed advance in lock-step; the fault is
 * injected into one of them only. Both consume the random stream identically, so
 * the difference between them is the fault's effect with the measurement noise
 * cancelled out. A signal's effect is expressed in units of that signal's own
 * standard deviation in the fault-free twin.
 */
import type { Incident } from '../core/types';
import { boot } from '../runtime/testHarness';

export interface FaultTruth {
  scenario: string;
  /** The asset where the simulator injects the fault: the correct origin. */
  origin: string;
  /** The rule-based hypothesis template that describes the injected mechanism. */
  leadTemplate: string;
}

export const FAULTS: FaultTruth[] = [
  { scenario: 'pump-bearing', origin: 'P-101', leadTemplate: 'bearing_wear' },
  { scenario: 'cooling-fan', origin: 'CT-401', leadTemplate: 'tower_airflow_loss' },
  { scenario: 'mcc-sag', origin: 'MCC-520', leadTemplate: 'mcc_joint' },
];

/**
 * The flagship cyber-physical case for the live evaluation: an unapproved fan-speed
 * setpoint change. Its physical mechanism is reduced tower airflow; the cyber-physical
 * assessment (in the agents' context) supports a control-system change, intent unknown.
 */
export const CYBER_PHYSICAL_FLAGSHIP: FaultTruth = { scenario: 'cp-fan-setpoint', origin: 'CT-401', leadTemplate: 'tower_airflow_loss' };

/** Ten seeds: the default demo seed plus nine others chosen in advance (not tuned). */
export const EVAL_SEEDS = [20260112, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/** A signal counts as materially affected when the fault moved it by at least this many σ… */
export const MATERIAL_Z = 3;
/** …for at least this long in total (seconds). */
export const MATERIAL_MIN_S = 5;
/** A detection is "on an affected signal" when the fault moved that signal by at least 1 σ. */
export const AFFECTED_Z = 1;

export interface SignalEffect {
  signalId: string;
  assetId: string;
  maxZ: number;
  secondsOverMaterial: number;
  firstMaterialS: number | null;
  identical: boolean;
  /** Watched by at least one detector (baseline/variability statistics or engineering limits). */
  monitored: boolean;
}

export interface IncidentSample {
  t: number;
  incidents: { id: string; origin: string | null; lead: string | null; assets: string[] }[];
}

export interface TwinResult {
  seed: number;
  scenarios: string[];
  seconds: number;
  /** Plant time of injection (ms). */
  t0: number;
  effects: SignalEffect[];
  /** Detections opened in the faulted run after injection: signalId -> seconds after injection. */
  detections: { signalId: string; assetId: string; atS: number }[];
  /** Detections in the fault-free twin over the same window (should be none). */
  twinDetections: number;
  incidents: Incident[];
  samples: IncidentSample[];
}

function snapshot(list: Incident[]): IncidentSample['incidents'] {
  return list.map((i) => ({ id: i.id, origin: i.origin?.assetId ?? null, lead: i.hypotheses[0]?.templateId ?? null, assets: i.assets.map((a) => a.assetId) }));
}

export function twinRun(seed: number, scenarios: string[], seconds: number, prerollS = 120): TwinResult {
  const faulted = boot(seed, prerollS);
  const twin = boot(seed, prerollS);
  const tick = faulted.adapter.tickS;
  const t0 = faulted.core.now;
  const signals = faulted.core.signals.filter((s) => s.role === 'measurement');
  for (const s of scenarios) faulted.adapter.trigger(s);

  const ticks = Math.round(seconds / tick);
  const diffs = new Map<string, Float64Array>();
  const twinVals = new Map<string, Float64Array>();
  for (const s of signals) {
    diffs.set(s.id, new Float64Array(ticks));
    twinVals.set(s.id, new Float64Array(ticks));
  }
  const samples: IncidentSample[] = [];
  const perSample = Math.round(1 / tick);
  for (let k = 0; k < ticks; k++) {
    faulted.core.advance(1);
    twin.core.advance(1);
    for (const s of signals) {
      const a = faulted.core.telemetry.latest(s.id) ?? NaN;
      const b = twin.core.telemetry.latest(s.id) ?? NaN;
      diffs.get(s.id)![k] = Math.abs(a - b);
      twinVals.get(s.id)![k] = b;
    }
    if ((k + 1) % perSample === 0) samples.push({ t: (k + 1) * tick, incidents: snapshot(faulted.core.intelligence.incidents()) });
  }

  const effects: SignalEffect[] = signals.map((s) => {
    const v = twinVals.get(s.id)!;
    let mean = 0;
    for (const x of v) mean += x;
    mean /= v.length;
    let varSum = 0;
    for (const x of v) varSum += (x - mean) ** 2;
    const sigma = Math.sqrt(varSum / Math.max(1, v.length - 1));
    const d = diffs.get(s.id)!;
    let maxZ = 0;
    let over = 0;
    let first: number | null = null;
    let identical = true;
    for (let k = 0; k < d.length; k++) {
      if (d[k] !== 0) identical = false;
      const z = sigma > 0 ? d[k] / sigma : d[k] > 1e-9 ? Infinity : 0;
      if (z > maxZ) maxZ = z;
      if (z >= MATERIAL_Z) {
        over += 1;
        if (first === null) first = (k + 1) * tick;
      }
    }
    return { signalId: s.id, assetId: s.assetId, maxZ, secondsOverMaterial: over * tick, firstMaterialS: first, identical, monitored: s.detect.baseline || s.detect.variability || !!s.limits };
  });

  const detections = faulted.core.anomalies
    .all()
    .filter((a) => a.startedAt >= t0)
    .map((a) => ({ signalId: a.signalId, assetId: a.assetId, atS: (a.startedAt - t0) / 1000 }))
    .sort((x, y) => x.atS - y.atS);

  return {
    seed,
    scenarios,
    seconds,
    t0,
    effects,
    detections,
    twinDetections: twin.core.anomalies.all().filter((a) => a.startedAt >= t0).length,
    incidents: faulted.core.intelligence.incidents(),
    samples,
  };
}

export const isMaterial = (e: SignalEffect) => e.secondsOverMaterial >= MATERIAL_MIN_S;
export const isAffected = (e: SignalEffect) => e.maxZ >= AFFECTED_Z;
