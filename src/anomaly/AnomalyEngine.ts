/**
 * Anomaly Detection Engine.
 *
 * Six detectors run on every observation; all are statistical or rule-based and
 * every anomaly records the exact numbers that satisfied its rule:
 *
 *   threshold          absolute alarm limits (configurable per signal)
 *   baseline deviation z-score of a 2 s mean against a learned baseline
 *   rate of change     least-squares slope over a 10 s window
 *   variability        residual scatter around the trend vs. baseline scatter
 *   setpoint deviation measurement vs. its controller demand
 *   composite ratio    an abnormal *combination* of two signals (e.g. current per unit flow)
 *
 * The engine has no knowledge of scenarios or faults. Its only inputs are
 * observations and commanded-change notices (which trigger baseline re-learning).
 */
import type {
  Anomaly,
  AnomalyDirection,
  AnomalyEvent,
  AnomalyKind,
  BaselineInfo,
  Observation,
  RatioRuleDefinition,
  Severity,
  SignalDefinition,
} from '../core/types';
import { SEVERITY_RANK } from '../core/types';
import { formatValue } from '../core/format';

export interface DetectionConfig {
  /** Seconds of data used to learn a baseline. */
  warmupS: number;
  /** Analysis window for slope and variability. */
  windowS: number;
  /** Averaging window for baseline and setpoint comparisons. */
  shortS: number;
  zOpen: number;
  zClear: number;
  zWarn: number;
  /** Minimum baseline sigma, as a fraction of the signal's engineering range. */
  sigmaFloorFrac: number;
  variabilityRatio: number;
  persistS: { threshold: number; baseline: number; rate: number; variability: number; setpoint: number; ratio: number };
  clearS: number;
  /** EWMA factor for slow baseline adaptation while behaviour is normal. */
  adaptAlpha: number;
}

export const DEFAULT_DETECTION: DetectionConfig = {
  warmupS: 40,
  windowS: 10,
  shortS: 2,
  zOpen: 4,
  zClear: 2.5,
  zWarn: 8,
  sigmaFloorFrac: 0.005,
  variabilityRatio: 3,
  persistS: { threshold: 1.5, baseline: 3, rate: 4, variability: 4, setpoint: 5, ratio: 5 },
  clearS: 6,
  adaptAlpha: 0.0015,
};

const WINDOW_CAP = 96;
const SUPPRESSED_REASON = 'Commanded operating change - baseline re-learning';

interface Cond {
  since: number | null;
  clearSince: number | null;
  anomaly: Anomaly | null;
}

const newCond = (): Cond => ({ since: null, clearSince: null, anomaly: null });

type CondKey = 'th_high' | 'th_low' | 'baseline' | 'rate' | 'variability' | 'setpoint';

interface SignalState {
  def: SignalDefinition;
  floor: number;
  wt: Float64Array;
  wv: Float64Array;
  head: number;
  size: number;
  bN: number;
  bMean: number;
  bM2: number;
  bStd: number;
  ready: boolean;
  learnStart: number | null;
  holdoffUntil: number;
  mShort: number;
  z: number;
  conds: Record<CondKey, Cond>;
}

interface RatioState {
  def: RatioRuleDefinition;
  bN: number;
  bMean: number;
  ready: boolean;
  learnStart: number | null;
  holdoffUntil: number;
  smoothed: number | null;
  cond: Cond;
}

interface Draft {
  kind: AnomalyKind;
  direction: AnomalyDirection;
  severity: Severity;
  detector: string;
  rule: string;
  message: string;
  value: number;
  /** Larger = more extreme, used to track the peak irrespective of direction. */
  extremity: number;
  limit?: number;
  zScore?: number;
  slopePerMin?: number;
  ratioPct?: number;
}

export class AnomalyEngine {
  readonly config: DetectionConfig;
  private states = new Map<string, SignalState>();
  private ratios: RatioState[] = [];
  private anomalies = new Map<string, Anomaly>();
  private peaks = new Map<string, number>();
  private events: AnomalyEvent[] = [];
  private seq = 0;

  constructor(signals: SignalDefinition[], ratioRules: RatioRuleDefinition[], config: Partial<DetectionConfig> = {}) {
    this.config = { ...DEFAULT_DETECTION, ...config };
    for (const def of signals) {
      this.states.set(def.id, {
        def,
        floor: (def.range[1] - def.range[0]) * this.config.sigmaFloorFrac,
        wt: new Float64Array(WINDOW_CAP),
        wv: new Float64Array(WINDOW_CAP),
        head: 0,
        size: 0,
        bN: 0,
        bMean: 0,
        bM2: 0,
        bStd: 0,
        ready: false,
        learnStart: null,
        holdoffUntil: 0,
        mShort: NaN,
        z: 0,
        conds: {
          th_high: newCond(),
          th_low: newCond(),
          baseline: newCond(),
          rate: newCond(),
          variability: newCond(),
          setpoint: newCond(),
        },
      });
    }
    this.ratios = ratioRules.map((def) => ({
      def,
      bN: 0,
      bMean: 0,
      ready: false,
      learnStart: null,
      holdoffUntil: 0,
      smoothed: null,
      cond: newCond(),
    }));
  }

  // ------------------------------------------------------------------ queries

  drainEvents(): AnomalyEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  get(id: string): Anomaly | undefined {
    return this.anomalies.get(id);
  }

  all(): Anomaly[] {
    return [...this.anomalies.values()];
  }

  active(): Anomaly[] {
    const res: Anomaly[] = [];
    for (const a of this.anomalies.values()) if (a.status === 'active') res.push(a);
    return res;
  }

  baseline(signalId: string): BaselineInfo | undefined {
    const st = this.states.get(signalId);
    if (!st) return undefined;
    return { ready: st.ready, mean: st.bMean, std: st.bStd, samples: st.bN, holdoffUntil: st.holdoffUntil };
  }

  /** Current z-score of the short-window mean against the baseline (0 while learning). */
  zScore(signalId: string): number {
    const st = this.states.get(signalId);
    return st && st.ready ? st.z : 0;
  }

  /** Short-window mean most recently computed for a signal. */
  smoothed(signalId: string): number | undefined {
    const st = this.states.get(signalId);
    return st && Number.isFinite(st.mShort) ? st.mShort : undefined;
  }

  // ------------------------------------------------------------- re-baselining

  /** A commanded change makes old baselines meaningless: hold off, then re-learn. */
  rebaseline(scope: string[] | 'all', holdS: number, now: number): void {
    const inScope = (assetId: string) => scope === 'all' || scope.includes(assetId);
    const until = now + holdS * 1000;
    for (const st of this.states.values()) {
      if (!inScope(st.def.assetId)) continue;
      st.holdoffUntil = Math.max(st.holdoffUntil, until);
      st.bN = 0;
      st.bM2 = 0;
      st.ready = false;
      st.learnStart = null;
      for (const key of ['baseline', 'rate', 'variability'] as CondKey[]) {
        this.clear(st.conds[key], now, SUPPRESSED_REASON);
      }
    }
    for (const rs of this.ratios) {
      if (!inScope(rs.def.assetId)) continue;
      rs.holdoffUntil = Math.max(rs.holdoffUntil, until);
      rs.bN = 0;
      rs.ready = false;
      rs.learnStart = null;
      rs.smoothed = null;
      this.clear(rs.cond, now, SUPPRESSED_REASON);
    }
  }

  // ---------------------------------------------------------------- detection

  process(obs: Observation): void {
    const st = this.states.get(obs.signalId);
    if (!st) return;
    const cfg = this.config;
    const now = obs.t;
    const def = st.def;

    st.wt[st.head] = now;
    st.wv[st.head] = obs.value;
    st.head = (st.head + 1) % WINDOW_CAP;
    if (st.size < WINDOW_CAP) st.size += 1;

    if (def.role === 'setpoint') {
      st.mShort = obs.value;
      return;
    }

    // One backwards pass over the window gathers everything the detectors need.
    // Samples taken during a hold-off belong to the commanded transition and are
    // never used for slope or scatter once detection resumes.
    const cutWin = Math.max(now - cfg.windowS * 1000, st.holdoffUntil);
    const cutShort = now - cfg.shortS * 1000;
    const cutInst = now - 1000;
    let n = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    let nShort = 0;
    let sShort = 0;
    let nInst = 0;
    let sInst = 0;
    let oldest = now;
    for (let i = 1; i <= st.size; i++) {
      const idx = (st.head - i + WINDOW_CAP) % WINDOW_CAP;
      const t = st.wt[idx];
      if (t < cutWin) break;
      const y = st.wv[idx];
      const x = (t - now) / 1000;
      n += 1;
      sx += x;
      sy += y;
      sxx += x * x;
      sxy += x * y;
      syy += y * y;
      oldest = t;
      if (t >= cutShort) {
        nShort += 1;
        sShort += y;
      }
      if (t >= cutInst) {
        nInst += 1;
        sInst += y;
      }
    }
    const mShort = nShort > 0 ? sShort / nShort : obs.value;
    const mInst = nInst > 0 ? sInst / nInst : obs.value;
    st.mShort = mShort;
    const suppressed = now < st.holdoffUntil;

    // --- baseline learning / adaptation
    if (!suppressed) {
      if (!st.ready) {
        if (st.learnStart === null) st.learnStart = now;
        st.bN += 1;
        const delta = obs.value - st.bMean;
        st.bMean = st.bN === 1 ? obs.value : st.bMean + delta / st.bN;
        st.bM2 += delta * (obs.value - st.bMean);
        if (now - st.learnStart >= cfg.warmupS * 1000 && st.bN >= 20) {
          st.bStd = Math.max(Math.sqrt(st.bM2 / (st.bN - 1)), st.floor);
          st.ready = true;
        }
      } else if (!st.conds.baseline.anomaly && Math.abs(obs.value - st.bMean) < 2 * st.bStd) {
        st.bMean += cfg.adaptAlpha * (obs.value - st.bMean);
      }
    }
    st.z = st.ready ? (mShort - st.bMean) / st.bStd : 0;

    const unit = def.unit;
    const fmt = (x: number) => formatValue(x, unit);

    // --- 1. absolute thresholds (never suppressed)
    const lim = def.limits;
    if (lim) {
      const hiEntry = lim.highWarn ?? lim.highAlarm;
      if (hiEntry !== undefined) {
        const isAlarm = lim.highAlarm !== undefined && mInst >= lim.highAlarm;
        const open = mInst >= hiEntry;
        const hold = mInst >= hiEntry - st.floor;
        const limit = isAlarm ? lim.highAlarm! : hiEntry;
        const level = isAlarm || lim.highWarn === undefined ? 'alarm' : 'warning';
        this.evaluate(st.conds.th_high, st, now, open, hold, cfg.persistS.threshold, () => ({
          kind: 'threshold_high',
          direction: 'high',
          severity: level === 'alarm' ? 'critical' : 'warning',
          detector: 'Absolute limit',
          rule: `${fmt(mInst)} ≥ high ${level} limit ${fmt(limit)}, sustained ${cfg.persistS.threshold} s`,
          message: def.type === 'status' ? `${def.name}: TRIPPED state reported` : `${def.name} above high ${level} limit`,
          value: mInst,
          extremity: mInst,
          limit,
        }));
      }
      const loEntry = lim.lowWarn ?? lim.lowAlarm;
      if (loEntry !== undefined) {
        const isAlarm = lim.lowAlarm !== undefined && mInst <= lim.lowAlarm;
        const open = mInst <= loEntry;
        const hold = mInst <= loEntry + st.floor;
        const limit = isAlarm ? lim.lowAlarm! : loEntry;
        const level = isAlarm || lim.lowWarn === undefined ? 'alarm' : 'warning';
        this.evaluate(st.conds.th_low, st, now, open, hold, cfg.persistS.threshold, () => ({
          kind: 'threshold_low',
          direction: 'low',
          severity: level === 'alarm' ? 'critical' : 'warning',
          detector: 'Absolute limit',
          rule: `${fmt(mInst)} ≤ low ${level} limit ${fmt(limit)}, sustained ${cfg.persistS.threshold} s`,
          message: `${def.name} below low ${level} limit`,
          value: mInst,
          extremity: -mInst,
          limit,
        }));
      }
    }

    // --- 2. deviation from learned baseline
    if (def.detect.baseline && st.ready && !suppressed) {
      const z = st.z;
      const az = Math.abs(z);
      this.evaluate(st.conds.baseline, st, now, az >= cfg.zOpen, az >= cfg.zClear, cfg.persistS.baseline, () => ({
        kind: 'baseline_deviation',
        direction: z > 0 ? 'high' : 'low',
        severity: az >= cfg.zWarn ? 'warning' : 'advisory',
        detector: 'Baseline deviation (z-score)',
        rule: `${cfg.shortS} s mean ${fmt(mShort)} is ${az.toFixed(1)}σ ${z > 0 ? 'above' : 'below'} baseline ${fmt(st.bMean)} (σ ${formatValue(st.bStd)}); threshold ${cfg.zOpen}σ for ${cfg.persistS.baseline} s`,
        message: `${def.name} ${z > 0 ? 'above' : 'below'} learned baseline`,
        value: mShort,
        extremity: az,
        zScore: z,
      }));
    }

    // --- 3 & 4. slope and residual scatter over the analysis window
    const span = (now - oldest) / 1000;
    if (n >= 16 && span >= cfg.windowS * 0.6 && !suppressed) {
      const sxxC = sxx - (sx * sx) / n;
      const sxyC = sxy - (sx * sy) / n;
      const syyC = syy - (sy * sy) / n;
      const slope = sxxC > 1e-9 ? sxyC / sxxC : 0;
      if (def.rateLimit !== undefined) {
        const perMin = slope * 60;
        const mag = Math.abs(perMin);
        const limit = def.rateLimit;
        this.evaluate(st.conds.rate, st, now, mag >= limit, mag >= limit * 0.5, cfg.persistS.rate, () => ({
          kind: 'rate_of_change',
          direction: perMin > 0 ? 'rising' : 'falling',
          severity: mag >= limit * 2 ? 'warning' : 'advisory',
          detector: 'Rate of change (least-squares slope)',
          rule: `slope ${perMin > 0 ? '+' : '−'}${mag.toFixed(1)} ${unit}/min over ${cfg.windowS} s exceeds ±${limit} ${unit}/min for ${cfg.persistS.rate} s`,
          message: `${def.name} ${perMin > 0 ? 'rising' : 'falling'} abnormally fast`,
          value: obs.value,
          extremity: mag,
          limit,
          slopePerMin: perMin,
        }));
      }
      if (def.detect.variability && st.ready) {
        const resStd = Math.sqrt(Math.max(0, (syyC - slope * sxyC) / (n - 2)));
        const ratio = resStd / st.bStd;
        const need = cfg.variabilityRatio;
        this.evaluate(st.conds.variability, st, now, ratio >= need, ratio >= need * 0.6, cfg.persistS.variability, () => ({
          kind: 'variability',
          direction: 'unstable',
          severity: ratio >= need * 2 ? 'warning' : 'advisory',
          detector: 'Variability (detrended scatter)',
          rule: `scatter ${formatValue(resStd)} ${unit} over ${cfg.windowS} s is ${ratio.toFixed(1)}× baseline σ ${formatValue(st.bStd)}; threshold ${need}× for ${cfg.persistS.variability} s`,
          message: `${def.name} unstable`,
          value: obs.value,
          extremity: ratio,
        }));
      }
    }

    // --- 5. deviation from controller setpoint
    if (def.setpointSignalId && def.deviation) {
      const sp = this.states.get(def.setpointSignalId)?.mShort;
      const minSp = (def.range[1] - def.range[0]) * 0.05;
      if (sp !== undefined && Number.isFinite(sp) && Math.abs(sp) > minSp) {
        const frac = (mShort - sp) / Math.abs(sp);
        const mag = Math.abs(frac);
        const dev = def.deviation;
        this.evaluate(st.conds.setpoint, st, now, mag >= dev.warn, mag >= dev.warn * 0.6, cfg.persistS.setpoint, () => ({
          kind: 'setpoint_deviation',
          direction: frac < 0 ? 'low' : 'high',
          severity: mag >= dev.alarm ? 'critical' : 'warning',
          detector: 'Setpoint deviation',
          rule: `${fmt(mShort)} is ${(mag * 100).toFixed(1)} % ${frac < 0 ? 'below' : 'above'} demand ${fmt(sp)}; limit ${(dev.warn * 100).toFixed(0)} % for ${cfg.persistS.setpoint} s`,
          message: `${def.name} ${frac < 0 ? 'below' : 'above'} demand`,
          value: mShort,
          extremity: mag,
          limit: sp,
        }));
      }
    }
  }

  /** Evaluate composite rules once all observations of a batch are in. */
  endBatch(now: number): void {
    const cfg = this.config;
    for (const rs of this.ratios) {
      const def = rs.def;
      const enable = this.states.get(def.enableSignalId)?.mShort;
      const num = this.states.get(def.numeratorSignalId);
      const den = this.states.get(def.denominatorSignalId);
      const enabled = enable !== undefined && Math.abs(enable - def.enableValue) < 0.5;
      if (!enabled || !num || !den || !Number.isFinite(num.mShort) || !Number.isFinite(den.mShort)) {
        if (rs.ready || rs.bN > 0) {
          rs.bN = 0;
          rs.ready = false;
          rs.learnStart = null;
        }
        rs.smoothed = null;
        this.clear(rs.cond, now, 'Rule not applicable: equipment not running');
        continue;
      }
      if (now < rs.holdoffUntil || den.mShort < (den.def.range[1] - den.def.range[0]) * 0.05) continue;
      const ratio = num.mShort / den.mShort;
      rs.smoothed = ratio;
      if (!rs.ready) {
        if (rs.learnStart === null) rs.learnStart = now;
        rs.bN += 1;
        rs.bMean += (ratio - rs.bMean) / rs.bN;
        if (now - rs.learnStart >= cfg.warmupS * 1000 && rs.bN >= 20) rs.ready = true;
        continue;
      }
      const pct = (ratio / rs.bMean - 1) * 100;
      this.evaluateCond(
        rs.cond,
        now,
        pct >= def.warnPct,
        pct >= def.warnPct * 0.6,
        cfg.persistS.ratio,
        () => ({
          kind: 'composite',
          direction: 'high',
          severity: pct >= def.alarmPct ? 'critical' : 'warning',
          detector: 'Composite ratio rule',
          rule: `${def.numeratorSignalId} ÷ ${def.denominatorSignalId} = ${ratio.toFixed(3)}, ${pct.toFixed(0)} % above learned ratio ${rs.bMean.toFixed(3)}; limit +${def.warnPct} % for ${cfg.persistS.ratio} s`,
          message: `${def.name} elevated`,
          value: pct,
          extremity: pct,
          limit: def.warnPct,
          ratioPct: pct,
        }),
        {
          assetId: def.assetId,
          signalId: def.numeratorSignalId,
          signalIds: [def.numeratorSignalId, def.denominatorSignalId],
          measurementType: num.def.type,
          unit: '%',
        },
      );
    }
    this.prune();
  }

  // ------------------------------------------------------------- state machine

  private evaluate(cond: Cond, st: SignalState, now: number, open: boolean, hold: boolean, persistS: number, draft: () => Draft): void {
    this.evaluateCond(cond, now, open, hold, persistS, draft, {
      assetId: st.def.assetId,
      signalId: st.def.id,
      signalIds: [st.def.id],
      measurementType: st.def.type,
      unit: st.def.unit,
      baselineMean: st.ready ? st.bMean : undefined,
      baselineStd: st.ready ? st.bStd : undefined,
    });
  }

  private evaluateCond(
    cond: Cond,
    now: number,
    open: boolean,
    hold: boolean,
    persistS: number,
    draft: () => Draft,
    ctx: {
      assetId: string;
      signalId: string;
      signalIds: string[];
      measurementType: Anomaly['measurementType'];
      unit: string;
      baselineMean?: number;
      baselineStd?: number;
    },
  ): void {
    const a = cond.anomaly;
    if (!a) {
      if (!open) {
        cond.since = null;
        return;
      }
      if (cond.since === null) cond.since = now;
      if (now - cond.since < persistS * 1000) return;
      const d = draft();
      this.seq += 1;
      const anomaly: Anomaly = {
        id: `ANM-${String(this.seq).padStart(4, '0')}`,
        kind: d.kind,
        signalId: ctx.signalId,
        signalIds: ctx.signalIds,
        assetId: ctx.assetId,
        measurementType: ctx.measurementType,
        direction: d.direction,
        severity: d.severity,
        status: 'active',
        startedAt: cond.since,
        lastSeenAt: now,
        clearedAt: null,
        detector: d.detector,
        rule: d.rule,
        message: d.message,
        observed: {
          valueAtOpen: d.value,
          value: d.value,
          peak: d.value,
          baselineMean: ctx.baselineMean,
          baselineStd: ctx.baselineStd,
          limit: d.limit,
          zScore: d.zScore,
          slopePerMin: d.slopePerMin,
          ratioPct: d.ratioPct,
        },
        unit: ctx.unit,
      };
      cond.anomaly = anomaly;
      cond.clearSince = null;
      this.anomalies.set(anomaly.id, anomaly);
      this.peaks.set(anomaly.id, d.extremity);
      this.events.push({ type: 'opened', t: now, anomaly });
      return;
    }

    if (hold || open) {
      cond.clearSince = null;
      const d = draft();
      a.lastSeenAt = now;
      a.observed.value = d.value;
      a.direction = d.direction;
      if (d.zScore !== undefined) a.observed.zScore = d.zScore;
      if (d.slopePerMin !== undefined) a.observed.slopePerMin = d.slopePerMin;
      if (d.ratioPct !== undefined) a.observed.ratioPct = d.ratioPct;
      if (d.extremity > (this.peaks.get(a.id) ?? -Infinity)) {
        this.peaks.set(a.id, d.extremity);
        a.observed.peak = d.value;
        a.rule = d.rule;
      }
      if (SEVERITY_RANK[d.severity] > SEVERITY_RANK[a.severity]) {
        a.severity = d.severity;
        a.message = d.message;
        a.rule = d.rule;
        if (d.limit !== undefined) a.observed.limit = d.limit;
        this.events.push({ type: 'escalated', t: now, anomaly: a });
      }
      return;
    }

    if (cond.clearSince === null) cond.clearSince = now;
    if (now - cond.clearSince >= this.config.clearS * 1000) this.clear(cond, now, 'Condition no longer present');
  }

  private clear(cond: Cond, now: number, reason: string): void {
    cond.since = null;
    cond.clearSince = null;
    const a = cond.anomaly;
    if (!a) return;
    a.status = 'cleared';
    a.clearedAt = now;
    a.clearReason = reason;
    cond.anomaly = null;
    this.peaks.delete(a.id);
    this.events.push({ type: 'cleared', t: now, anomaly: a });
  }

  /** Keep memory bounded on long runs: drop the oldest cleared anomalies. */
  private prune(): void {
    if (this.anomalies.size <= 600) return;
    for (const [id, a] of this.anomalies) {
      if (this.anomalies.size <= 400) break;
      if (a.status === 'cleared') this.anomalies.delete(id);
    }
  }
}
