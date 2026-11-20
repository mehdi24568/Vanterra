import type {
  AssetCategory,
  FacilityModel,
  HealthState,
  OperatingState,
  RelationType,
  Severity,
} from '../core/types';
import type { OtModel } from '../cyber/types';
import type { AssetGraph } from '../graph/AssetGraph';
import type { SonarEngine } from '../sonar/SonarEngine';

export interface LayerState {
  categories: Record<AssetCategory, boolean>;
  relations: boolean;
  relationTypes: Record<RelationType, boolean>;
  labels: boolean;
  sensors: boolean;
  structures: boolean;
  /** OT layer: controllers, control-room hosts, control and network links. */
  ot: boolean;
}

/** What an incident investigation wants emphasised in the scene. */
export interface FocusState {
  incidentId: string;
  severity: Severity;
  /** Affected asset -> its severity within the incident. */
  assets: Map<string, Severity>;
  atRisk: Set<string>;
  relationIds: Set<string>;
}

/** Mutable view state owned by the runtime and read by the Spatial Engine every frame. */
export interface ViewState {
  layers: LayerState;
  selectedAssetId: string | null;
  selectedSignalId: string | null;
  focus: FocusState | null;
}

/**
 * Everything the Spatial Engine needs from the rest of the system.
 * It pulls state each frame; nothing in the render loop goes through React.
 */
export interface SceneFeed {
  readonly facility: FacilityModel;
  readonly graph: AssetGraph;
  readonly sonar: SonarEngine;
  readonly view: ViewState;
  healthOf(assetId: string): HealthState;
  operatingState(assetId: string): OperatingState;
  signalHealth(signalId: string): HealthState;
  /** Called once per rendered frame with the real elapsed seconds. */
  frame(dt: number): void;
  /** OT model for the OT layer; null when the source has none. */
  readonly otModel: OtModel | null;
  /** Worst recent cyber event severity on an OT device, or null. */
  otSeverity(deviceId: string): Severity | null;
}

export interface SpatialCallbacks {
  onSelect(assetId: string | null, signalId?: string | null): void;
  onGroundPing(x: number, z: number): void;
  onError(message: string): void;
}
