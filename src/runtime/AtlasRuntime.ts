/**
 * AtlasRuntime - the browser-side composition root.
 *
 * Owns the headless core, the sonar scanner and the view state; drives the clocked
 * data source from a timer; and publishes compact snapshots to a UI store. It is the
 * single object the Spatial Engine pulls from (SceneFeed) and React components call.
 */
import { hasScenarioControl } from '../adapters/DataSourceAdapter';
import type { DataSourceAdapter, ScenarioControl } from '../adapters/DataSourceAdapter';
import { SimulationAdapter } from '../adapters/SimulationAdapter';
import { ASSET_CATEGORIES, SEVERITY_RANK } from '../core/types';
import type {
  AssetCategory,
  Disposition,
  FacilityModel,
  HealthState,
  Incident,
  OperatingState,
  RelationType,
  ScenarioInfo,
  Severity,
} from '../core/types';
import type { AssetGraph } from '../graph/AssetGraph';
import { SonarEngine } from '../sonar/SonarEngine';
import type { SweepReport } from '../sonar/SonarEngine';
import type { SpatialEngine } from '../spatial/SpatialEngine';
import type { FocusState, LayerState, SceneFeed, ViewState } from '../spatial/types';
import { AiService } from './AiService';
import type { AiAvailability, AiRun } from './AiService';
import { AtlasCore } from './AtlasCore';
import { createStore, shallowEqual } from './store';
import type { OtModel } from '../cyber/types';

/** Worst severity in a list, or 'nominal' when there is none. */
function worstOf(list: (Severity | 'info')[]): HealthState {
  let worst: HealthState = 'nominal';
  for (const s of list) if (s !== 'info' && SEVERITY_RANK[s] > (worst === 'nominal' ? 0 : SEVERITY_RANK[worst])) worst = s;
  return worst;
}
import type { Store } from './store';

export interface Counts {
  assets: number;
  assetsActive: number;
  connected: number;
  signals: number;
  signalsActive: number;
  anomalies: number;
  critical: number;
  warning: number;
  advisory: number;
  incidentsOpen: number;
  uncorrelated: number;
  /** Assets with at least one active anomaly. */
  assetsAbnormal: number;
  /** Worst current asset condition across the plant. */
  plantCondition: HealthState;
  /** Cyber events above informational level, since start. */
  cyberNotable: number;
  cyberCases: number;
  /** Worst cyber event severity in the last 10 minutes of plant time. */
  cyberRecent: HealthState;
}

export interface HealthInfo {
  state: 'nominal' | 'degraded' | 'fault';
  fps: number;
  batchMs: number;
  rejected: number;
  notes: string;
}

export interface ScanInfo {
  status: 'paused' | 'continuous' | 'sweeping' | 'idle';
  continuous: boolean;
  paused: boolean;
  autoPing: boolean;
  intensity: number;
  radius: number;
  intervalS: number;
  sweepCount: number;
  lastSweep: SweepReport | null;
}

export type RightPanel = 'asset' | 'incidents' | 'anomalies' | 'investigation';
export type InvestigationTab = 'overview' | 'evidence' | 'hypotheses' | 'cyber' | 'ai' | 'impact' | 'checks';
/** Top-level product areas. */
export type AppView = 'overview' | 'spatial' | 'cyber';
export type LeftTab = 'scenarios' | 'sonar' | 'layers';

export interface DemoState {
  /** Welcome card visible. */
  welcome: boolean;
  /** Guided walkthrough running. */
  active: boolean;
  step: number;
}

export interface UiState {
  view: AppView;
  /** Selected cyber event, case or OT device in the Cyber & OT view. */
  selectedCyberId: string | null;
  cyberKey: string;
  clock: number;
  running: boolean;
  speed: number;
  /** Measured simulation ticks per real second. */
  tickHz: number;
  seed: number;
  counts: Counts;
  health: HealthInfo;
  scan: ScanInfo;
  selectedAssetId: string | null;
  selectedSignalId: string | null;
  selectedIncidentId: string | null;
  rightPanel: RightPanel;
  investigationTab: InvestigationTab;
  leftTab: LeftTab;
  demo: DemoState;
  ai: AiAvailability;
  /** Changes whenever an AI run starts, progresses or finishes. */
  aiKey: number;
  leftOpen: boolean;
  rightOpen: boolean;
  timelineOpen: boolean;
  /** Change keys: components re-read live engine objects when these change. */
  incidentsKey: string;
  anomaliesKey: string;
  timelineKey: number;
  healthKey: number;
  activeScenarios: string;
  operating: string;
  layers: LayerState;
  error: string | null;
}

export interface RuntimeOptions {
  seed: number;
  prerollS: number;
}

const EMPTY_COUNTS: Counts = {
  assets: 0,
  assetsActive: 0,
  connected: 0,
  signals: 0,
  signalsActive: 0,
  anomalies: 0,
  critical: 0,
  warning: 0,
  advisory: 0,
  incidentsOpen: 0,
  uncorrelated: 0,
  assetsAbnormal: 0,
  plantCondition: 'nominal',
  cyberNotable: 0,
  cyberCases: 0,
  cyberRecent: 'nominal',
};

const DEFAULT_LAYERS = (): LayerState => ({
  categories: Object.fromEntries(ASSET_CATEGORIES.map((c) => [c, true])) as Record<AssetCategory, boolean>,
  relations: false,
  relationTypes: { process: true, mechanical: true, electrical: true, cooling: true, utility: true },
  labels: true,
  sensors: true,
  structures: true,
  ot: false,
});

const LOOP_MS = 50;
const PUBLISH_MS = 250;
const FRESH_MS = 3000;

export class AtlasRuntime implements SceneFeed {
  readonly core: AtlasCore;
  readonly sonar: SonarEngine;
  readonly ai: AiService;
  readonly store: Store<UiState>;
  readonly view: ViewState;
  readonly scenarios: ScenarioInfo[];

  private readonly adapter: DataSourceAdapter;
  private readonly control: ScenarioControl | null;
  private spatial: SpatialEngine | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastLoop = 0;
  private lastPublish = 0;
  private accumulator = 0;
  private ticksInWindow = 0;
  private windowStart = 0;
  private tickHz = 0;
  private running = true;
  private speed = 1;
  private autoPing = true;
  private lastEventPing = new Map<string, number>();
  private signalSeverity = new Map<string, HealthState>();
  private signalSeverityRev = -1;
  private anomalyRev = 0;
  private lastSweepLogged = '';
  private telemetryListeners = new Set<() => void>();
  private positions = new Map<string, { x: number; z: number }>();
  private focusKey = '';
  private insets = { left: 0, right: 0, top: 0, bottom: 0 };

  constructor(private readonly options: RuntimeOptions) {
    this.adapter = new SimulationAdapter(options.seed);
    this.control = hasScenarioControl(this.adapter) ? this.adapter : null;
    this.scenarios = this.control?.scenarios() ?? [];
    this.core = new AtlasCore(this.adapter);
    for (const a of this.core.facility.assets) this.positions.set(a.id, { x: a.position.x, z: a.position.z });
    const origin = this.core.facility.sonarOrigin;
    this.sonar = new SonarEngine(
      this.core.facility.assets.map((a) => ({ id: a.id, x: a.position.x, z: a.position.z })),
      { x: origin.x, z: origin.z },
      (id) => this.core.healthOf(id),
    );
    this.view = { layers: DEFAULT_LAYERS(), selectedAssetId: null, selectedSignalId: null, focus: null };
    this.ai = new AiService(this.core, () => {
      const s = this.store.get();
      this.store.set({ ai: this.ai.availability, aiKey: s.aiKey + 1, timelineKey: this.core.timeline.length > 0 ? this.core.timeline[this.core.timeline.length - 1].id : 0 });
    });
    const narrow = typeof window !== 'undefined' && window.innerWidth < 1100;
    this.store = createStore<UiState>({
      clock: this.core.now,
      running: true,
      speed: 1,
      tickHz: 0,
      seed: options.seed,
      view: 'overview',
      selectedCyberId: null,
      cyberKey: '',
      counts: EMPTY_COUNTS,
      health: { state: 'nominal', fps: 60, batchMs: 0, rejected: 0, notes: 'Starting' },
      scan: this.scanInfo(),
      selectedAssetId: null,
      selectedSignalId: null,
      selectedIncidentId: null,
      rightPanel: 'incidents',
      investigationTab: 'overview',
      leftTab: 'scenarios',
      demo: { welcome: !welcomeDismissed(), active: false, step: 0 },
      ai: this.ai.availability,
      aiKey: 0,
      leftOpen: !narrow,
      rightOpen: !narrow,
      timelineOpen: true,
      incidentsKey: '',
      anomaliesKey: '',
      timelineKey: 0,
      healthKey: 0,
      activeScenarios: '',
      operating: '',
      layers: this.view.layers,
      error: null,
    });

    this.core.onAnomaly((a, type) => {
      this.anomalyRev += 1;
      if (type === 'cleared' || !this.autoPing) return;
      // Event-triggered scan: a fresh detection immediately interrogates its surroundings.
      const now = performance.now();
      if (now - (this.lastEventPing.get(a.assetId) ?? -1e9) < 2500) return;
      this.lastEventPing.set(a.assetId, now);
      const p = this.positions.get(a.assetId);
      if (p) this.sonar.ping('event', p, { radius: 26, intensity: Math.max(1, this.sonar.settings.intensity) });
    });
    this.sonar.onSweep((r) => this.logSweep(r));

    // History before the first frame: baselines are learned and charts are populated.
    this.core.advance(Math.round(options.prerollS / this.core.tickS));
    this.core.log('system', 'info', 'ATLAS online', `Source: ${this.adapter.label}. ${options.prerollS} s of history generated; baselines learned.`);
    this.publish(true);
  }

  // ------------------------------------------------------------ SceneFeed ---

  get facility(): FacilityModel {
    return this.core.facility;
  }

  get graph(): AssetGraph {
    return this.core.graph;
  }

  healthOf(assetId: string): HealthState {
    return this.core.healthOf(assetId);
  }

  operatingState(assetId: string): OperatingState {
    return this.core.operatingState(assetId);
  }

  signalHealth(signalId: string): HealthState {
    if (this.signalSeverityRev !== this.anomalyRev) {
      this.signalSeverityRev = this.anomalyRev;
      this.signalSeverity.clear();
      for (const a of this.core.anomalies.active()) {
        const cur = this.signalSeverity.get(a.signalId) ?? 'nominal';
        if (SEVERITY_RANK[a.severity] > SEVERITY_RANK[cur]) this.signalSeverity.set(a.signalId, a.severity);
      }
    }
    return this.signalSeverity.get(signalId) ?? 'nominal';
  }

  frame(dt: number): void {
    this.sonar.update(dt);
  }

  // ------------------------------------------------------------- lifecycle ---

  start(): void {
    if (this.timer) return;
    this.lastLoop = performance.now();
    this.windowStart = this.lastLoop;
    this.timer = setInterval(this.loop, LOOP_MS);
    void this.ai.refresh();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  attachSpatial(engine: SpatialEngine | null): void {
    this.spatial = engine;
    engine?.setInsets(this.insets);
    engine?.setPaused(this.store.get().view !== 'spatial');
  }

  /** OT model for the scene's OT layer (null without a security source). */
  get otModel(): OtModel | null {
    return this.core.cyber?.model ?? null;
  }

  /** Worst cyber event severity on a device in the last 10 minutes of plant time. */
  otSeverity(deviceId: string): Severity | null {
    const cyber = this.core.cyber;
    if (!cyber) return null;
    const recent = cyber.events.filter((e) => e.severity !== 'info' && e.deviceIds.includes(deviceId) && e.t >= this.core.now - 600_000).map((e) => e.severity);
    const worst = worstOf(recent);
    return worst === 'nominal' ? null : worst;
  }

  /** Area of the viewport covered by panels, so the scene can centre itself in what is left. */
  setInsets(insets: { left: number; right: number; top: number; bottom: number }): void {
    this.insets = insets;
    this.spatial?.setInsets(insets);
  }

  private loop = () => {
    const now = performance.now();
    const dt = Math.min(0.25, (now - this.lastLoop) / 1000);
    this.lastLoop = now;
    try {
      if (this.running) {
        this.accumulator += dt * this.speed;
        const tick = this.core.tickS;
        let budget = 24;
        while (this.accumulator >= tick && budget-- > 0) {
          this.accumulator -= tick;
          this.ticksInWindow += this.core.advance(1);
        }
        if (budget <= 0) this.accumulator = 0;
      }
    } catch (err) {
      this.fail(err);
      return;
    }
    if (now - this.windowStart >= 1000) {
      this.tickHz = (this.ticksInWindow * 1000) / (now - this.windowStart);
      this.ticksInWindow = 0;
      this.windowStart = now;
    }
    if (now - this.lastPublish >= PUBLISH_MS) this.publish();
  };

  private fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[atlas] pipeline error', err);
    this.stop();
    this.store.set({ error: `Pipeline stopped: ${message}`, running: false });
  }

  // --------------------------------------------------------------- publish ---

  onTelemetry(listener: () => void): () => void {
    this.telemetryListeners.add(listener);
    return () => this.telemetryListeners.delete(listener);
  }

  private scanInfo(): ScanInfo {
    const s = this.sonar;
    return {
      status: s.status,
      continuous: s.continuous,
      paused: s.paused,
      autoPing: this.autoPing,
      intensity: s.settings.intensity,
      radius: s.settings.radius,
      intervalS: s.settings.intervalS,
      sweepCount: s.sweepCount,
      lastSweep: s.lastSweep,
    };
  }

  private publish(force = false): void {
    this.lastPublish = performance.now();
    const core = this.core;
    const prev = this.store.get();
    const incidents = core.intelligence.incidents();
    const active = core.anomalies.active();
    const cyberEvents = core.cyber?.events ?? [];

    let assetsActive = 0;
    let connected = 0;
    for (const a of core.facility.assets) {
      if (core.operatingState(a.id) === 'running') assetsActive += 1;
      if (a.signals.some((s) => (core.telemetry.latestTimeOf(s.id) ?? -Infinity) >= core.now - FRESH_MS)) connected += 1;
    }
    const counts: Counts = {
      assets: core.facility.assets.length,
      assetsActive,
      connected,
      signals: core.signals.length,
      signalsActive: core.telemetry.freshSignalCount(FRESH_MS),
      anomalies: active.length,
      critical: active.filter((a) => a.severity === 'critical').length,
      warning: active.filter((a) => a.severity === 'warning').length,
      advisory: active.filter((a) => a.severity === 'advisory').length,
      incidentsOpen: incidents.filter((i) => i.status !== 'resolved').length,
      uncorrelated: core.intelligence.uncorrelated().length,
      assetsAbnormal: new Set(active.map((a) => a.assetId)).size,
      plantCondition: active.some((a) => a.severity === 'critical') ? 'critical' : active.some((a) => a.severity === 'warning') ? 'warning' : active.length > 0 ? 'advisory' : 'nominal',
      cyberNotable: cyberEvents.filter((e) => e.severity !== 'info').length,
      cyberCases: core.cyber?.cases.length ?? 0,
      cyberRecent: worstOf(cyberEvents.filter((e) => e.t >= core.now - 600_000).map((e) => e.severity)),
    };

    const fps = Math.round(this.spatial?.fps ?? 0);
    const batchMs = Math.round(core.stats.avgBatchMs * 100) / 100;
    const rejected = core.telemetry.stats.rejected;
    const stale = counts.signals - counts.signalsActive;
    const problems: string[] = [];
    if (this.spatial && fps < 24) problems.push(`render ${fps} fps`);
    if (batchMs > 12) problems.push(`pipeline ${batchMs} ms/batch`);
    if (rejected > 0) problems.push(`${rejected} readings rejected`);
    if (stale > 0) problems.push(`${stale} stale signals`);
    const health: HealthInfo = {
      state: prev.error ? 'fault' : problems.length > 0 ? 'degraded' : 'nominal',
      fps,
      batchMs,
      rejected,
      notes: problems.length ? problems.join(' · ') : 'All pipelines within budget',
    };
    const scan = this.scanInfo();
    const op = this.adapter instanceof SimulationAdapter ? this.adapter.operatingPoint() : null;

    this.syncFocus();
    this.advanceDemo();

    this.store.set({
      clock: core.now,
      running: this.running,
      speed: this.speed,
      tickHz: Math.round(this.tickHz * 10) / 10,
      counts: !force && shallowEqual(prev.counts, counts) ? prev.counts : counts,
      health: !force && shallowEqual(prev.health, health) ? prev.health : health,
      scan: !force && shallowEqual(prev.scan, scan) ? prev.scan : scan,
      incidentsKey: incidents.map((i) => `${i.id}:${i.revision}`).join('|'),
      cyberKey: `${cyberEvents.length}:${(core.cyber?.cases ?? []).map((k) => k.eventIds.length).join(',')}`,
      anomaliesKey: `${this.anomalyRev}:${active.length}`,
      timelineKey: core.timeline.length > 0 ? core.timeline[core.timeline.length - 1].id : 0,
      healthKey: core.healthRevision,
      activeScenarios: (this.control?.activeScenarios() ?? []).join(','),
      operating: op ? `${Math.round(op.rate * 100)}|${Math.round(op.rateTarget * 100)}|${op.duty}` : '',
    });
    for (const l of this.telemetryListeners) l();
  }

  // ------------------------------------------------------------- selection ---

  selectAsset(assetId: string | null, signalId: string | null = null, options: { fly?: boolean; panel?: boolean } = {}): void {
    this.view.selectedAssetId = assetId;
    this.view.selectedSignalId = assetId ? signalId : null;
    const patch: Partial<UiState> = { selectedAssetId: assetId, selectedSignalId: this.view.selectedSignalId };
    const state = this.store.get();
    if (assetId && options.panel !== false && state.rightPanel !== 'investigation') {
      patch.rightPanel = 'asset';
      patch.rightOpen = true;
    }
    this.store.set(patch);
    if (assetId && options.fly) this.spatial?.focusAsset(assetId);
  }

  /** Open (or close, with null) an incident investigation and focus the scene on it. */
  selectIncident(incidentId: string | null, options: { fly?: boolean } = {}): void {
    const incident = incidentId ? this.core.intelligence.get(incidentId) : undefined;
    if (!incident) {
      this.view.focus = null;
      this.focusKey = '';
      const state = this.store.get();
      this.store.set({ selectedIncidentId: null, rightPanel: state.rightPanel === 'investigation' ? 'incidents' : state.rightPanel });
      return;
    }
    const state = this.store.get();
    // On screens where both rails would squeeze the scene, the investigation takes the controls' place.
    const tight = typeof window !== 'undefined' && window.innerWidth < 1600 && window.innerWidth >= 1100;
    this.store.set({
      selectedIncidentId: incident.id,
      rightPanel: 'investigation',
      rightOpen: true,
      investigationTab: state.selectedIncidentId === incident.id ? state.investigationTab : 'overview',
      leftOpen: tight ? false : state.leftOpen,
    });
    this.syncFocus(true);
    if (options.fly !== false) this.spatial?.focusAssets(incident.assets.map((a) => a.assetId));
  }

  /** Keep the scene's incident focus in step with the incident as it evolves. */
  private syncFocus(force = false): void {
    const id = this.store.get().selectedIncidentId;
    const incident = id ? this.core.intelligence.get(id) : undefined;
    if (!incident) {
      if (this.view.focus) this.view.focus = null;
      return;
    }
    const key = `${incident.id}:${incident.revision}`;
    if (!force && key === this.focusKey) return;
    this.focusKey = key;
    this.view.focus = buildFocus(incident);
  }

  setRightPanel(panel: RightPanel): void {
    if (panel !== 'investigation' && this.store.get().selectedIncidentId) {
      // Leaving the investigation keeps the incident selected (so it is one click back)
      // but releases the scene focus so the whole facility is readable again.
      this.view.focus = null;
      this.focusKey = '';
    } else if (panel === 'investigation') {
      this.syncFocus(true);
    }
    this.store.set({ rightPanel: panel, rightOpen: true });
  }

  togglePanel(which: 'leftOpen' | 'rightOpen' | 'timelineOpen'): void {
    this.store.set({ [which]: !this.store.get()[which] } as Partial<UiState>);
  }

  focusAsset(assetId: string): void {
    this.spatial?.focusAsset(assetId);
  }

  resetView(): void {
    this.spatial?.resetView();
  }

  // ----------------------------------------------------------------- sonar ---

  ping(at?: { x: number; z: number }): void {
    const pulse = this.sonar.ping('manual', at);
    if (!pulse) return;
    this.publish();
  }

  pingFromSelection(): void {
    const id = this.view.selectedAssetId;
    const p = id ? this.positions.get(id) : undefined;
    this.ping(p);
  }

  setSonar(patch: Partial<{ continuous: boolean; paused: boolean; intensity: number; radius: number; intervalS: number; autoPing: boolean }>): void {
    if (patch.continuous !== undefined) this.sonar.continuous = patch.continuous;
    if (patch.paused !== undefined) this.sonar.paused = patch.paused;
    if (patch.intensity !== undefined) this.sonar.settings.intensity = patch.intensity;
    if (patch.radius !== undefined) this.sonar.settings.radius = patch.radius;
    if (patch.intervalS !== undefined) this.sonar.settings.intervalS = patch.intervalS;
    if (patch.autoPing !== undefined) this.autoPing = patch.autoPing;
    this.store.set({ scan: this.scanInfo() });
  }

  private logSweep(r: SweepReport): void {
    if (r.kind === 'event') return;
    const abnormal = r.abnormal.advisory + r.abnormal.warning + r.abnormal.critical;
    // Manual sweeps are always logged; continuous sweeps only when their findings change.
    const signature = `${r.abnormal.advisory}/${r.abnormal.warning}/${r.abnormal.critical}/${r.missed}`;
    if (r.kind === 'continuous' && signature === this.lastSweepLogged) return;
    this.lastSweepLogged = signature;
    const severity: Severity | 'info' = r.abnormal.critical ? 'critical' : r.abnormal.warning ? 'warning' : r.abnormal.advisory ? 'advisory' : 'info';
    const missed = r.missed > 0 ? `; ${r.missed} advisory-level asset${r.missed === 1 ? '' : 's'} below echo sensitivity at intensity ${r.intensity.toFixed(1)}` : '';
    this.core.log(
      'scan',
      severity,
      `${r.kind === 'manual' ? 'Manual' : 'Continuous'} sweep: ${r.contacts} contacts, ${abnormal} abnormal return${abnormal === 1 ? '' : 's'}`,
      `Radius ${Math.round(r.radius)} m, intensity ${r.intensity.toFixed(1)}. Critical ${r.abnormal.critical}, warning ${r.abnormal.warning}, advisory ${r.abnormal.advisory}${missed}.`,
    );
  }

  // ------------------------------------------------------------ simulation ---

  setRunning(running: boolean): void {
    this.running = running;
    this.core.log('operator', 'info', running ? 'Simulation resumed' : 'Simulation paused', '');
    this.publish();
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.store.set({ speed });
  }

  trigger(scenarioId: string): boolean {
    const ok = this.control?.trigger(scenarioId) ?? false;
    if (ok) this.publish();
    return ok;
  }

  /** Restart everything from the seed: history, baselines, incidents, scan state. */
  reset(seed = this.options.seed): void {
    this.options.seed = seed;
    this.core.reset(seed);
    this.sonar.reset();
    this.ai.reset();
    this.accumulator = 0;
    this.anomalyRev += 1;
    this.lastEventPing.clear();
    this.lastSweepLogged = '';
    this.view.selectedAssetId = null;
    this.view.selectedSignalId = null;
    this.view.focus = null;
    this.focusKey = '';
    this.core.advance(Math.round(this.options.prerollS / this.core.tickS));
    this.core.log('system', 'info', 'Simulation reset', `Seed ${seed}. History, baselines and incidents cleared.`);
    const state = this.store.get();
    this.store.set({
      seed,
      selectedAssetId: null,
      selectedSignalId: null,
      selectedIncidentId: null,
      rightPanel: state.rightPanel === 'investigation' ? 'incidents' : state.rightPanel,
      error: null,
    });
    if (!this.timer) this.start();
    this.publish(true);
  }

  // ---------------------------------------------------------------- layers ---

  private commitLayers(next: LayerState): void {
    this.view.layers = next;
    this.store.set({ layers: next });
  }

  toggleCategory(category: AssetCategory): void {
    const l = this.view.layers;
    this.commitLayers({ ...l, categories: { ...l.categories, [category]: !l.categories[category] } });
  }

  setAllCategories(on: boolean): void {
    const l = this.view.layers;
    this.commitLayers({ ...l, categories: Object.fromEntries(ASSET_CATEGORIES.map((c) => [c, on])) as Record<AssetCategory, boolean> });
  }

  toggleRelationType(type: RelationType): void {
    const l = this.view.layers;
    this.commitLayers({ ...l, relationTypes: { ...l.relationTypes, [type]: !l.relationTypes[type] } });
  }

  setLayer(key: 'relations' | 'labels' | 'sensors' | 'structures' | 'ot', on: boolean): void {
    this.commitLayers({ ...this.view.layers, [key]: on });
  }

  // -------------------------------------------------------------- operator ---

  setDisposition(incidentId: string, hypothesisKey: string, disposition: Disposition): void {
    const inc = this.core.intelligence.get(incidentId);
    const h = inc?.hypotheses.find((x) => x.key === hypothesisKey);
    if (!inc || !h) return;
    if (this.core.intelligence.setDisposition(incidentId, hypothesisKey, disposition, this.core.now)) {
      const verb = disposition === 'confirmed' ? 'confirmed by operator' : disposition === 'ruled_out' ? 'ruled out by operator' : 'returned to unverified';
      this.core.log('operator', 'info', `${incidentId}: hypothesis ${verb}`, h.title, { incidentId, assetId: h.focalAssetId });
      this.publish();
    }
  }

  toggleRecommendation(incidentId: string, recommendationId: string): void {
    if (this.core.intelligence.toggleRecommendation(incidentId, recommendationId)) this.publish();
  }

  acknowledge(incidentId: string): void {
    if (this.core.intelligence.acknowledge(incidentId)) {
      this.core.log('operator', 'info', `${incidentId} acknowledged`, '', { incidentId });
      this.publish();
    }
  }

  reportError(message: string): void {
    this.store.set({ error: message });
  }

  // ------------------------------------------------------- AI investigation ---

  aiRun(incidentId: string): AiRun | undefined {
    return this.ai.run(incidentId);
  }

  aiStale(incidentId: string): boolean {
    return this.ai.stale(incidentId);
  }

  /** Operator-initiated only: nothing starts an AI run automatically. */
  runAiInvestigation(incidentId: string): void {
    void this.ai.investigate(incidentId);
  }

  cancelAiInvestigation(incidentId: string): void {
    this.ai.cancel(incidentId);
  }

  /** Ask the server again whether AI is configured (for example after a restart with a key). */
  recheckAi(): void {
    void this.ai.refresh();
  }

  /** Download the full audit trail of an AI run: every input, raw output and validation result. */
  exportAudit(incidentId: string): void {
    const run = this.ai.run(incidentId);
    if (!run?.report || typeof document === 'undefined') return;
    const blob = new Blob([JSON.stringify({ context: run.context, report: run.report }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${incidentId}-${run.report.runId}-audit.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  setInvestigationTab(tab: InvestigationTab): void {
    this.store.set({ investigationTab: tab });
  }

  // ------------------------------------------------------------- navigation ---

  setView(view: AppView): void {
    this.store.set({ view });
    // The scene is not drawn while a full-page view covers it.
    this.spatial?.setPaused(view !== 'spatial');
  }

  /** Open an incident in the spatial workbench, optionally on a given tab. */
  openIncident(incidentId: string, tab?: InvestigationTab): void {
    this.setView('spatial');
    this.selectIncident(incidentId, { fly: true });
    if (tab) this.setInvestigationTab(tab);
    // The cyber-physical tab is about the controller path: show it in the scene.
    if (tab === 'cyber' && !this.view.layers.ot) this.setLayer('ot', true);
  }

  /** Select a cyber event, case or OT device in the Cyber & OT view. */
  selectCyber(id: string | null): void {
    this.store.set({ selectedCyberId: id, view: 'cyber' });
    this.spatial?.setPaused(true);
  }

  /** Show a physical asset in the spatial view, with the OT layer on if asked. */
  showInSpace(assetId: string, withOt = false): void {
    this.setView('spatial');
    if (withOt && !this.view.layers.ot) this.setLayer('ot', true);
    this.selectAsset(assetId, null, { fly: true });
  }

  /** Start a demonstration scenario from a clean, repeatable state. */
  runScenario(scenarioId: string, speed = 4): void {
    const dirty = this.core.intelligence.incidents().length > 0 || (this.control?.activeScenarios().length ?? 0) > 0 || (this.core.cyber?.events.length ?? 0) > 0 || this.core.anomalies.active().length > 0;
    if (dirty) this.reset();
    this.running = true;
    this.setSpeed(speed);
    this.trigger(scenarioId);
    this.store.set({ selectedCyberId: null });
  }

  setLeftTab(tab: LeftTab): void {
    this.store.set({ leftTab: tab, leftOpen: true });
  }

  // ------------------------------------------------------------ guided demo ---

  dismissWelcome(): void {
    rememberWelcomeDismissed();
    this.store.set({ demo: { ...this.store.get().demo, welcome: false } });
  }

  showWelcome(): void {
    this.store.set({ demo: { ...this.store.get().demo, welcome: true } });
  }

  /** Start the guided walkthrough from a clean plant, looking at the pump that will fail. */
  startDemo(): void {
    rememberWelcomeDismissed();
    const dirty = this.core.intelligence.incidents().length > 0 || (this.control?.activeScenarios().length ?? 0) > 0 || this.core.anomalies.active().length > 0;
    if (dirty) this.reset();
    this.running = true;
    this.setSpeed(1);
    this.store.set({ demo: { welcome: false, active: true, step: 0 }, leftTab: 'scenarios' });
    this.selectAsset('P-101', 'P-101.VIB', { fly: true });
  }

  endDemo(): void {
    this.store.set({ demo: { welcome: false, active: false, step: 0 } });
  }

  demoGo(step: number): void {
    const demo = this.store.get().demo;
    if (!demo.active) return;
    const incident = this.core.intelligence.incidents()[0];
    if (step >= 2 && !incident) return;
    if (step === 1 && demo.step === 0) {
      this.trigger('pump-bearing');
      this.setSpeed(4);
    }
    if (step >= 2 && incident) {
      if (this.store.get().selectedIncidentId !== incident.id || this.store.get().rightPanel !== 'investigation') this.selectIncident(incident.id);
      const tabs: Record<number, InvestigationTab> = { 2: 'overview', 3: 'hypotheses', 4: 'evidence', 5: 'ai', 6: 'checks', 7: 'hypotheses' };
      this.setInvestigationTab(tabs[step] ?? 'overview');
    }
    this.store.set({ demo: { ...demo, step } });
  }

  /** The walkthrough advances itself only where it is waiting for the plant. */
  private advanceDemo(): void {
    const demo = this.store.get().demo;
    if (!demo.active || demo.step !== 1) return;
    if (this.core.intelligence.incidents().length > 0) {
      this.setSpeed(1);
      this.demoGo(2);
    }
  }
}

const WELCOME_KEY = 'atlas.welcome.dismissed.v2';

function welcomeDismissed(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(WELCOME_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberWelcomeDismissed(): void {
  try {
    localStorage.setItem(WELCOME_KEY, '1');
  } catch {
    /* private mode or storage disabled: the card simply shows again next time */
  }
}

function buildFocus(incident: Incident): FocusState {
  const assets = new Map<string, Severity>();
  // Assets whose anomalies have all cleared stay in focus, at the lowest emphasis.
  for (const a of incident.assets) assets.set(a.assetId, a.activeAnomalies > 0 ? a.severity : 'advisory');
  const atRisk = new Set(incident.impact.filter((i) => i.state === 'at_risk').map((i) => i.assetId));
  const relationIds = new Set<string>();
  for (const c of incident.correlations) for (const s of c.path) relationIds.add(s.relationId);
  for (const i of incident.impact) for (const s of i.path) relationIds.add(s.relationId);
  return { incidentId: incident.id, severity: incident.severity, assets, atRisk, relationIds };
}
