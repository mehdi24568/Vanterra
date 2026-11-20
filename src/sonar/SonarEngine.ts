/**
 * Sonar Engine - the scanning mechanism, independent of how it is drawn.
 *
 * A pulse is a wavefront expanding across the site at a fixed speed. When the front
 * crosses an asset the engine registers a *contact*: the asset receives reveal energy
 * (which then decays), its current health is sampled, and abnormal assets return an
 * echo. Everything visual - illumination, labels, sensor markers, echo rings, sweep
 * statistics - is driven from these contacts, so the scan is a mechanism rather than
 * an animation played over the scene.
 *
 * Intensity is functional: it sets how much energy a contact deposits, how long an
 * asset stays revealed, and whether advisory-level conditions return an echo at all.
 */
import type { HealthState, Severity } from '../core/types';

export interface SonarSettings {
  /** 0.3 .. 1.5 */
  intensity: number;
  /** Maximum sweep radius in metres. */
  radius: number;
  /** Seconds between pulses in continuous mode. */
  intervalS: number;
  /** Wavefront speed in metres per second. */
  speed: number;
}

export type PulseKind = 'manual' | 'continuous' | 'event';

export interface SonarPulse {
  id: number;
  kind: PulseKind;
  x: number;
  z: number;
  radius: number;
  maxRadius: number;
  intensity: number;
  speed: number;
  contacts: number;
  abnormal: Record<Severity, number>;
  /** Abnormal assets the pulse crossed without raising an echo (below its sensitivity). */
  missed: number;
  contacted: Set<string>;
}

export interface SonarContact {
  pulseId: number;
  pulseKind: PulseKind;
  assetId: string;
  distance: number;
  energy: number;
  health: HealthState;
  /** True when the contact returned an abnormal echo. */
  echo: boolean;
}

export interface SweepReport {
  pulseId: number;
  kind: PulseKind;
  contacts: number;
  abnormal: Record<Severity, number>;
  missed: number;
  radius: number;
  intensity: number;
}

export interface SonarTarget {
  id: string;
  x: number;
  z: number;
}

/** Advisory conditions only echo at or above this pulse intensity. */
export const ADVISORY_ECHO_INTENSITY = 0.6;
export const MAX_PULSES = 6;

export class SonarEngine {
  settings: SonarSettings = { intensity: 1, radius: 95, intervalS: 6, speed: 34 };
  continuous = true;
  paused = false;
  readonly pulses: SonarPulse[] = [];
  lastSweep: SweepReport | null = null;
  sweepCount = 0;

  private seq = 0;
  private timer = 0;
  private energy = new Map<string, number>();
  private decayTau = new Map<string, number>();
  private lastContact = new Map<string, number>();
  private clock = 0;
  private contactListeners = new Set<(c: SonarContact) => void>();
  private sweepListeners = new Set<(r: SweepReport) => void>();

  constructor(
    private readonly targets: SonarTarget[],
    private readonly origin: { x: number; z: number },
    private readonly healthOf: (assetId: string) => HealthState,
  ) {
    // First continuous pulse fires almost immediately after start-up.
    this.timer = this.settings.intervalS - 0.6;
  }

  onContact(listener: (c: SonarContact) => void): () => void {
    this.contactListeners.add(listener);
    return () => this.contactListeners.delete(listener);
  }

  onSweep(listener: (r: SweepReport) => void): () => void {
    this.sweepListeners.add(listener);
    return () => this.sweepListeners.delete(listener);
  }

  /** Reveal energy of an asset, 0 (unscanned) to ~1.5. */
  energyOf(assetId: string): number {
    return this.energy.get(assetId) ?? 0;
  }

  /** Seconds (sonar clock) since the asset was last crossed by a wavefront. */
  secondsSinceContact(assetId: string): number | null {
    const t = this.lastContact.get(assetId);
    return t === undefined ? null : this.clock - t;
  }

  get status(): 'paused' | 'continuous' | 'sweeping' | 'idle' {
    if (this.paused) return 'paused';
    if (this.continuous) return 'continuous';
    return this.pulses.length > 0 ? 'sweeping' : 'idle';
  }

  /** Emit a pulse. Returns null when paused. */
  ping(kind: PulseKind, at?: { x: number; z: number }, override?: Partial<Pick<SonarSettings, 'radius' | 'intensity'>>): SonarPulse | null {
    if (this.paused) return null;
    if (this.pulses.length >= MAX_PULSES) {
      // At capacity, make room by retiring the local event ping closest to finishing.
      // A facility sweep is never cut short for an event ping: a burst of detections
      // must not leave half the site unscanned.
      const progress = (p: SonarPulse) => p.radius / p.maxRadius;
      let victim = -1;
      for (let i = 0; i < this.pulses.length; i++) {
        if (this.pulses[i].kind !== 'event') continue;
        if (victim < 0 || progress(this.pulses[i]) > progress(this.pulses[victim])) victim = i;
      }
      if (victim < 0) {
        if (kind === 'event') return null;
        victim = 0;
        for (let i = 1; i < this.pulses.length; i++) if (progress(this.pulses[i]) > progress(this.pulses[victim])) victim = i;
      }
      this.finish(this.pulses.splice(victim, 1)[0]);
    }
    this.seq += 1;
    const pulse: SonarPulse = {
      id: this.seq,
      kind,
      x: at?.x ?? this.origin.x,
      z: at?.z ?? this.origin.z,
      radius: 0,
      maxRadius: override?.radius ?? this.settings.radius,
      intensity: override?.intensity ?? this.settings.intensity,
      speed: this.settings.speed,
      contacts: 0,
      abnormal: { advisory: 0, warning: 0, critical: 0 },
      missed: 0,
      contacted: new Set(),
    };
    this.pulses.push(pulse);
    return pulse;
  }

  /** Advance the scanner by `dt` seconds of real time. */
  update(dt: number): void {
    if (this.paused || dt <= 0) return;
    this.clock += dt;

    for (const [id, e] of this.energy) {
      const tau = this.decayTau.get(id) ?? 6;
      const next = e * Math.exp(-dt / tau);
      if (next < 0.004) this.energy.delete(id);
      else this.energy.set(id, next);
    }

    if (this.continuous) {
      this.timer += dt;
      if (this.timer >= this.settings.intervalS) {
        this.timer = 0;
        this.ping('continuous');
      }
    }

    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      p.radius += p.speed * dt;
      const reach = Math.min(p.radius, p.maxRadius);
      for (const t of this.targets) {
        if (p.contacted.has(t.id)) continue;
        const d = Math.hypot(t.x - p.x, t.z - p.z);
        if (d > reach) continue;
        p.contacted.add(t.id);
        p.contacts += 1;
        const energy = p.intensity * (1 - 0.45 * (d / p.maxRadius));
        if (energy > this.energyOf(t.id)) {
          this.energy.set(t.id, energy);
          this.decayTau.set(t.id, 3 + 7 * p.intensity);
        }
        this.lastContact.set(t.id, this.clock);
        const health = this.healthOf(t.id);
        let echo = false;
        if (health !== 'nominal') {
          echo = health !== 'advisory' || p.intensity >= ADVISORY_ECHO_INTENSITY;
          if (echo) p.abnormal[health] += 1;
          else p.missed += 1;
        }
        const contact: SonarContact = { pulseId: p.id, pulseKind: p.kind, assetId: t.id, distance: d, energy, health, echo };
        for (const l of this.contactListeners) l(contact);
      }
      if (p.radius >= p.maxRadius) {
        this.pulses.splice(i, 1);
        this.finish(p);
      }
    }
  }

  private finish(p: SonarPulse): void {
    const report: SweepReport = {
      pulseId: p.id,
      kind: p.kind,
      contacts: p.contacts,
      abnormal: p.abnormal,
      missed: p.missed,
      radius: p.maxRadius,
      intensity: p.intensity,
    };
    if (p.kind !== 'event') {
      this.lastSweep = report;
      this.sweepCount += 1;
    }
    for (const l of this.sweepListeners) l(report);
  }

  reset(): void {
    this.pulses.length = 0;
    this.energy.clear();
    this.decayTau.clear();
    this.lastContact.clear();
    this.lastSweep = null;
    this.sweepCount = 0;
    this.timer = this.settings.intervalS - 0.6;
  }
}
