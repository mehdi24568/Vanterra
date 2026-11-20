import type { FacilityModel, ScenarioInfo } from '../core/types';
import type { OtModel } from '../cyber/types';
import { CYBER_SCENARIOS, CyberSimulation } from '../simulation/CyberSimulation';
import { FACILITY } from '../simulation/facility';
import { OT_MODEL } from '../simulation/otModel';
import { SCENARIOS, SimulationEngine } from '../simulation/SimulationEngine';
import type { AdapterHealth, ClockedAdapter, IngestSink, ScenarioControl, SecuritySource } from './DataSourceAdapter';

/** Bridges the process simulation and the simulated OT security telemetry onto the adapter contract. */
export class SimulationAdapter implements ClockedAdapter, ScenarioControl, SecuritySource {
  readonly id = 'sim-0';
  readonly kind = 'simulation' as const;
  readonly label = 'Local simulation';
  readonly tickS: number;
  private engine: SimulationEngine;
  private cyber: CyberSimulation;
  private sink: IngestSink | null = null;
  private batches = 0;
  private lastMessageAt: number | null = null;
  private currentSeed: number;

  constructor(seed: number) {
    this.currentSeed = seed;
    this.engine = new SimulationEngine(seed);
    this.cyber = new CyberSimulation(seed, (parameterId, value) => this.engine.setControlParameter(parameterId, value));
    this.tickS = this.engine.dtS;
  }

  get seed(): number {
    return this.currentSeed;
  }

  describe(): FacilityModel {
    return FACILITY;
  }

  describeOt(): OtModel {
    return OT_MODEL;
  }

  connect(sink: IngestSink): void {
    this.sink = sink;
  }

  disconnect(): void {
    this.sink = null;
  }

  health(): AdapterHealth {
    return {
      connected: this.sink !== null,
      lastMessageAt: this.lastMessageAt,
      batches: this.batches,
      detail: `Deterministic process and OT security simulation, seed ${this.currentSeed}`,
    };
  }

  nowMs(): number {
    return this.engine.timeMs;
  }

  advance(): boolean {
    if (!this.sink) return false;
    // Security records first: a controller write takes effect in this step's physics.
    const security = this.cyber.step(this.engine.timeMs);
    const { readings, events } = this.engine.step();
    for (const e of events) this.sink.sourceEvent(e);
    if (security.length > 0) this.sink.ingestSecurity?.(security, this.id);
    this.sink.ingest(readings, this.id);
    this.batches += 1;
    this.lastMessageAt = this.engine.timeMs;
    return true;
  }

  scenarios(): ScenarioInfo[] {
    return [...SCENARIOS, ...CYBER_SCENARIOS];
  }

  trigger(id: string): boolean {
    if (CYBER_SCENARIOS.some((s) => s.id === id)) return this.cyber.trigger(id, this.engine.timeMs);
    return this.engine.trigger(id);
  }

  activeScenarios(): string[] {
    return [...this.engine.activeScenarios, ...this.cyber.active];
  }

  reset(seed = this.currentSeed): void {
    this.currentSeed = seed;
    this.engine.reset(seed);
    this.cyber.reset(seed);
    this.batches = 0;
    this.lastMessageAt = null;
  }

  operatingPoint() {
    return this.engine.operatingPoint;
  }
}
