/**
 * Data Adapter Layer.
 *
 * Everything upstream of this interface is replaceable. The core pipeline
 * (telemetry -> detection -> intelligence) only ever receives `RawReading`s and
 * `SourceEvent`s through an `IngestSink`, and an asset model through `describe()`.
 *
 * Planned adapters map onto this contract as follows:
 *   OPC UA   - subscription data-change notifications -> RawReading{tag: nodeId alias, ts: sourceTimestamp}
 *   MQTT     - Sparkplug B / JSON topics             -> RawReading per metric
 *   REST     - polled historian endpoints            -> RawReading batches
 *   History  - CSV/Parquet backfill                  -> ClockedAdapter (see ReplayAdapter)
 * None of these are implemented in this prototype; the simulator and the replay
 * adapter are the two working implementations.
 */
import type { FacilityModel, RawReading, ScenarioInfo, SourceEvent } from '../core/types';
import type { OtModel, SecurityRecord } from '../cyber/types';

export interface IngestSink {
  ingest(readings: RawReading[], sourceId: string): void;
  sourceEvent(event: SourceEvent): void;
  /** OT security telemetry (authentication, flows, controller audit), if the source provides it. */
  ingestSecurity?(records: SecurityRecord[], sourceId: string): void;
}

/**
 * Optional capability: the source also describes the OT network and delivers security
 * telemetry. A real deployment would map a passive OT sensor and controller audit logs
 * onto this; here only the simulator implements it.
 */
export interface SecuritySource {
  describeOt(): OtModel;
}

export function hasSecuritySource(a: DataSourceAdapter): a is DataSourceAdapter & SecuritySource {
  return typeof (a as unknown as SecuritySource).describeOt === 'function';
}

export interface AdapterHealth {
  connected: boolean;
  /** Event time of the last batch delivered. */
  lastMessageAt: number | null;
  batches: number;
  detail: string;
}

export type AdapterKind = 'simulation' | 'replay' | 'opc-ua' | 'mqtt' | 'rest';

export interface DataSourceAdapter {
  readonly id: string;
  readonly kind: AdapterKind;
  readonly label: string;
  /** Asset registry, signal list and dependency relations for the monitored facility. */
  describe(): FacilityModel;
  connect(sink: IngestSink): void;
  disconnect(): void;
  health(): AdapterHealth;
}

/**
 * A source whose clock is driven by the host (simulators, historical replay).
 * Live adapters (OPC UA, MQTT) push on their own schedule and do not implement this.
 */
export interface ClockedAdapter extends DataSourceAdapter {
  /** Event-time seconds advanced by one call to `advance()`. */
  readonly tickS: number;
  /** Produce the next batch and deliver it to the sink. Returns false when exhausted. */
  advance(): boolean;
  nowMs(): number;
}

/** Optional capability: scenario control. Only simulators provide it. */
export interface ScenarioControl {
  scenarios(): ScenarioInfo[];
  trigger(id: string): boolean;
  activeScenarios(): string[];
  reset(seed?: number): void;
  readonly seed: number;
}

export function isClocked(a: DataSourceAdapter): a is ClockedAdapter {
  return typeof (a as ClockedAdapter).advance === 'function';
}

export function hasScenarioControl(a: DataSourceAdapter): a is DataSourceAdapter & ScenarioControl {
  return typeof (a as unknown as ScenarioControl).trigger === 'function';
}
