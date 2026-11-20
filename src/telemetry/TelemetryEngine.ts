/**
 * Telemetry Engine - normalisation and measurement history.
 *
 * Turns source-specific readings into canonical `Observation`s (resolved signal,
 * canonical unit, quality) and keeps a fixed-size ring buffer per signal so that
 * detection, reasoning and charts all read the same history without allocation.
 */
import type { Observation, Quality, RawReading, SignalDefinition } from '../core/types';

const UNIT_CONVERSIONS: Record<string, { to: string; convert: (v: number) => number }> = {
  psi: { to: 'bar', convert: (v) => v * 0.0689476 },
  kPa: { to: 'bar', convert: (v) => v / 100 },
  degF: { to: '°C', convert: (v) => (v - 32) / 1.8 },
  K: { to: '°C', convert: (v) => v - 273.15 },
  'l/min': { to: 'm³/h', convert: (v) => v * 0.06 },
};

interface Ring {
  t: Float64Array;
  v: Float32Array;
  head: number;
  size: number;
}

export interface TelemetryStats {
  accepted: number;
  rejected: number;
  converted: number;
  unknownTags: number;
}

export interface SeriesView {
  t: number[];
  v: number[];
}

export class TelemetryEngine {
  readonly signals: SignalDefinition[];
  readonly stats: TelemetryStats = { accepted: 0, rejected: 0, converted: 0, unknownTags: 0 };
  private byId = new Map<string, SignalDefinition>();
  private rings = new Map<string, Ring>();
  private seq = 0;
  private latestTime = 0;

  constructor(
    signals: SignalDefinition[],
    private readonly capacity = 2400,
  ) {
    this.signals = signals;
    for (const s of signals) {
      this.byId.set(s.id, s);
      this.rings.set(s.id, { t: new Float64Array(capacity), v: new Float32Array(capacity), head: 0, size: 0 });
    }
  }

  clear(): void {
    for (const r of this.rings.values()) {
      r.head = 0;
      r.size = 0;
    }
    this.stats.accepted = 0;
    this.stats.rejected = 0;
    this.stats.converted = 0;
    this.stats.unknownTags = 0;
    this.seq = 0;
    this.latestTime = 0;
  }

  signal(id: string): SignalDefinition | undefined {
    return this.byId.get(id);
  }

  /** Event time of the most recent accepted observation. */
  get now(): number {
    return this.latestTime;
  }

  /** Normalise one raw reading. Returns null (and counts it) when it cannot be used. */
  normalise(raw: RawReading, source: string): Observation | null {
    const def = this.byId.get(raw.tag);
    if (!def) {
      this.stats.unknownTags += 1;
      this.stats.rejected += 1;
      return null;
    }
    if (!Number.isFinite(raw.value) || !Number.isFinite(raw.ts)) {
      this.stats.rejected += 1;
      return null;
    }
    let value = raw.value;
    let quality: Quality = raw.quality ?? 'good';
    if (raw.unit && raw.unit !== def.unit) {
      const conv = UNIT_CONVERSIONS[raw.unit];
      if (conv && conv.to === def.unit) {
        value = conv.convert(value);
        this.stats.converted += 1;
      } else {
        // Unknown unit: keep the number but flag it rather than silently trusting it.
        quality = 'uncertain';
      }
    }
    const span = def.range[1] - def.range[0];
    if (value < def.range[0] - span || value > def.range[1] + span) quality = 'bad';
    if (quality === 'bad') {
      this.stats.rejected += 1;
      return null;
    }
    this.seq += 1;
    return {
      seq: this.seq,
      t: raw.ts,
      assetId: def.assetId,
      signalId: def.id,
      type: def.type,
      value,
      unit: def.unit,
      quality,
      source,
    };
  }

  /** Normalise and store a batch. Returns the accepted observations in arrival order. */
  ingest(readings: RawReading[], source: string): Observation[] {
    const out: Observation[] = [];
    for (const raw of readings) {
      const obs = this.normalise(raw, source);
      if (!obs) continue;
      const ring = this.rings.get(obs.signalId)!;
      ring.t[ring.head] = obs.t;
      ring.v[ring.head] = obs.value;
      ring.head = (ring.head + 1) % this.capacity;
      if (ring.size < this.capacity) ring.size += 1;
      if (obs.t > this.latestTime) this.latestTime = obs.t;
      this.stats.accepted += 1;
      out.push(obs);
    }
    return out;
  }

  latest(signalId: string): number | undefined {
    const r = this.rings.get(signalId);
    if (!r || r.size === 0) return undefined;
    return r.v[(r.head - 1 + this.capacity) % this.capacity];
  }

  latestTimeOf(signalId: string): number | undefined {
    const r = this.rings.get(signalId);
    if (!r || r.size === 0) return undefined;
    return r.t[(r.head - 1 + this.capacity) % this.capacity];
  }

  /** Number of signals with an observation newer than `maxAgeMs`. */
  freshSignalCount(maxAgeMs: number): number {
    let n = 0;
    for (const id of this.rings.keys()) {
      const t = this.latestTimeOf(id);
      if (t !== undefined && this.latestTime - t <= maxAgeMs) n += 1;
    }
    return n;
  }

  /** Chronological copy of the samples at or after `sinceMs`, written into `out`. */
  read(signalId: string, sinceMs: number, out: SeriesView): SeriesView {
    out.t.length = 0;
    out.v.length = 0;
    const r = this.rings.get(signalId);
    if (!r) return out;
    const start = (r.head - r.size + this.capacity) % this.capacity;
    for (let i = 0; i < r.size; i++) {
      const idx = (start + i) % this.capacity;
      if (r.t[idx] >= sinceMs) {
        out.t.push(r.t[idx]);
        out.v.push(r.v[idx]);
      }
    }
    return out;
  }

  /** Mean of the samples in [fromMs, toMs]. Undefined when the window is empty. */
  mean(signalId: string, fromMs: number, toMs: number): number | undefined {
    const r = this.rings.get(signalId);
    if (!r) return undefined;
    let sum = 0;
    let n = 0;
    for (let i = 1; i <= r.size; i++) {
      const idx = (r.head - i + this.capacity) % this.capacity;
      const t = r.t[idx];
      if (t < fromMs) break;
      if (t <= toMs) {
        sum += r.v[idx];
        n += 1;
      }
    }
    return n > 0 ? sum / n : undefined;
  }
}
