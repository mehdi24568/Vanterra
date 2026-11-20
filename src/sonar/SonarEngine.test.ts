import { describe, expect, it } from 'vitest';
import type { HealthState } from '../core/types';
import { MAX_PULSES, SonarEngine } from './SonarEngine';
import type { SonarContact } from './SonarEngine';

const targets = [
  { id: 'NEAR', x: 10, z: 0 },
  { id: 'MID', x: 0, z: 40 },
  { id: 'FAR', x: 80, z: 0 },
];

function rig(health: Record<string, HealthState> = {}) {
  const sonar = new SonarEngine(targets, { x: 0, z: 0 }, (id) => health[id] ?? 'nominal');
  sonar.continuous = false;
  const contacts: SonarContact[] = [];
  sonar.onContact((c) => contacts.push(c));
  return { sonar, contacts };
}

const run = (sonar: SonarEngine, seconds: number) => {
  for (let i = 0; i < seconds * 60; i++) sonar.update(1 / 60);
};

describe('SonarEngine', () => {
  it('contacts assets in order of distance as the wavefront reaches them', () => {
    const { sonar, contacts } = rig();
    sonar.ping('manual');
    run(sonar, 0.2);
    expect(contacts).toHaveLength(0);
    run(sonar, 0.3);
    expect(contacts.map((c) => c.assetId)).toEqual(['NEAR']);
    run(sonar, 3);
    expect(contacts.map((c) => c.assetId)).toEqual(['NEAR', 'MID', 'FAR']);
    expect(sonar.pulses).toHaveLength(0);
    expect(sonar.lastSweep).toMatchObject({ contacts: 3, kind: 'manual' });
  });

  it('limits a sweep to its radius', () => {
    const { sonar, contacts } = rig();
    sonar.settings.radius = 50;
    sonar.ping('manual');
    run(sonar, 4);
    expect(contacts.map((c) => c.assetId)).toEqual(['NEAR', 'MID']);
    expect(sonar.energyOf('FAR')).toBe(0);
  });

  it('deposits more energy nearby and lets it decay', () => {
    const { sonar } = rig();
    sonar.ping('manual');
    run(sonar, 3);
    const near = sonar.energyOf('NEAR');
    expect(near).toBeGreaterThan(sonar.energyOf('FAR'));
    run(sonar, 20);
    expect(sonar.energyOf('NEAR')).toBeLessThan(near * 0.3);
  });

  it('returns echoes for abnormal assets, and only hears advisories at sufficient intensity', () => {
    const health = { NEAR: 'advisory' as const, MID: 'critical' as const };
    const low = rig(health);
    low.sonar.settings.intensity = 0.4;
    low.sonar.ping('manual');
    run(low.sonar, 4);
    expect(low.sonar.lastSweep?.abnormal).toEqual({ advisory: 0, warning: 0, critical: 1 });
    expect(low.sonar.lastSweep?.missed).toBe(1);
    expect(low.contacts.find((c) => c.assetId === 'NEAR')?.echo).toBe(false);

    const high = rig(health);
    high.sonar.settings.intensity = 1.2;
    high.sonar.ping('manual');
    run(high.sonar, 4);
    expect(high.sonar.lastSweep?.abnormal).toEqual({ advisory: 1, warning: 0, critical: 1 });
    expect(high.sonar.lastSweep?.missed).toBe(0);
  });

  it('never cuts a facility sweep short to make room for local event pings', () => {
    const { sonar } = rig();
    sonar.ping('manual');
    run(sonar, 0.5); // the sweep has reached NEAR only
    for (let i = 0; i < MAX_PULSES + 4; i++) sonar.ping('event', { x: 0, z: 0 }, { radius: 500 });
    expect(sonar.pulses).toHaveLength(MAX_PULSES);
    expect(sonar.pulses.filter((p) => p.kind === 'manual')).toHaveLength(1);
    run(sonar, 4);
    expect(sonar.lastSweep).toMatchObject({ kind: 'manual', contacts: 3 });
    // With no event ping left to retire, a further event ping is declined rather than evicting a sweep.
    for (let i = 0; i < MAX_PULSES; i++) sonar.ping('manual', undefined, { radius: 5000 });
    expect(sonar.ping('event')).toBeNull();
    expect(sonar.pulses.every((p) => p.kind === 'manual')).toBe(true);
  });

  it('pulses on its own in continuous mode and freezes when paused', () => {
    const { sonar, contacts } = rig();
    sonar.continuous = true;
    run(sonar, 14);
    expect(sonar.sweepCount).toBeGreaterThanOrEqual(2);
    sonar.ping('manual');
    run(sonar, 0.1);
    const radius = sonar.pulses[sonar.pulses.length - 1].radius;
    const seen = contacts.length;
    sonar.paused = true;
    run(sonar, 5);
    expect(sonar.pulses[sonar.pulses.length - 1].radius).toBe(radius);
    expect(contacts).toHaveLength(seen);
    expect(sonar.ping('manual')).toBeNull();
    expect(sonar.status).toBe('paused');
  });
});
