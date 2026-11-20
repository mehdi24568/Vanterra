/**
 * ATLAS domain model.
 *
 * These types are the contract between every engine. Nothing in here knows about
 * the simulation, about Three.js or about React - which is what lets a real data
 * source replace the simulator without touching detection, reasoning or rendering.
 */

// ---------------------------------------------------------------- geometry ---

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface AreaDefinition {
  id: string;
  name: string;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

// ------------------------------------------------------------------ assets ---

export type AssetCategory =
  | 'pump'
  | 'motor'
  | 'tank'
  | 'pipeline'
  | 'heat_exchanger'
  | 'reactor'
  | 'production'
  | 'conveyor'
  | 'cooling'
  | 'electrical'
  | 'utility';

export const ASSET_CATEGORIES: AssetCategory[] = [
  'pump',
  'motor',
  'tank',
  'pipeline',
  'heat_exchanger',
  'reactor',
  'production',
  'conveyor',
  'cooling',
  'electrical',
  'utility',
];

export const CATEGORY_LABEL: Record<AssetCategory, string> = {
  pump: 'Pumps',
  motor: 'Electric motors',
  tank: 'Storage tanks',
  pipeline: 'Pipelines',
  heat_exchanger: 'Heat exchangers',
  reactor: 'Reactors',
  production: 'Production equipment',
  conveyor: 'Conveyors',
  cooling: 'Cooling systems',
  electrical: 'Electrical infrastructure',
  utility: 'Utilities & maintenance',
};

/** Operating state as reported by the data source (not a health judgement). */
export type OperatingState = 'running' | 'standby' | 'tripped';

export type Severity = 'advisory' | 'warning' | 'critical';
/** Health is derived by ATLAS from active anomalies - never supplied by the source. */
export type HealthState = 'nominal' | Severity;

export const SEVERITY_RANK: Record<HealthState, number> = {
  nominal: 0,
  advisory: 1,
  warning: 2,
  critical: 3,
};

/** Declarative description of how an asset is drawn. Interpreted by the Spatial Engine only. */
export type AssetModelSpec =
  | { kind: 'tank'; radius: number; height: number }
  | { kind: 'pump' }
  | { kind: 'motor'; size: number; shaftY: number; vertical?: boolean }
  | { kind: 'pipeline'; radius: number; paths: Vec3[][] }
  | { kind: 'heat_exchanger' }
  | { kind: 'reactor'; radius: number; height: number }
  | { kind: 'filler' }
  | { kind: 'packer' }
  | { kind: 'palletiser' }
  | { kind: 'conveyor'; length: number }
  | { kind: 'cooling_tower' }
  | { kind: 'chiller' }
  | { kind: 'transformer' }
  | { kind: 'switchgear'; sections: number }
  | { kind: 'lube_skid' }
  | { kind: 'compressor' };

export interface AssetDefinition {
  /** Unique plant tag, e.g. "P-101". */
  id: string;
  name: string;
  category: AssetCategory;
  /** Area id (see AreaDefinition). */
  area: string;
  /** World position in metres. x = east, y = up, z = south. */
  position: Vec3;
  rotationY: number;
  model: AssetModelSpec;
  metadata: Record<string, string | number>;
  signals: SignalDefinition[];
}

// ----------------------------------------------------------------- signals ---

export type MeasurementType =
  | 'temperature'
  | 'vibration'
  | 'pressure'
  | 'flow'
  | 'current'
  | 'voltage'
  | 'power'
  | 'level'
  | 'speed'
  | 'rate'
  | 'load'
  | 'status'
  | 'availability';

export const MEASUREMENT_LABEL: Record<MeasurementType, string> = {
  temperature: 'temperature',
  vibration: 'vibration',
  pressure: 'pressure',
  flow: 'flow',
  current: 'current',
  voltage: 'voltage',
  power: 'power',
  level: 'level',
  speed: 'speed',
  rate: 'throughput',
  load: 'load',
  status: 'operating status',
  availability: 'availability',
};

export interface SignalLimits {
  lowAlarm?: number;
  lowWarn?: number;
  highWarn?: number;
  highAlarm?: number;
}

export interface SignalDefinition {
  /** Fully-qualified tag: `${assetId}.${key}`. */
  id: string;
  assetId: string;
  key: string;
  name: string;
  type: MeasurementType;
  unit: string;
  /** Engineering range (used for charts and to derive a noise floor). */
  range: [number, number];
  /** Design value at nominal duty. Documentation only - detection learns its own baseline. */
  nominal: number;
  /** Absolute alarm limits (configurable). */
  limits?: SignalLimits;
  /** Maximum credible rate of change, in units per minute. */
  rateLimit?: number;
  /** Setpoint/demand signal this measurement is controlled against. */
  setpointSignalId?: string;
  /** Allowed fractional deviation from the setpoint. */
  deviation?: { warn: number; alarm: number };
  /** Role in the control scheme. Setpoints are recorded but never analysed. */
  role: 'measurement' | 'setpoint';
  detect: {
    /** Statistical deviation from learned baseline. */
    baseline: boolean;
    /** Abnormal short-term variability (oscillation / instability). */
    variability: boolean;
  };
}

/** Reading as it arrives from a source system, before normalisation. */
export interface RawReading {
  tag: string;
  /** Epoch milliseconds. */
  ts: number;
  value: number;
  /** Source unit if it differs from the canonical unit of the signal. */
  unit?: string;
  quality?: Quality;
}

export type Quality = 'good' | 'uncertain' | 'bad';

/** Normalised observation - the only form the intelligence layer ever sees. */
export interface Observation {
  seq: number;
  /** Epoch milliseconds (event time). */
  t: number;
  assetId: string;
  signalId: string;
  type: MeasurementType;
  value: number;
  unit: string;
  quality: Quality;
  source: string;
}

// ------------------------------------------------------------------- graph ---

export type RelationType = 'process' | 'mechanical' | 'electrical' | 'cooling' | 'utility';

export const RELATION_VERB: Record<RelationType, string> = {
  process: 'feeds',
  mechanical: 'drives',
  electrical: 'powers',
  cooling: 'cools',
  utility: 'supplies',
};

export const RELATION_LABEL: Record<RelationType, string> = {
  process: 'Process flow',
  mechanical: 'Mechanical drive',
  electrical: 'Electrical supply',
  cooling: 'Cooling circuit',
  utility: 'Utility service',
};

/** Directed dependency: `from` supplies / acts on `to`. */
export interface AssetRelation {
  id: string;
  from: string;
  to: string;
  type: RelationType;
  /** What is exchanged: "process fluid", "cooling water", "400 V supply", ... */
  medium: string;
  description: string;
}

export interface PathStep {
  from: string;
  to: string;
  relationId: string;
  relation: RelationType;
  medium: string;
  /** downstream = walked along the dependency direction; upstream = against it. */
  direction: 'downstream' | 'upstream';
}

// --------------------------------------------------------------- detection ---

export interface RatioRuleDefinition {
  id: string;
  assetId: string;
  name: string;
  numeratorSignalId: string;
  denominatorSignalId: string;
  /** Rule is only evaluated while this signal equals `enableValue`. */
  enableSignalId: string;
  enableValue: number;
  warnPct: number;
  alarmPct: number;
  explanation: string;
}

export type AnomalyKind =
  | 'threshold_high'
  | 'threshold_low'
  | 'baseline_deviation'
  | 'rate_of_change'
  | 'variability'
  | 'setpoint_deviation'
  | 'composite';

export const ANOMALY_KIND_LABEL: Record<AnomalyKind, string> = {
  threshold_high: 'High limit exceeded',
  threshold_low: 'Low limit exceeded',
  baseline_deviation: 'Deviation from learned baseline',
  rate_of_change: 'Abnormal rate of change',
  variability: 'Abnormal variability',
  setpoint_deviation: 'Deviation from setpoint',
  composite: 'Abnormal operating combination',
};

export type AnomalyDirection = 'high' | 'low' | 'rising' | 'falling' | 'unstable';

export interface Anomaly {
  id: string;
  kind: AnomalyKind;
  /** Primary signal. Composite rules list every contributing signal in `signalIds`. */
  signalId: string;
  signalIds: string[];
  assetId: string;
  measurementType: MeasurementType;
  direction: AnomalyDirection;
  severity: Severity;
  status: 'active' | 'cleared';
  startedAt: number;
  lastSeenAt: number;
  clearedAt: number | null;
  /** Human-readable name of the detector that fired. */
  detector: string;
  /** The exact condition that was satisfied, with the numbers that satisfied it. */
  rule: string;
  message: string;
  observed: {
    valueAtOpen: number;
    value: number;
    /** Most extreme value seen while the anomaly was active. */
    peak: number;
    baselineMean?: number;
    baselineStd?: number;
    limit?: number;
    zScore?: number;
    slopePerMin?: number;
    ratioPct?: number;
  };
  unit: string;
  clearReason?: string;
}

export interface AnomalyEvent {
  type: 'opened' | 'escalated' | 'cleared';
  t: number;
  anomaly: Anomaly;
}

export interface BaselineInfo {
  ready: boolean;
  mean: number;
  std: number;
  samples: number;
  /** Detection is held off (re-learning after a commanded operating change) until this time. */
  holdoffUntil: number;
}

// ------------------------------------------------------------ source events ---

export type SourceEventKind = 'operating_point_change' | 'equipment_state_change' | 'simulation_control';

/**
 * Operational context published by a data source alongside telemetry.
 *
 * `rebaseline` marks a *commanded* change (setpoint move, duty changeover): detection
 * re-learns baselines for the listed assets instead of flagging the intended change.
 * `simulation_control` events are shown on the timeline but are never used by
 * detection or reasoning - the engines only ever see measurements.
 */
export interface SourceEvent {
  t: number;
  kind: SourceEventKind;
  title: string;
  detail: string;
  assetIds: string[];
  rebaseline?: { assetIds: string[] | 'all'; holdS: number };
  scenarioId?: string;
}

// -------------------------------------------------------------- intelligence ---

export interface CorrelationLink {
  anomalyId: string;
  assetId: string;
  /** The already-implicated asset this anomaly was linked to. */
  linkedAssetId: string;
  basis: 'initial' | 'same_asset' | 'dependency_path' | 'temporal_only';
  path: PathStep[];
  hops: number;
  /** Seconds between the incident's first anomaly and this one. */
  lagS: number;
  rationale: string;
}

export interface CriterionResult {
  id: string;
  role: 'supports' | 'contradicts';
  description: string;
  weight: number;
  state: 'observed' | 'not_observed';
  /** Whether this criterion is one of the template's entry conditions. */
  key: boolean;
  detail: string;
  anomalyIds: string[];
  signalIds: string[];
}

export type SupportBand = 'weak' | 'limited' | 'moderate' | 'strong';
export type Disposition = 'unverified' | 'confirmed' | 'ruled_out';

export interface HypothesisAssessment {
  /** `${templateId}@${focalAssetId}` - stable across re-assessments. */
  key: string;
  templateId: string;
  focalAssetId: string;
  title: string;
  mechanism: string;
  /** Evidence-support score in [0, 1]. A share of weighted evidence - not a probability. */
  support: number;
  band: SupportBand;
  criteria: CriterionResult[];
  /** What the available instrumentation cannot tell us. */
  unknowns: string[];
  /** What a person would need to check to confirm or rule this out. */
  verification: string;
  investigation: string[];
  alsoEvaluatedFor: string[];
  /** Set only by an operator. The engine never confirms its own hypotheses. */
  disposition: Disposition;
  dispositionAt: number | null;
}

export interface ImpactItem {
  assetId: string;
  hops: number;
  state: 'affected' | 'at_risk';
  /** Propagation strength in (0, 1] - attenuates with distance and medium changes. */
  exposure: number;
  path: PathStep[];
  note: string;
}

export interface Recommendation {
  id: string;
  priority: number;
  text: string;
  basis: string;
  assetId: string | null;
  done: boolean;
}

export interface OriginCandidate {
  assetId: string;
  score: number;
  rationale: string[];
}

export interface IncidentAsset {
  assetId: string;
  firstOnset: number;
  severity: Severity;
  activeAnomalies: number;
  totalAnomalies: number;
}

export type IncidentStatus = 'open' | 'monitoring' | 'resolved';

export interface Incident {
  id: string;
  seq: number;
  status: IncidentStatus;
  severity: Severity;
  openedAt: number;
  updatedAt: number;
  lastActivityAt: number;
  resolvedAt: number | null;
  title: string;
  summary: string;
  anomalyIds: string[];
  assets: IncidentAsset[];
  origin: OriginCandidate | null;
  originAlternatives: OriginCandidate[];
  correlations: CorrelationLink[];
  hypotheses: HypothesisAssessment[];
  impact: ImpactItem[];
  recommendations: Recommendation[];
  /** Incremented on every material change so views can cheaply detect updates. */
  revision: number;
  /** Id of the ReasoningProvider that produced the hypotheses. */
  reasoner: string;
  /**
   * Set when a commanded operating change touched the incident's assets. Evidence
   * gathered after an intervention reflects the intervention, so the hypotheses are
   * kept as they stood at that moment.
   */
  assessmentFrozen: { at: number; reason: string } | null;
  acknowledged: boolean;
}

// ----------------------------------------------------------------- timeline ---

export type TimelineKind = 'simulation' | 'operation' | 'anomaly' | 'incident' | 'scan' | 'operator' | 'system' | 'ai' | 'cyber';

export interface TimelineEvent {
  id: number;
  t: number;
  kind: TimelineKind;
  severity: Severity | 'info';
  title: string;
  detail: string;
  assetId: string | null;
  anomalyId: string | null;
  incidentId: string | null;
  signalId: string | null;
  /** Cyber event or case this entry refers to, if any. */
  cyberId?: string | null;
}

// ----------------------------------------------------------------- facility ---

export interface FacilityModel {
  id: string;
  name: string;
  description: string;
  areas: AreaDefinition[];
  assets: AssetDefinition[];
  relations: AssetRelation[];
  ratioRules: RatioRuleDefinition[];
  /** Location of the fixed sonar emitter. */
  sonarOrigin: Vec3;
}

export interface ScenarioInfo {
  id: string;
  name: string;
  /** normal operation, physical fault, cyber activity only, or cyber activity with a physical effect. */
  kind: 'normal' | 'anomaly' | 'cyber' | 'cyber_physical';
  summary: string;
  /** What a viewer should expect to see, in order. Shown in the UI as a script for the demo. */
  phases: string[];
}
