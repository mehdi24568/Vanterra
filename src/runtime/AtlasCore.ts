/**
 * AtlasCore - the headless intelligence pipeline.
 *
 *   DataSourceAdapter -> Telemetry -> Anomaly Detection -> Intelligence -> timeline
 *
 * No DOM, no rendering, no timers: it advances only when a batch is ingested, so the
 * exact same code runs in the browser, in unit tests and (later) in a server process.
 */
import { hasScenarioControl, hasSecuritySource, isClocked } from '../adapters/DataSourceAdapter';
import type { DataSourceAdapter, IngestSink } from '../adapters/DataSourceAdapter';
import { AnomalyEngine } from '../anomaly/AnomalyEngine';
import type { DetectionConfig } from '../anomaly/AnomalyEngine';
import type {
  Anomaly,
  FacilityModel,
  HealthState,
  OperatingState,
  RawReading,
  Severity,
  SignalDefinition,
  SourceEvent,
  TimelineEvent,
  TimelineKind,
} from '../core/types';
import { SEVERITY_RANK } from '../core/types';
import { AssetGraph } from '../graph/AssetGraph';
import { IntelligenceEngine } from '../intelligence/IntelligenceEngine';
import type { IntelligenceConfig } from '../intelligence/IntelligenceEngine';
import { RuleBasedReasoner } from '../intelligence/hypotheses';
import type { ReasoningProvider } from '../intelligence/reasoning';
import { TelemetryEngine } from '../telemetry/TelemetryEngine';
import { assessCase, assessCyberPhysical } from '../cyber/assess';
import type { CaseAssessment, CyberPhysicalAssessment } from '../cyber/assess';
import { CyberEngine } from '../cyber/CyberEngine';
import type { SecurityRecord } from '../cyber/types';

export interface CoreOptions {
  detection?: Partial<DetectionConfig>;
  intelligence?: Partial<IntelligenceConfig>;
  reasoner?: ReasoningProvider;
  historyCapacity?: number;
}

export interface CoreStats {
  batches: number;
  observations: number;
  /** Wall-clock milliseconds spent processing the most recent batch. */
  lastBatchMs: number;
  /** Exponentially-smoothed batch processing time. */
  avgBatchMs: number;
}

type Refs = Partial<Pick<TimelineEvent, 'assetId' | 'anomalyId' | 'incidentId' | 'signalId' | 'cyberId'>>;

const TIMELINE_CAP = 500;

export class AtlasCore implements IngestSink {
  readonly facility: FacilityModel;
  readonly graph: AssetGraph;
  readonly signals: SignalDefinition[];
  telemetry!: TelemetryEngine;
  anomalies!: AnomalyEngine;
  intelligence!: IntelligenceEngine;
  /** OT security detection; null when the source provides no security telemetry. */
  cyber: CyberEngine | null = null;
  timeline: TimelineEvent[] = [];
  stats: CoreStats = { batches: 0, observations: 0, lastBatchMs: 0, avgBatchMs: 0 };
  /** Event time of the most recent batch. */
  now = 0;

  private eventSeq = 0;
  private health = new Map<string, HealthState>();
  private batchListeners = new Set<() => void>();
  private anomalyListeners = new Set<(a: Anomaly, type: 'opened' | 'escalated' | 'cleared') => void>();
  private healthVersion = 0;

  constructor(
    readonly adapter: DataSourceAdapter,
    private readonly options: CoreOptions = {},
  ) {
    this.facility = adapter.describe();
    this.graph = new AssetGraph(this.facility.assets, this.facility.relations);
    this.signals = this.facility.assets.flatMap((a) => a.signals);
    this.build();
    adapter.connect(this);
    this.now = isClocked(adapter) ? adapter.nowMs() : 0;
  }

  private build(): void {
    this.telemetry = new TelemetryEngine(this.signals, this.options.historyCapacity ?? 2400);
    this.anomalies = new AnomalyEngine(this.signals, this.facility.ratioRules, this.options.detection);
    this.intelligence = new IntelligenceEngine(
      {
        graph: this.graph,
        latest: (id) => this.telemetry.latest(id),
        baseline: (id) => this.anomalies.baseline(id),
        zScore: (id) => this.anomalies.zScore(id),
        signal: (id) => this.telemetry.signal(id),
        activeAnomalies: () => this.anomalies.active(),
      },
      this.options.reasoner ?? new RuleBasedReasoner(),
      this.options.intelligence,
    );
    this.cyber = hasSecuritySource(this.adapter) ? new CyberEngine(this.adapter.describeOt()) : null;
    this.timeline = [];
    this.health.clear();
    this.healthVersion += 1;
    this.stats = { batches: 0, observations: 0, lastBatchMs: 0, avgBatchMs: 0 };
  }

  // ------------------------------------------------------------------ ingest

  ingest(readings: RawReading[], sourceId: string): void {
    const started = performance.now();
    const observations = this.telemetry.ingest(readings, sourceId);
    if (observations.length === 0) return;
    const now = this.telemetry.now;
    this.now = now;
    for (const obs of observations) this.anomalies.process(obs);
    this.anomalies.endBatch(now);

    const anomalyEvents = this.anomalies.drainEvents();
    for (const e of anomalyEvents) {
      this.intelligence.onAnomalyEvent(e);
      const a = e.anomaly;
      const refs: Refs = {
        assetId: a.assetId,
        anomalyId: a.id,
        signalId: a.signalId,
        incidentId: this.intelligence.incidentOfAnomaly(a.id)?.id ?? null,
      };
      if (e.type === 'opened') this.log('anomaly', a.severity, a.message, a.rule, refs, e.t);
      else if (e.type === 'escalated') this.log('anomaly', a.severity, `Escalated to ${a.severity}: ${a.message}`, a.rule, refs, e.t);
      else this.log('anomaly', 'info', `Cleared: ${a.message}`, a.clearReason ?? '', refs, e.t);
      for (const l of this.anomalyListeners) l(a, e.type);
    }
    this.intelligence.tick(now);
    for (const e of this.intelligence.drainEvents()) {
      // Each linked anomaly is already on the timeline in its own right.
      if (e.type === 'anomaly_added') continue;
      const inc = e.incident;
      const refs: Refs = { incidentId: inc.id, assetId: inc.origin?.assetId ?? inc.assets[0]?.assetId ?? null };
      const severity: Severity | 'info' = e.type === 'resolved' || e.type === 'monitoring' ? 'info' : inc.severity;
      const title =
        e.type === 'opened'
          ? `${inc.id} opened`
          : e.type === 'resolved'
            ? `${inc.id} resolved`
            : e.type === 'monitoring'
              ? `${inc.id} monitoring`
              : e.type === 'lead_changed'
                ? `${inc.id}: leading hypothesis changed`
                : e.type === 'severity_raised'
                  ? `${inc.id}: severity raised`
                  : e.type === 'reopened'
                    ? `${inc.id} reopened`
                    : `${inc.id}: incidents merged`;
      this.log('incident', severity, title, e.detail, refs, e.t);
    }
    if (anomalyEvents.length > 0) this.recomputeHealth();

    const elapsed = performance.now() - started;
    this.stats.batches += 1;
    this.stats.observations += observations.length;
    this.stats.lastBatchMs = elapsed;
    this.stats.avgBatchMs = this.stats.avgBatchMs === 0 ? elapsed : this.stats.avgBatchMs * 0.95 + elapsed * 0.05;
    for (const l of this.batchListeners) l();
  }

  ingestSecurity(records: SecurityRecord[]): void {
    if (!this.cyber) return;
    this.cyber.ingest(records);
    for (const n of this.cyber.drain()) {
      if (n.type === 'event') {
        const e = n.event;
        this.log('cyber', e.severity, e.title, e.description, { cyberId: e.id }, e.t);
      } else if (n.type === 'case_opened') {
        this.log('cyber', n.case.severity, `${n.case.id} opened`, n.case.title, { cyberId: n.case.id }, n.case.openedAt);
      }
    }
  }

  /** Deterministic cyber-physical assessment of one incident (null without a security source). */
  assessIncident(incidentId: string): CyberPhysicalAssessment | null {
    const inc = this.intelligence.get(incidentId);
    if (!inc || !this.cyber) return null;
    const anomalies = inc.anomalyIds.map((id) => this.intelligence.anomaly(id)).filter((a): a is Anomaly => !!a);
    return assessCyberPhysical(inc, anomalies, this.cyber, this.now);
  }

  assessCyberCase(caseId: string): CaseAssessment | null {
    const c = this.cyber?.caseOf(caseId);
    if (!c || !this.cyber) return null;
    const events = c.eventIds.map((id) => this.cyber!.event(id)).filter((e): e is NonNullable<typeof e> => !!e);
    return assessCase(c, events, this.intelligence.incidents(), this.cyber);
  }

  sourceEvent(e: SourceEvent): void {
    if (e.rebaseline) {
      // Order matters: take the incident's final assessment before detection is reset.
      this.intelligence.onOperationalChange(e.rebaseline.assetIds, e.t, e.title);
      this.anomalies.rebaseline(e.rebaseline.assetIds, e.rebaseline.holdS, e.t);
      for (const ev of this.anomalies.drainEvents()) this.intelligence.onAnomalyEvent(ev);
      this.recomputeHealth();
    }
    const kind: TimelineKind = e.kind === 'simulation_control' ? 'simulation' : 'operation';
    this.log(kind, 'info', e.title, e.detail, { assetId: e.assetIds[0] ?? null }, e.t);
  }

  /** Drive a clocked source forward by `ticks` batches. Returns how many were produced. */
  advance(ticks = 1): number {
    if (!isClocked(this.adapter)) return 0;
    let n = 0;
    for (let i = 0; i < ticks; i++) {
      if (!this.adapter.advance()) break;
      n += 1;
    }
    return n;
  }

  /** Tick period of a clocked source in seconds (0 for push sources). */
  get tickS(): number {
    return isClocked(this.adapter) ? this.adapter.tickS : 0;
  }

  /** Discard all state and restart the source (simulators only). */
  reset(seed?: number): void {
    if (hasScenarioControl(this.adapter)) this.adapter.reset(seed);
    this.build();
    this.now = isClocked(this.adapter) ? this.adapter.nowMs() : 0;
    for (const l of this.batchListeners) l();
  }

  // ----------------------------------------------------------------- queries

  onBatch(listener: () => void): () => void {
    this.batchListeners.add(listener);
    return () => this.batchListeners.delete(listener);
  }

  onAnomaly(listener: (a: Anomaly, type: 'opened' | 'escalated' | 'cleared') => void): () => void {
    this.anomalyListeners.add(listener);
    return () => this.anomalyListeners.delete(listener);
  }

  healthOf(assetId: string): HealthState {
    return this.health.get(assetId) ?? 'nominal';
  }

  /** Changes whenever any asset's health changes - cheap dirty check for views. */
  get healthRevision(): number {
    return this.healthVersion;
  }

  operatingState(assetId: string): OperatingState {
    const status = this.telemetry.latest(`${assetId}.STATUS`);
    if (status === undefined) return 'running';
    if (status >= 1.5) return 'tripped';
    return status >= 0.5 ? 'running' : 'standby';
  }

  activeAnomaliesFor(assetId: string): Anomaly[] {
    return this.anomalies.active().filter((a) => a.assetId === assetId);
  }

  private recomputeHealth(): void {
    const next = new Map<string, HealthState>();
    for (const a of this.anomalies.active()) {
      const cur = next.get(a.assetId) ?? 'nominal';
      if (SEVERITY_RANK[a.severity] > SEVERITY_RANK[cur]) next.set(a.assetId, a.severity);
    }
    let changed = next.size !== this.health.size;
    if (!changed) for (const [k, v] of next) if (this.health.get(k) !== v) changed = true;
    if (changed) {
      this.health = next;
      this.healthVersion += 1;
    }
  }

  // ---------------------------------------------------------------- timeline

  log(kind: TimelineKind, severity: Severity | 'info', title: string, detail = '', refs: Refs = {}, t = this.now): TimelineEvent {
    this.eventSeq += 1;
    const event: TimelineEvent = {
      id: this.eventSeq,
      t,
      kind,
      severity,
      title,
      detail,
      assetId: refs.assetId ?? null,
      anomalyId: refs.anomalyId ?? null,
      incidentId: refs.incidentId ?? null,
      signalId: refs.signalId ?? null,
      cyberId: refs.cyberId ?? null,
    };
    this.timeline.push(event);
    if (this.timeline.length > TIMELINE_CAP) this.timeline.splice(0, this.timeline.length - TIMELINE_CAP);
    return event;
  }
}
