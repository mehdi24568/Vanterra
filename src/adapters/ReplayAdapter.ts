import type { FacilityModel, RawReading, SourceEvent } from '../core/types';
import type { AdapterHealth, ClockedAdapter, IngestSink } from './DataSourceAdapter';

export interface RecordedBatch {
  readings: RawReading[];
  events: SourceEvent[];
}

/**
 * Replays previously captured batches through the same sink as a live source.
 *
 * It exists for two reasons: it is the shape a historical-telemetry (backfill)
 * adapter will take, and it proves in tests that detection and reasoning depend
 * only on the data, not on the simulator that happened to produce it.
 */
export class ReplayAdapter implements ClockedAdapter {
  readonly id = 'replay-0';
  readonly kind = 'replay' as const;
  readonly label = 'Recorded telemetry replay';
  readonly tickS: number;
  private cursor = 0;
  private sink: IngestSink | null = null;
  private lastMessageAt: number | null = null;

  constructor(
    private readonly facility: FacilityModel,
    private readonly batches: RecordedBatch[],
    tickS: number,
  ) {
    this.tickS = tickS;
  }

  describe(): FacilityModel {
    return this.facility;
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
      batches: this.cursor,
      detail: `Replay ${this.cursor}/${this.batches.length} batches`,
    };
  }

  nowMs(): number {
    return this.lastMessageAt ?? this.batches[0]?.readings[0]?.ts ?? 0;
  }

  advance(): boolean {
    if (!this.sink || this.cursor >= this.batches.length) return false;
    const batch = this.batches[this.cursor++];
    for (const e of batch.events) this.sink.sourceEvent(e);
    this.sink.ingest(batch.readings, this.id);
    this.lastMessageAt = batch.readings[0]?.ts ?? this.lastMessageAt;
    return true;
  }
}
