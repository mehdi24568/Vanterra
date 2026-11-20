import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng';
import type { Observation, SignalDefinition } from '../core/types';
import { AnomalyEngine } from './AnomalyEngine';

const DT = 250;

function signal(over: Partial<SignalDefinition> = {}): SignalDefinition {
  return {
    id: 'X-1.PV',
    assetId: 'X-1',
    key: 'PV',
    name: 'Test value',
    type: 'temperature',
    unit: '°C',
    range: [0, 100],
    nominal: 50,
    role: 'measurement',
    detect: { baseline: true, variability: false },
    ...over,
  };
}

/** Feed a generated series; returns the engine and the time after the last sample. */
function feed(engine: AnomalyEngine, def: SignalDefinition, seconds: number, value: (tS: number) => number, startMs = 0): number {
  const rng = new Rng(42);
  let t = startMs;
  for (let i = 0; i < seconds * 4; i++) {
    t += DT;
    const obs: Observation = {
      seq: i,
      t,
      assetId: def.assetId,
      signalId: def.id,
      type: def.type,
      value: value((t - startMs) / 1000) + 0.1 * rng.gauss(),
      unit: def.unit,
      quality: 'good',
      source: 'test',
    };
    engine.process(obs);
    engine.endBatch(t);
  }
  return t;
}

describe('AnomalyEngine', () => {
  it('learns a baseline and stays quiet on stationary noise', () => {
    const def = signal();
    const engine = new AnomalyEngine([def], []);
    feed(engine, def, 600, () => 50);
    expect(engine.all()).toHaveLength(0);
    const b = engine.baseline(def.id)!;
    expect(b.ready).toBe(true);
    expect(b.mean).toBeCloseTo(50, 0);
  });

  it('flags a sustained shift from baseline and clears when it returns', () => {
    const def = signal();
    const engine = new AnomalyEngine([def], []);
    let t = feed(engine, def, 60, () => 50);
    t = feed(engine, def, 20, () => 54, t);
    const active = engine.active();
    expect(active).toHaveLength(1);
    expect(active[0].kind).toBe('baseline_deviation');
    expect(active[0].direction).toBe('high');
    expect(active[0].rule).toMatch(/σ above baseline/);
    expect(active[0].observed.baselineMean).toBeCloseTo(50, 0);
    feed(engine, def, 30, () => 50, t);
    expect(engine.active()).toHaveLength(0);
    expect(engine.all()[0].status).toBe('cleared');
  });

  it('does not absorb a fault into the baseline while it is active', () => {
    const def = signal();
    const engine = new AnomalyEngine([def], []);
    const t = feed(engine, def, 60, () => 50);
    feed(engine, def, 600, () => 56, t);
    expect(engine.baseline(def.id)!.mean).toBeLessThan(51);
    expect(engine.active()).toHaveLength(1);
  });

  it('requires persistence before raising an absolute-limit anomaly, then escalates', () => {
    const def = signal({ limits: { highWarn: 70, highAlarm: 80 }, detect: { baseline: false, variability: false } });
    const engine = new AnomalyEngine([def], []);
    let t = feed(engine, def, 20, () => 50);
    t = feed(engine, def, 1, () => 75, t); // 1 s spike: shorter than the 1.5 s persistence
    t = feed(engine, def, 5, () => 50, t);
    expect(engine.all()).toHaveLength(0);
    t = feed(engine, def, 5, () => 75, t);
    expect(engine.active()[0].severity).toBe('warning');
    feed(engine, def, 5, () => 85, t);
    expect(engine.active()[0].severity).toBe('critical');
    expect(engine.drainEvents().map((e) => e.type)).toEqual(['opened', 'escalated']);
  });

  it('detects an abnormal rate of change from the fitted slope', () => {
    const def = signal({ rateLimit: 5, detect: { baseline: false, variability: false } });
    const engine = new AnomalyEngine([def], []);
    const t = feed(engine, def, 60, () => 50);
    feed(engine, def, 20, (s) => 50 + s * 0.25, t); // 15 °C/min
    const a = engine.active().find((x) => x.kind === 'rate_of_change')!;
    expect(a.direction).toBe('rising');
    expect(a.observed.slopePerMin).toBeGreaterThan(10);
  });

  it('detects instability without a shift in the mean', () => {
    const def = signal({ detect: { baseline: false, variability: true }, range: [0, 20] });
    const engine = new AnomalyEngine([def], []);
    const t = feed(engine, def, 60, () => 10);
    feed(engine, def, 20, (s) => 10 + 1.2 * Math.sin(2 * Math.PI * 0.8 * s), t);
    expect(engine.active().some((a) => a.kind === 'variability' && a.direction === 'unstable')).toBe(true);
  });

  it('flags a measurement that falls behind its setpoint', () => {
    const sp = signal({ id: 'X-1.SP', key: 'SP', role: 'setpoint', detect: { baseline: false, variability: false } });
    const pv = signal({ setpointSignalId: 'X-1.SP', deviation: { warn: 0.06, alarm: 0.15 }, detect: { baseline: false, variability: false } });
    const engine = new AnomalyEngine([sp, pv], []);
    let t = 0;
    for (let i = 0; i < 400; i++) {
      t += DT;
      const mk = (id: string, value: number): Observation => ({ seq: i, t, assetId: 'X-1', signalId: id, type: 'temperature', value, unit: '°C', quality: 'good', source: 'test' });
      engine.process(mk('X-1.SP', 50));
      engine.process(mk('X-1.PV', i < 200 ? 50 : 40));
      engine.endBatch(t);
    }
    const a = engine.active().find((x) => x.kind === 'setpoint_deviation')!;
    expect(a.direction).toBe('low');
    expect(a.severity).toBe('critical');
  });

  it('re-learns instead of alarming after a commanded change', () => {
    const def = signal({ rateLimit: 5 });
    const engine = new AnomalyEngine([def], []);
    let t = feed(engine, def, 60, () => 50);
    engine.rebaseline(['X-1'], 30, t);
    t = feed(engine, def, 30, (s) => 50 + s * 0.4, t); // commanded ramp to 62
    t = feed(engine, def, 120, () => 62, t);
    expect(engine.all()).toHaveLength(0);
    expect(engine.baseline(def.id)!.mean).toBeCloseTo(62, 0);
    feed(engine, def, 20, () => 67, t);
    expect(engine.active()).toHaveLength(1);
  });

  it('evaluates a composite ratio rule only while its equipment is running', () => {
    const mk = (key: string, type: SignalDefinition['type']) =>
      signal({ id: `X-1.${key}`, key, type, range: [0, 200], detect: { baseline: false, variability: false } });
    const defs = [mk('I', 'current'), mk('Q', 'flow'), mk('RUN', 'status')];
    const engine = new AnomalyEngine(defs, [
      {
        id: 'X-1.RATIO',
        assetId: 'X-1',
        name: 'Current per flow',
        numeratorSignalId: 'X-1.I',
        denominatorSignalId: 'X-1.Q',
        enableSignalId: 'X-1.RUN',
        enableValue: 1,
        warnPct: 10,
        alarmPct: 25,
        explanation: '',
      },
    ]);
    let t = 0;
    const step = (i: number, q: number, run: number) => {
      t += DT;
      const mkObs = (id: string, value: number): Observation => ({ seq: 0, t, assetId: 'X-1', signalId: id, type: 'current', value, unit: '', quality: 'good', source: 'test' });
      engine.process(mkObs('X-1.I', i));
      engine.process(mkObs('X-1.Q', q));
      engine.process(mkObs('X-1.RUN', run));
      engine.endBatch(t);
    };
    for (let i = 0; i < 300; i++) step(80, 100, 1);
    expect(engine.all()).toHaveLength(0);
    for (let i = 0; i < 80; i++) step(96, 100, 1); // +20 %
    const a = engine.active()[0];
    expect(a.kind).toBe('composite');
    expect(a.signalIds).toEqual(['X-1.I', 'X-1.Q']);
    for (let i = 0; i < 20; i++) step(0, 0, 0); // stopped: rule no longer applies
    expect(engine.active()).toHaveLength(0);
  });
});
