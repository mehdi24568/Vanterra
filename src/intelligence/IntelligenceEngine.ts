/**
 * Intelligence Engine - event correlation, incident lifecycle and structured investigation.
 *
 * Pipeline for every anomaly:
 *   1. Correlate  - is it within a few dependency steps of an open incident (or of
 *                   another unexplained anomaly)? Paths through a shared supply only
 *                   count if that supply is itself implicated.
 *   2. Aggregate  - affected assets, onset order, severity.
 *   3. Rank origin candidates - earliest onset x how many of the other affected
 *                   assets lie on dependency paths from it.
 *   4. Explain    - delegated to a ReasoningProvider (evidence-scored hypotheses).
 *   5. Project    - downstream exposure through the graph.
 *   6. Recommend  - investigation steps drawn from the leading hypotheses.
 *
 * Epistemic rule enforced here: the engine produces observations, detections,
 * correlations and hypotheses. "Confirmed" is a state only an operator can set.
 */
import type {
  Anomaly,
  AnomalyEvent,
  BaselineInfo,
  CorrelationLink,
  Disposition,
  HypothesisAssessment,
  ImpactItem,
  Incident,
  IncidentAsset,
  OriginCandidate,
  PathStep,
  Recommendation,
  RelationType,
  Severity,
  SignalDefinition,
} from '../core/types';
import { MEASUREMENT_LABEL, RELATION_LABEL, SEVERITY_RANK } from '../core/types';
import { formatClock } from '../core/format';
import type { AssetGraph, PathQuery } from '../graph/AssetGraph';
import type { ReasoningContext, ReasoningProvider } from './reasoning';

export interface IntelligenceDeps {
  graph: AssetGraph;
  latest(signalId: string): number | undefined;
  baseline(signalId: string): BaselineInfo | undefined;
  zScore(signalId: string): number;
  signal(signalId: string): SignalDefinition | undefined;
  activeAnomalies(): Anomaly[];
}

export interface IntelligenceConfig {
  /** Maximum dependency steps between two related anomalies. */
  maxHops: number;
  /** A quiet incident still accepts related anomalies for this long. */
  correlationWindowS: number;
  /** Minimum interval between re-assessments of a changed incident. */
  reassessS: number;
  /** Open incidents are refreshed at least this often (values keep moving). */
  refreshS: number;
  /** An incident with no active anomalies is resolved after this long. */
  resolveAfterQuietS: number;
}

export const DEFAULT_INTELLIGENCE: IntelligenceConfig = {
  maxHops: 3,
  correlationWindowS: 240,
  reassessS: 1,
  refreshS: 5,
  resolveAfterQuietS: 45,
};

export type IncidentEventType =
  | 'opened'
  | 'anomaly_added'
  | 'lead_changed'
  | 'severity_raised'
  | 'monitoring'
  | 'reopened'
  | 'resolved'
  | 'merged';

export interface IncidentEvent {
  type: IncidentEventType;
  t: number;
  incident: Incident;
  detail: string;
}

interface IncidentRecord {
  incident: Incident;
  dirty: boolean;
  lastAssessedAt: number;
  quietSince: number | null;
  external: { hypotheses: HypothesisAssessment[]; providerId: string; anomalyCount: number } | null;
}

const PROPAGATION: Record<RelationType, string> = {
  process: 'Flow, pressure and temperature disturbances travel along process connections.',
  mechanical: 'A driven machine and its driver share load: a change in one is felt by the other.',
  electrical: 'Supply quality reaches every consumer, and consumer load is drawn back through the supply.',
  cooling: 'Temperature and flow changes in a cooling circuit reach everything the circuit serves.',
  utility: 'A shared utility affects each consumer it serves.',
};

/** "A → B ← C": arrows always show the true dependency direction. */
export function describePath(path: PathStep[]): string {
  if (path.length === 0) return '';
  let text = path[0].from;
  for (const s of path) text += `${s.direction === 'downstream' ? ' → ' : ' ← '}${s.to}`;
  return text;
}

const maxSeverity = (a: Severity, b: Severity): Severity => (SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b);

/** Which way an anomaly is moving, for comparing two load changes. */
const trendOf = (a: Anomaly): 'up' | 'down' | 'any' =>
  a.direction === 'high' || a.direction === 'rising' ? 'up' : a.direction === 'low' || a.direction === 'falling' ? 'down' : 'any';

const unique = <T>(xs: T[]) => [...new Set(xs)];

/**
 * How much later than a consumer a supply's own fault may be detected and still explain
 * it. Supply voltage is measured directly and is detected within a few seconds of a
 * fault (about 3 s in every MCC-520 evaluation run), so a supply anomaly that appears
 * well after a consumer's is not that consumer's cause.
 */
const SUPPLY_LEAD_MS = 5_000;

export class IntelligenceEngine {
  readonly config: IntelligenceConfig;
  private records: IncidentRecord[] = [];
  private pending = new Map<string, Anomaly>();
  private index = new Map<string, Anomaly>();
  private owner = new Map<string, IncidentRecord>();
  private events: IncidentEvent[] = [];
  private seq = 0;

  constructor(
    private readonly deps: IntelligenceDeps,
    private reasoner: ReasoningProvider,
    config: Partial<IntelligenceConfig> = {},
  ) {
    this.config = { ...DEFAULT_INTELLIGENCE, ...config };
  }

  // ------------------------------------------------------------------ queries

  incidents(): Incident[] {
    return this.records.map((r) => r.incident);
  }

  get(id: string): Incident | undefined {
    return this.records.find((r) => r.incident.id === id)?.incident;
  }

  /** Anomaly lookup that outlives the detection engine's own pruning. */
  anomaly(id: string): Anomaly | undefined {
    return this.index.get(id);
  }

  incidentOfAnomaly(anomalyId: string): Incident | undefined {
    return this.owner.get(anomalyId)?.incident;
  }

  /** Anomalies detected but not (yet) correlated into an incident. */
  uncorrelated(): Anomaly[] {
    return [...this.pending.values()];
  }

  drainEvents(): IncidentEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  get reasonerInfo(): { id: string; label: string } {
    return { id: this.reasoner.id, label: this.reasoner.label };
  }

  // -------------------------------------------------------------- correlation

  onAnomalyEvent(e: AnomalyEvent): void {
    const a = e.anomaly;
    this.index.set(a.id, a);
    const rec = this.owner.get(a.id);
    if (e.type === 'opened') {
      this.place(a, e.t);
    } else if (e.type === 'escalated') {
      if (rec) rec.dirty = true;
      else if (this.pending.has(a.id) && SEVERITY_RANK[a.severity] >= SEVERITY_RANK.warning) {
        this.pending.delete(a.id);
        this.open([a], e.t);
      }
    } else {
      this.pending.delete(a.id);
      if (rec) rec.dirty = true;
    }
  }

  private isLive(rec: IncidentRecord, now: number): boolean {
    if (rec.incident.status === 'resolved') return false;
    if (this.activeCount(rec.incident) > 0) return true;
    return now - rec.incident.lastActivityAt <= this.config.correlationWindowS * 1000;
  }

  /**
   * Assets in an incident whose own output or state is abnormal - as opposed to
   * assets that merely show a change in how much is being drawn through them.
   * Only the former can link their *other* consumers into the same incident:
   * a transformer carrying less load because a fan tripped says nothing about
   * the voltage on its other feeder.
   */
  private implicated(anomalies: Anomaly[]): Set<string> {
    const res = new Set<string>();
    for (const a of anomalies) if (!this.isLoadOnly(a)) res.add(a.assetId);
    return res;
  }

  /**
   * Does this anomaly only say how much is being drawn through the asset?
   * Current and power always do. On electrical distribution equipment so does
   * temperature: a busbar or transformer runs warmer because it carries more load,
   * and only its voltage speaks to the quality of what it supplies.
   */
  private isLoadOnly(a: Anomaly): boolean {
    if (a.kind === 'composite') return false;
    if (a.measurementType === 'current' || a.measurementType === 'power') return true;
    return a.measurementType === 'temperature' && this.deps.graph.asset(a.assetId)?.category === 'electrical';
  }

  /** Path rules for linking `incoming` to a group of anomalies that already belong together. */
  private query(members: Anomaly[], incoming: Anomaly): PathQuery {
    const implicated = this.implicated(members);
    const loadOnly = this.isLoadOnly(incoming);
    const trend = trendOf(incoming);
    // Load reflected one step up a supply: the consumer draws more, so its supplier
    // carries more. That only holds if both are moving the same way - a motor drawing
    // more current is not explained by a board whose current has fallen.
    const reflects = (id: string) =>
      loadOnly &&
      members.some((m) => {
        if (m.assetId !== id || m.status !== 'active' || !this.isLoadOnly(m)) return false;
        const t = trendOf(m);
        return t === 'any' || trend === 'any' || t === trend;
      });
    const firstOnset = new Map<string, number>();
    for (const m of members) firstOnset.set(m.assetId, Math.min(firstOnset.get(m.assetId) ?? Infinity, m.startedAt));
    return {
      maxHops: this.config.maxHops,
      allowSiblingVia: (id) => implicated.has(id),
      // A path never continues *through* a shared consumer: if that consumer were
      // abnormal it would be a member, and the search would have ended at it.
      allowConvergeVia: () => false,
      // Ending at a supplier is only meaningful if that supplier is itself abnormal,
      // or if the new anomaly is load being reflected one step up.
      // A path that leaves an electrical supply downstream treats the supply's own
      // quality (its voltage, not the load it carries) as a possible cause of what lies
      // beyond it. A cause cannot appear long after its effect: a bus that sags well
      // after a motor's load changed did not cause that change.
      acceptTarget: (id, arrival, hops, path) => {
        if (arrival === 'downstream') {
          const fromSupply = path[0]?.relation === 'electrical' && path[0].direction === 'downstream';
          return !(fromSupply && !loadOnly && (firstOnset.get(id) ?? Infinity) < incoming.startedAt - SUPPLY_LEAD_MS);
        }
        return implicated.has(id) || (hops === 1 && reflects(id));
      },
      // Vibration is a local mechanical quantity: it travels through a shaft coupling,
      // not along a pipe, a cable or a cooling circuit. Without this, a pump's vibration
      // could be "explained" by a cooling-water upset three process steps away.
      // A trip is explained by the machine's power supply or a coupled machine, never by
      // the temperature of water in a circuit it happens to sit on.
      allowRelation:
        incoming.measurementType === 'vibration'
          ? (r) => r.type === 'mechanical'
          : incoming.measurementType === 'status'
            ? (r) => r.type === 'mechanical' || r.type === 'electrical'
            : undefined,
      // Pressure, flow and level stay inside one fluid circuit: a heat exchanger passes
      // heat between the process and the cooling water, not hydraulics.
      fluidBound: incoming.measurementType === 'pressure' || incoming.measurementType === 'flow' || incoming.measurementType === 'level',
    };
  }

  /** Could a disturbance at one incident's origin candidate have reached the other's? */
  private originsLinked(a: Incident, b: Incident): boolean {
    const oa = a.origin?.assetId;
    const ob = b.origin?.assetId;
    if (!oa || !ob) return false;
    if (oa === ob) return true;
    return this.deps.graph.propagate(oa).has(ob) || this.deps.graph.propagate(ob).has(oa);
  }

  private place(a: Anomaly, now: number): void {
    const graph = this.deps.graph;
    const hits: Array<{ rec: IncidentRecord; path: PathStep[] }> = [];
    for (const rec of this.records) {
      if (!this.isLive(rec, now)) continue;
      const targets = new Set(rec.incident.assets.map((x) => x.assetId));
      const found = graph.findPath(a.assetId, targets, this.query(this.members(rec.incident), a));
      if (found) hits.push({ rec, path: found.path });
    }
    if (hits.length > 0) {
      hits.sort((x, y) => x.path.length - y.path.length || x.rec.incident.openedAt - y.rec.incident.openedAt);
      const best = hits[0];
      this.attach(best.rec, a, now);
      // Two incidents are one event only if this asset sits *between* them on a
      // dependency chain (upstream of one, downstream of the other). A supply that
      // feeds both, or a consumer fed by both, does not make them the same problem.
      // Even then, one incident's origin must plausibly have propagated to the other's:
      // a loop in the plant (cooling water returning to its tower) puts almost any two
      // assets "in a chain", which is not evidence that they share a cause.
      for (const other of hits.slice(1)) {
        const chained = best.path.length > 0 && other.path.length > 0 && best.path[0].direction !== other.path[0].direction;
        if (chained && this.originsLinked(best.rec.incident, other.rec.incident)) this.merge(best.rec, other.rec, now);
      }
      this.absorbPending(best.rec, now);
      return;
    }

    const related: Anomaly[] = [];
    for (const p of this.pending.values()) {
      if (p.status !== 'active') {
        this.pending.delete(p.id);
        continue;
      }
      const found = graph.findPath(a.assetId, new Set([p.assetId]), this.query([p], a));
      if (found) related.push(p);
    }
    // A lone advisory is recorded but does not make an incident on its own.
    if (related.length > 0 || SEVERITY_RANK[a.severity] >= SEVERITY_RANK.warning) {
      for (const p of related) this.pending.delete(p.id);
      this.open([...related, a], now);
    } else {
      this.pending.set(a.id, a);
    }
  }

  private open(anomalies: Anomaly[], now: number): void {
    const sorted = [...anomalies].sort((x, y) => x.startedAt - y.startedAt);
    const first = sorted[0];
    this.seq += 1;
    const incident: Incident = {
      id: `INC-${String(this.seq).padStart(4, '0')}`,
      seq: this.seq,
      status: 'open',
      severity: first.severity,
      openedAt: now,
      updatedAt: now,
      lastActivityAt: now,
      resolvedAt: null,
      title: '',
      summary: '',
      anomalyIds: [first.id],
      assets: [],
      origin: null,
      originAlternatives: [],
      correlations: [
        {
          anomalyId: first.id,
          assetId: first.assetId,
          linkedAssetId: first.assetId,
          basis: 'initial',
          path: [],
          hops: 0,
          lagS: 0,
          rationale: 'First abnormal condition detected in this incident.',
        },
      ],
      hypotheses: [],
      impact: [],
      recommendations: [],
      revision: 0,
      reasoner: this.reasoner.id,
      assessmentFrozen: null,
      acknowledged: false,
    };
    const rec: IncidentRecord = { incident, dirty: true, lastAssessedAt: 0, quietSince: null, external: null };
    this.records.push(rec);
    this.owner.set(first.id, rec);
    this.refreshAssets(incident);
    for (const a of sorted.slice(1)) this.attach(rec, a, now, true);
    this.absorbPending(rec, now, true);
    this.reassess(rec, now);
    this.events.push({ type: 'opened', t: now, incident, detail: incident.title });
  }

  private attach(rec: IncidentRecord, a: Anomaly, now: number, silent = false): void {
    const inc = rec.incident;
    if (inc.anomalyIds.includes(a.id)) return;
    inc.correlations.push(this.link(inc, a));
    inc.anomalyIds.push(a.id);
    inc.lastActivityAt = now;
    this.owner.set(a.id, rec);
    this.refreshAssets(inc);
    rec.dirty = true;
    if (!silent) {
      this.events.push({
        type: 'anomaly_added',
        t: now,
        incident: inc,
        detail: `${a.signalIds.length > 1 ? a.assetId : a.signalId}: ${a.message}`,
      });
    }
  }

  private absorbPending(rec: IncidentRecord, now: number, silent = false): void {
    let changed = true;
    while (changed) {
      changed = false;
      const targets = new Set(rec.incident.assets.map((x) => x.assetId));
      for (const p of this.pending.values()) {
        if (p.status !== 'active') {
          this.pending.delete(p.id);
          continue;
        }
        const found = this.deps.graph.findPath(p.assetId, targets, this.query(this.members(rec.incident), p));
        if (found) {
          this.pending.delete(p.id);
          this.attach(rec, p, now, silent);
          changed = true;
          break;
        }
      }
    }
  }

  private merge(target: IncidentRecord, source: IncidentRecord, now: number): void {
    if (target === source) return;
    for (const id of source.incident.anomalyIds) {
      const a = this.index.get(id);
      if (a) this.attach(target, a, now, true);
    }
    this.records = this.records.filter((r) => r !== source);
    this.events.push({
      type: 'merged',
      t: now,
      incident: target.incident,
      detail: `${source.incident.id} merged into ${target.incident.id}: a new anomaly links both`,
    });
  }

  /** Why does this anomaly belong to this incident? Recorded once, at the time of linking. */
  private link(inc: Incident, a: Anomaly): CorrelationLink {
    const members = inc.anomalyIds.map((id) => this.index.get(id)).filter((x): x is Anomaly => !!x);
    const firstOnset = Math.min(...members.map((m) => m.startedAt));
    const lagS = Math.round((a.startedAt - firstOnset) / 1000);
    const lagText = lagS >= 0 ? `Onset ${lagS} s after the first abnormal reading in this incident.` : `Onset ${-lagS} s before the incident's first recorded anomaly.`;
    const targets = new Set(inc.assets.map((x) => x.assetId));
    if (targets.has(a.assetId)) {
      return {
        anomalyId: a.id,
        assetId: a.assetId,
        linkedAssetId: a.assetId,
        basis: 'same_asset',
        path: [],
        hops: 0,
        lagS,
        rationale: `Another abnormal signal on ${a.assetId}, which is already part of this incident. ${lagText}`,
      };
    }
    const graph = this.deps.graph;
    const strict = graph.findPath(a.assetId, targets, this.query(members, a));
    const found = strict ?? graph.findPath(a.assetId, targets, { maxHops: 8, allowSiblingVia: () => true });
    if (!found) {
      return {
        anomalyId: a.id,
        assetId: a.assetId,
        linkedAssetId: inc.assets[0]?.assetId ?? a.assetId,
        basis: 'temporal_only',
        path: [],
        hops: 0,
        lagS,
        rationale: `No dependency path found; associated by timing only. ${lagText}`,
      };
    }
    const types = unique(found.path.map((s) => s.relation));
    const media = unique(found.path.map((s) => s.medium)).join(', ');
    const steps = found.path.length;
    return {
      anomalyId: a.id,
      assetId: a.assetId,
      linkedAssetId: found.target,
      basis: 'dependency_path',
      path: found.path,
      hops: steps,
      lagS,
      rationale: `${steps} dependency step${steps === 1 ? '' : 's'} from ${found.target}: ${describePath(found.path)} (${media}). ${types
        .map((t) => PROPAGATION[t])
        .join(' ')} ${lagText}`,
    };
  }

  /**
   * A commanded operating change (setpoint move, duty changeover) was made.
   * For every live incident it touches, take a final assessment on the evidence as
   * it stands and freeze it: what is measured from here on is the plant's response
   * to the intervention, not further evidence about the original cause.
   */
  onOperationalChange(scope: string[] | 'all', t: number, reason: string): void {
    for (const rec of this.records) {
      const inc = rec.incident;
      if (inc.status === 'resolved' || inc.assessmentFrozen) continue;
      const touched = scope === 'all' || inc.assets.some((a) => scope.includes(a.assetId));
      if (!touched) continue;
      this.reassess(rec, t);
      inc.assessmentFrozen = { at: t, reason };
      this.narrate(
        inc,
        this.members(inc),
        this.activeCount(inc),
        inc.impact.filter((i) => i.state === 'at_risk').length,
      );
      inc.revision += 1;
    }
  }

  // ---------------------------------------------------------------- lifecycle

  /** Advance incident state. Call once per ingested batch with the batch's event time. */
  tick(now: number): void {
    const cfg = this.config;
    for (const rec of this.records) {
      const inc = rec.incident;
      if (inc.status === 'resolved') continue;
      const active = this.activeCount(inc);
      if (active === 0) {
        if (rec.quietSince === null) {
          rec.quietSince = now;
          inc.status = 'monitoring';
          rec.dirty = true;
          this.events.push({ type: 'monitoring', t: now, incident: inc, detail: 'All abnormal conditions have cleared; monitoring for recurrence' });
        } else if (now - rec.quietSince >= cfg.resolveAfterQuietS * 1000) {
          inc.status = 'resolved';
          inc.resolvedAt = now;
          this.reassess(rec, now);
          const confirmed = inc.hypotheses.some((h) => h.disposition === 'confirmed');
          this.events.push({
            type: 'resolved',
            t: now,
            incident: inc,
            detail: confirmed ? 'Conditions cleared; cause confirmed by operator' : 'Conditions cleared; cause not confirmed',
          });
          continue;
        }
      } else if (rec.quietSince !== null) {
        rec.quietSince = null;
        inc.status = 'open';
        rec.dirty = true;
        this.events.push({ type: 'reopened', t: now, incident: inc, detail: 'Abnormal conditions have returned' });
      }
      const age = now - rec.lastAssessedAt;
      if ((rec.dirty && age >= cfg.reassessS * 1000) || age >= cfg.refreshS * 1000) this.reassess(rec, now);
    }
  }

  private activeCount(inc: Incident): number {
    let n = 0;
    for (const id of inc.anomalyIds) if (this.index.get(id)?.status === 'active') n += 1;
    return n;
  }

  private members(inc: Incident): Anomaly[] {
    return inc.anomalyIds
      .map((id) => this.index.get(id))
      .filter((x): x is Anomaly => !!x)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  private refreshAssets(inc: Incident): void {
    const map = new Map<string, IncidentAsset>();
    for (const a of this.members(inc)) {
      const cur = map.get(a.assetId);
      if (!cur) {
        map.set(a.assetId, {
          assetId: a.assetId,
          firstOnset: a.startedAt,
          severity: a.severity,
          activeAnomalies: a.status === 'active' ? 1 : 0,
          totalAnomalies: 1,
        });
      } else {
        cur.firstOnset = Math.min(cur.firstOnset, a.startedAt);
        cur.severity = maxSeverity(cur.severity, a.severity);
        cur.totalAnomalies += 1;
        if (a.status === 'active') cur.activeAnomalies += 1;
      }
    }
    inc.assets = [...map.values()].sort((x, y) => x.firstOnset - y.firstOnset);
  }

  // --------------------------------------------------------------- assessment

  private reassess(rec: IncidentRecord, now: number): void {
    const inc = rec.incident;
    const graph = this.deps.graph;
    const members = this.members(inc);
    this.refreshAssets(inc);

    const active = members.filter((a) => a.status === 'active');
    const prevSeverity = inc.severity;
    if (active.length > 0) inc.severity = active.map((a) => a.severity).reduce(maxSeverity);

    // --- origin candidates
    const onsets = inc.assets.map((a) => a.firstOnset);
    const t0 = Math.min(...onsets);
    const span = Math.max(15000, Math.max(...onsets) - t0);
    // An asset that only shows a change in the load drawn through it (a transformer,
    // a switchboard) is carrying a symptom. It is an origin candidate only if nothing
    // in the incident shows an abnormality of its own.
    const implicated = this.implicated(members);
    const eligible = inc.assets.some((ia) => implicated.has(ia.assetId)) ? inc.assets.filter((ia) => implicated.has(ia.assetId)) : inc.assets;
    const candidates: OriginCandidate[] = eligible.map((ia) => {
      const reach = graph.influenceReach(ia.assetId);
      const others = inc.assets.filter((o) => o.assetId !== ia.assetId);
      const covered = others.filter((o) => reach.has(o.assetId)).length;
      const coverage = others.length === 0 ? 1 : covered / others.length;
      const earliness = 1 - Math.min(1, (ia.firstOnset - t0) / span);
      const rationale: string[] = [];
      rationale.push(
        ia.firstOnset === t0
          ? `Earliest abnormal onset in the incident (${formatClock(ia.firstOnset)}).`
          : `Onset ${Math.round((ia.firstOnset - t0) / 1000)} s after the first anomaly.`,
      );
      if (others.length > 0) {
        rationale.push(`${covered} of ${others.length} other affected assets lie on dependency paths leading away from it.`);
      } else {
        rationale.push('Only affected asset so far.');
      }
      return { assetId: ia.assetId, score: 0.5 * earliness + 0.5 * coverage, rationale };
    });
    candidates.sort((a, b) => b.score - a.score);
    inc.origin = candidates[0] ?? null;
    inc.originAlternatives = candidates.slice(1, 3);

    // --- hypotheses (delegated)
    const activeSignals = new Set<string>();
    for (const a of this.deps.activeAnomalies()) for (const s of a.signalIds) activeSignals.add(s);
    const ctx: ReasoningContext = {
      now,
      graph,
      anomalies: members,
      originAssetId: inc.origin?.assetId ?? null,
      latest: this.deps.latest,
      baseline: this.deps.baseline,
      zScore: this.deps.zScore,
      signal: this.deps.signal,
      hasActiveAnomaly: (id) => activeSignals.has(id),
    };
    const prevLead = inc.hypotheses[0];
    const dispositions = new Map(inc.hypotheses.map((h) => [h.key, { d: h.disposition, at: h.dispositionAt }]));
    let hypotheses: HypothesisAssessment[];
    if ((active.length === 0 || inc.assessmentFrozen) && inc.hypotheses.length > 0) {
      // Nothing is abnormal any more, or an operator has intervened: keep the
      // assessment made while the original evidence was live rather than re-scoring
      // against a plant that has been changed or has returned to normal.
      hypotheses = inc.hypotheses;
    } else if (rec.external && rec.external.anomalyCount === members.length) {
      hypotheses = rec.external.hypotheses;
      inc.reasoner = rec.external.providerId;
    } else {
      rec.external = null;
      hypotheses = this.reasoner.assess(ctx);
      inc.reasoner = this.reasoner.id;
    }
    for (const h of hypotheses) {
      const prev = dispositions.get(h.key);
      h.disposition = prev?.d ?? 'unverified';
      h.dispositionAt = prev?.at ?? null;
    }
    inc.hypotheses = hypotheses;

    // --- downstream exposure
    const affected = new Set(inc.assets.map((a) => a.assetId));
    const impact: ImpactItem[] = [];
    const originId = inc.origin?.assetId;
    const reach = originId ? graph.propagate(originId) : new Map();
    for (const ia of inc.assets) {
      if (ia.assetId === originId) continue;
      const r = reach.get(ia.assetId);
      impact.push({
        assetId: ia.assetId,
        hops: r?.hops ?? 0,
        state: 'affected',
        exposure: r?.exposure ?? 0,
        path: r?.path ?? [],
        note: r ? 'Already showing abnormal behaviour' : 'Already showing abnormal behaviour (load reflected upstream of the origin candidate)',
      });
    }
    const atRisk: ImpactItem[] = [];
    for (const [assetId, r] of reach) {
      if (affected.has(assetId)) continue;
      const last = r.path[r.path.length - 1];
      atRisk.push({
        assetId,
        hops: r.hops,
        state: 'at_risk',
        exposure: r.exposure,
        path: r.path,
        note: `Depends on ${last.from} for ${last.medium}; ${r.hops} step${r.hops === 1 ? '' : 's'} downstream of ${originId}. No abnormal behaviour detected yet.`,
      });
    }
    atRisk.sort((a, b) => b.exposure - a.exposure);
    inc.impact = [...impact, ...atRisk];

    // --- recommendations
    inc.recommendations = this.recommend(inc, members, atRisk);

    // --- narrative
    this.narrate(inc, members, active.length, atRisk.length);

    inc.updatedAt = now;
    inc.revision += 1;
    rec.dirty = false;
    rec.lastAssessedAt = now;

    const lead = inc.hypotheses[0];
    if (prevLead && lead && prevLead.key !== lead.key) {
      this.events.push({ type: 'lead_changed', t: now, incident: inc, detail: `Leading hypothesis is now: ${lead.title}` });
    }
    if (SEVERITY_RANK[inc.severity] > SEVERITY_RANK[prevSeverity] && inc.revision > 1) {
      this.events.push({ type: 'severity_raised', t: now, incident: inc, detail: `Severity raised to ${inc.severity}` });
    }
  }

  private recommend(inc: Incident, members: Anomaly[], atRisk: ImpactItem[]): Recommendation[] {
    const done = new Set(inc.recommendations.filter((r) => r.done).map((r) => r.id));
    const recs: Recommendation[] = [];
    const push = (id: string, text: string, basis: string, assetId: string | null) => {
      if (recs.some((r) => r.text === text)) return;
      recs.push({ id, priority: recs.length + 1, text, basis, assetId, done: done.has(id) });
    };
    const ranked = inc.hypotheses.filter((h) => h.disposition !== 'ruled_out');
    const lead = ranked[0];
    const second = ranked[1];
    if (lead) {
      lead.investigation.forEach((text, i) => push(`${lead.key}#${i}`, text, `Follows from the leading hypothesis: ${lead.title}`, lead.focalAssetId));
    }
    if (lead && second && second.support >= 0.25) {
      push(`${second.key}#0`, second.investigation[0], `Separates the leading hypothesis from the alternative: ${second.title}`, second.focalAssetId);
    }
    const firstSignals = unique(members.slice(0, 3).map((a) => a.signalId));
    if (firstSignals.length > 0) {
      push(
        'verify-instruments',
        `Cross-check ${firstSignals.join(', ')} against local instruments before acting on these readings.`,
        'Rules out an instrument or transmitter fault as the explanation',
        members[0]?.assetId ?? null,
      );
    }
    if (atRisk.length > 0 && inc.origin) {
      const ids = atRisk.slice(0, 4).map((i) => i.assetId);
      push(
        'watch-downstream',
        `Watch ${ids.join(', ')} for knock-on effects; ${ids.length === 1 ? 'it depends' : 'they depend'} on ${inc.origin.assetId}.`,
        'Downstream exposure derived from the asset dependency graph',
        ids[0],
      );
    }
    if (!lead) {
      push(
        'no-hypothesis',
        `No failure pattern in the knowledge base matches this evidence. Inspect ${inc.origin?.assetId ?? 'the affected assets'} directly and review the underlying measurements.`,
        'The reasoner will not guess beyond its rules',
        inc.origin?.assetId ?? null,
      );
    }
    return recs;
  }

  private narrate(inc: Incident, members: Anomaly[], activeCount: number, atRiskCount: number): void {
    const graph = this.deps.graph;
    const originId = inc.origin?.assetId ?? inc.assets[0]?.assetId;
    const origin = originId ? graph.asset(originId) : undefined;
    const kinds = unique(members.filter((a) => a.assetId === originId).map((a) => MEASUREMENT_LABEL[a.measurementType])).slice(0, 2);
    inc.title = origin ? `${origin.id} ${origin.name}: abnormal ${kinds.join(' and ') || 'behaviour'}` : 'Abnormal behaviour';

    const first = members[0];
    const nAssets = inc.assets.length;
    const parts: string[] = [];
    parts.push(
      `${activeCount} active abnormal condition${activeCount === 1 ? '' : 's'} (${members.length} detected in total) across ${nAssets} asset${nAssets === 1 ? '' : 's'}; first detected on ${first.assetId} at ${formatClock(first.startedAt)}.`,
    );
    if (nAssets > 1) {
      const types = unique(inc.correlations.flatMap((c) => c.path.map((s) => RELATION_LABEL[s.relation].toLowerCase())));
      if (types.length > 0) parts.push(`The affected assets are linked in the dependency graph by ${types.join(', ')} relationships.`);
    }
    const lead = inc.hypotheses[0];
    if (lead) {
      const confirmed = inc.hypotheses.find((h) => h.disposition === 'confirmed');
      if (confirmed) {
        parts.push(`Cause confirmed by operator: ${confirmed.title}.`);
      } else {
        parts.push(`Leading hypothesis: ${lead.title} - ${lead.band} evidence support (${Math.round(lead.support * 100)} %). This is not a verified diagnosis.`);
        const second = inc.hypotheses[1];
        if (second && lead.support - second.support < 0.15 && second.support >= 0.25) {
          parts.push(`The evidence does not yet separate it from: ${second.title}.`);
        }
      }
    } else {
      parts.push('No known failure pattern matches the available evidence.');
    }
    if (inc.assessmentFrozen) {
      parts.push(
        `Hypotheses reflect the evidence up to ${formatClock(inc.assessmentFrozen.at)}, when a commanded change was made (${inc.assessmentFrozen.reason}); later readings show the plant's response to it.`,
      );
    }
    if (atRiskCount > 0) parts.push(`${atRiskCount} further asset${atRiskCount === 1 ? ' is' : 's are'} exposed downstream if the condition persists.`);
    inc.summary = parts.join(' ');
  }

  // --------------------------------------------------------- operator actions

  setDisposition(incidentId: string, hypothesisKey: string, disposition: Disposition, now: number): boolean {
    const rec = this.records.find((r) => r.incident.id === incidentId);
    const h = rec?.incident.hypotheses.find((x) => x.key === hypothesisKey);
    if (!rec || !h) return false;
    h.disposition = disposition;
    h.dispositionAt = disposition === 'unverified' ? null : now;
    const members = this.members(rec.incident);
    rec.incident.recommendations = this.recommend(rec.incident, members, rec.incident.impact.filter((i) => i.state === 'at_risk'));
    this.narrate(
      rec.incident,
      members,
      members.filter((a) => a.status === 'active').length,
      rec.incident.impact.filter((i) => i.state === 'at_risk').length,
    );
    rec.incident.revision += 1;
    return true;
  }

  toggleRecommendation(incidentId: string, recommendationId: string): boolean {
    const inc = this.get(incidentId);
    const r = inc?.recommendations.find((x) => x.id === recommendationId);
    if (!inc || !r) return false;
    r.done = !r.done;
    inc.revision += 1;
    return true;
  }

  acknowledge(incidentId: string): boolean {
    const inc = this.get(incidentId);
    if (!inc || inc.acknowledged) return false;
    inc.acknowledged = true;
    inc.revision += 1;
    return true;
  }

  /**
   * Entry point for asynchronous reasoning providers (for example an LLM).
   * The result is accepted only if the incident has not changed since `revision`,
   * and a provider can never deliver a confirmed hypothesis.
   */
  applyExternalAssessment(incidentId: string, revision: number, hypotheses: HypothesisAssessment[], providerId: string): boolean {
    const rec = this.records.find((r) => r.incident.id === incidentId);
    if (!rec || rec.incident.revision !== revision) return false;
    const prev = new Map(rec.incident.hypotheses.map((h) => [h.key, h]));
    const sanitised = hypotheses.map((h) => ({
      ...h,
      disposition: prev.get(h.key)?.disposition ?? ('unverified' as Disposition),
      dispositionAt: prev.get(h.key)?.dispositionAt ?? null,
    }));
    rec.external = { hypotheses: sanitised, providerId, anomalyCount: rec.incident.anomalyIds.length };
    rec.incident.hypotheses = sanitised;
    rec.incident.reasoner = providerId;
    rec.incident.revision += 1;
    return true;
  }
}
