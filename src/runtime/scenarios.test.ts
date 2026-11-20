/**
 * End-to-end tests of the headless pipeline: simulator -> telemetry -> detection ->
 * correlation -> reasoning. Each scenario is asserted on what the *engines concluded*
 * from measurements alone; the simulator never tells them what was injected.
 */
import { describe, expect, it } from 'vitest';
import { ReplayAdapter } from '../adapters/ReplayAdapter';
import type { RecordedBatch } from '../adapters/ReplayAdapter';
import { SimulationAdapter } from '../adapters/SimulationAdapter';
import type { IngestSink } from '../adapters/DataSourceAdapter';
import { AtlasCore } from './AtlasCore';
import { boot, TEST_SEED, trace } from './testHarness';

describe('nominal operation', () => {
  it('produces no anomalies and no incidents over 15 minutes', () => {
    const { core, run } = boot();
    run(900);
    expect(core.anomalies.all()).toHaveLength(0);
    expect(core.intelligence.incidents()).toHaveLength(0);
    expect(core.telemetry.stats.rejected).toBe(0);
  });

  it('is reproducible for a given seed and differs across seeds', () => {
    const a = boot(TEST_SEED, 60);
    const b = boot(TEST_SEED, 60);
    const c = boot(7, 60);
    for (const s of a.core.signals) expect(a.core.telemetry.latest(s.id)).toBe(b.core.telemetry.latest(s.id));
    expect(a.core.telemetry.latest('P-101.VIB')).not.toBe(c.core.telemetry.latest('P-101.VIB'));
  });

  it('normalises source units into canonical units', () => {
    const { core } = boot(TEST_SEED, 10);
    // The simulator emits these two tags in psi and degF respectively.
    expect(core.telemetry.latest('AC-610.DISCH_P')).toBeGreaterThan(6.8);
    expect(core.telemetry.latest('AC-610.DISCH_P')).toBeLessThan(7.2);
    expect(core.telemetry.latest('TX-501.OIL_TEMP')).toBeGreaterThan(50);
    expect(core.telemetry.latest('TX-501.OIL_TEMP')).toBeLessThan(66);
    expect(core.telemetry.stats.converted).toBeGreaterThan(0);
  });
});

describe('scenario: feed pump bearing degradation', () => {
  it('detects, correlates and explains the incident from measurements alone', () => {
    const { core, adapter, run, incident } = boot();
    const t0 = core.now;
    expect(adapter.trigger('pump-bearing')).toBe(true);
    run(150);
    trace('pump-bearing', core, t0);

    const anomalies = core.anomalies.all().sort((x, y) => x.startedAt - y.startedAt);
    expect(anomalies[0].signalId).toBe('P-101.VIB');

    const inc = incident()!;
    expect(inc).toBeDefined();
    expect(core.intelligence.incidents()).toHaveLength(1);
    const assets = inc.assets.map((a) => a.assetId);
    for (const id of ['P-101', 'M-101', 'PL-110', 'RX-301']) expect(assets).toContain(id);
    expect(inc.origin?.assetId).toBe('P-101');
    expect(inc.severity).toBe('critical');

    const lead = inc.hypotheses[0];
    expect(lead.templateId).toBe('bearing_wear');
    expect(lead.focalAssetId).toBe('P-101');
    expect(lead.support).toBeGreaterThanOrEqual(0.75);
    // Every observed criterion must cite real anomalies or signals.
    for (const c of lead.criteria.filter((k) => k.state === 'observed')) {
      expect(c.anomalyIds.length + c.signalIds.length).toBeGreaterThan(0);
      for (const id of c.anomalyIds) expect(core.intelligence.anomaly(id)).toBeDefined();
    }
    // The engine never confirms its own hypotheses.
    expect(inc.hypotheses.every((h) => h.disposition === 'unverified')).toBe(true);

    const cavitation = inc.hypotheses.find((h) => h.templateId === 'cavitation')!;
    expect(cavitation).toBeDefined();
    expect(cavitation.support).toBeLessThan(0.25);
    expect(cavitation.criteria.find((k) => k.id === 'suction_normal')?.state).toBe('observed');

    const atRisk = inc.impact.filter((i) => i.state === 'at_risk').map((i) => i.assetId);
    expect(atRisk).toContain('FL-310');
    expect(inc.recommendations.length).toBeGreaterThanOrEqual(3);
    expect(inc.summary).toMatch(/not a verified diagnosis/i);
  });

  it('correlates through dependency paths, each with a recorded rationale', () => {
    const { core, adapter, run, incident } = boot();
    adapter.trigger('pump-bearing');
    run(150);
    const inc = incident()!;
    const rx = inc.correlations.find((c) => c.assetId === 'RX-301')!;
    expect(rx.basis).toBe('dependency_path');
    expect(rx.hops).toBeGreaterThan(0);
    expect(rx.hops).toBeLessThanOrEqual(3);
    expect(rx.rationale).toMatch(/dependency step/);
    for (const c of inc.correlations) expect(core.intelligence.anomaly(c.anomalyId)).toBeDefined();
  });

  it('unfolds over time: an anomaly exists before the incident, and support grows', () => {
    const { core, adapter, run, incident } = boot();
    adapter.trigger('pump-bearing');
    run(8);
    expect(core.anomalies.all()).toHaveLength(0);
    for (let i = 0; i < 60 && !incident(); i++) run(1);
    const early = incident()!.hypotheses[0]?.support ?? 0;
    run(120);
    expect(incident()!.hypotheses[0].support).toBeGreaterThan(early);
  });

  it('recovers after a duty changeover and resolves without claiming a confirmed cause', () => {
    const { core, adapter, run, incident } = boot();
    const t0 = core.now;
    adapter.trigger('pump-bearing');
    run(110);
    const levelBefore = core.telemetry.latest('RX-301.LEVEL')!;
    adapter.trigger('pump-changeover');
    run(420);
    trace('pump-bearing + changeover', core, t0);
    expect(core.operatingState('P-102')).toBe('running');
    expect(core.operatingState('P-101')).toBe('standby');
    expect(core.telemetry.latest('RX-301.LEVEL')!).toBeGreaterThan(levelBefore);
    expect(core.telemetry.latest('PL-110.FLOW')!).toBeGreaterThan(115);
    const inc = incident()!;
    expect(inc.status).toBe('resolved');
    expect(inc.hypotheses.some((h) => h.disposition === 'confirmed')).toBe(false);
    expect(core.intelligence.incidents()).toHaveLength(1);
    // Recovery transients (flow overshoot while the reactor refills) must not be
    // mistaken for a new failure mode once the incident has cleared.
    expect(inc.hypotheses[0].templateId).toBe('bearing_wear');
    for (const h of inc.hypotheses.slice(1)) expect(h.support, h.templateId).toBeLessThan(0.5);
    expect(inc.hypotheses.find((h) => h.templateId === 'hx_fouling')?.support ?? 0).toBeLessThan(0.25);
  });
});

describe('scenario: cooling tower fan trip', () => {
  it('traces the thermal upset back to the tower and rejects the alternatives', () => {
    const { core, adapter, run, incident } = boot();
    const t0 = core.now;
    adapter.trigger('cooling-fan');
    run(200);
    trace('cooling-fan', core, t0);
    const inc = incident()!;
    expect(core.intelligence.incidents()).toHaveLength(1);
    expect(inc.origin?.assetId).toBe('CT-401');
    const assets = inc.assets.map((a) => a.assetId);
    for (const id of ['CT-401', 'CH-402', 'PL-410', 'HX-201']) expect(assets).toContain(id);
    expect(inc.hypotheses[0].templateId).toBe('tower_airflow_loss');
    expect(inc.hypotheses[0].band).toBe('strong');
    for (const id of ['chiller_fault', 'hx_fouling', 'cw_circulation_loss']) {
      const h = inc.hypotheses.find((x) => x.templateId === id);
      expect(h, id).toBeDefined();
      expect(h!.support, id).toBeLessThan(0.25);
      expect(h!.criteria.some((k) => k.role === 'contradicts' && k.state === 'observed'), id).toBe(true);
    }
    expect(core.operatingState('CT-401')).toBe('tripped');
    // The chiller's extra load warms the MCC-510 incomer, but with normal bus voltage
    // that is not evidence of a bad joint.
    expect(inc.hypotheses.find((h) => h.templateId === 'mcc_joint')?.support ?? 0).toBeLessThan(0.25);
  });
});

describe('scenario: MCC-520 voltage depression', () => {
  it('identifies the shared supply as origin rather than blaming individual motors', () => {
    const { core, adapter, run, incident } = boot();
    const t0 = core.now;
    adapter.trigger('mcc-sag');
    run(120);
    trace('mcc-sag', core, t0);
    const inc = incident()!;
    expect(core.intelligence.incidents()).toHaveLength(1);
    expect(inc.origin?.assetId).toBe('MCC-520');
    const assets = inc.assets.map((a) => a.assetId);
    for (const id of ['MCC-520', 'M-301', 'M-320', 'M-340']) expect(assets).toContain(id);
    // The healthy board must not be dragged into the incident.
    expect(assets).not.toContain('MCC-510');
    expect(inc.hypotheses[0].templateId).toBe('mcc_joint');
    const upstream = inc.hypotheses.find((h) => h.templateId === 'upstream_supply_sag')!;
    expect(upstream.support).toBeLessThan(0.25);
    const motor = inc.hypotheses.find((h) => h.templateId === 'motor_fault')!;
    expect(motor.support).toBeLessThan(0.25);
  });
});

describe('normal operating scenarios', () => {
  it('a planned rate change raises no incident', () => {
    const { core, adapter, run } = boot();
    const t0 = core.now;
    adapter.trigger('reduced-rate');
    run(420);
    trace('reduced-rate', core, t0);
    expect(core.telemetry.latest('PL-110.FLOW')!).toBeLessThan(90);
    expect(core.intelligence.incidents()).toHaveLength(0);
    expect(core.anomalies.all()).toHaveLength(0);
    adapter.trigger('full-rate');
    run(420);
    trace('full-rate', core, t0);
    expect(core.intelligence.incidents()).toHaveLength(0);
    expect(core.anomalies.all()).toHaveLength(0);
  });

  it('a routine pump changeover raises no incident', () => {
    const { core, adapter, run } = boot();
    const t0 = core.now;
    adapter.trigger('pump-changeover');
    run(420);
    trace('pump-changeover', core, t0);
    expect(core.operatingState('P-102')).toBe('running');
    expect(core.intelligence.incidents()).toHaveLength(0);
    expect(core.anomalies.all()).toHaveLength(0);
  });

  it('detection still works after baselines were re-learned at a new rate', () => {
    const { core, adapter, run, incident } = boot();
    adapter.trigger('reduced-rate');
    run(300);
    adapter.trigger('pump-bearing');
    run(150);
    expect(incident()?.hypotheses[0].templateId).toBe('bearing_wear');
    expect(core.anomalies.baseline('P-101.VIB')?.ready).toBe(true);
  });
});

describe('two independent faults', () => {
  it('keeps unrelated problems in separate incidents', () => {
    const { core, adapter, run } = boot();
    const t0 = core.now;
    adapter.trigger('mcc-sag');
    adapter.trigger('cooling-fan');
    run(60);
    trace('sag + fan', core, t0);
    const incidents = core.intelligence.incidents();
    expect(incidents.length).toBe(2);
    const origins = incidents.map((i) => i.origin?.assetId).sort();
    expect(origins).toEqual(['CT-401', 'MCC-520']);
  });

  // Regression (found by the evaluation harness): with these seeds, pump vibration and
  // pump discharge pressure were linked to the cooling-water upset through the heat
  // exchanger. Vibration only travels through a shaft; pressure and flow stay inside
  // their own fluid circuit.
  it.each([1, 3, 8])('does not link a pump fault to a cooling-water upset through the heat exchanger (seed %i)', (seed) => {
    const { core, adapter, run } = boot(seed);
    adapter.trigger('pump-bearing');
    adapter.trigger('cooling-fan');
    run(240);
    const incidents = core.intelligence.incidents();
    expect(incidents.map((i) => i.origin?.assetId).sort()).toEqual(['CT-401', 'P-101']);
    const pump = incidents.find((i) => i.origin?.assetId === 'P-101')!;
    const fan = incidents.find((i) => i.origin?.assetId === 'CT-401')!;
    expect(fan.assets.map((a) => a.assetId)).not.toContain('P-101');
    expect(fan.assets.map((a) => a.assetId)).not.toContain('PL-110');
    expect(pump.hypotheses[0].templateId).toBe('bearing_wear');
  });

  // Regression (found in the browser): faults injected one after another, as an operator
  // does in the UI. A fan trip is not explained by warm water reaching the tower, and a
  // bus that sags long after a motor's load changed is not that change's cause.
  it.each([30, 60, 90])('keeps faults injected %i s apart in separate incidents', (gap) => {
    const { core, adapter, run } = boot();
    adapter.trigger('pump-bearing');
    run(gap);
    adapter.trigger('cooling-fan');
    run(gap);
    adapter.trigger('mcc-sag');
    run(150);
    const incidents = core.intelligence.incidents();
    expect(incidents.map((i) => i.origin?.assetId).sort()).toEqual(['CT-401', 'MCC-520', 'P-101']);
    expect(incidents.map((i) => i.hypotheses[0]?.templateId).sort()).toEqual(['bearing_wear', 'mcc_joint', 'tower_airflow_loss']);
  });

  it('keeps three simultaneous faults apart and never names a load-only asset as origin', () => {
    const { core, adapter, run } = boot();
    const t0 = core.now;
    adapter.trigger('pump-bearing');
    adapter.trigger('cooling-fan');
    adapter.trigger('mcc-sag');
    run(150);
    trace('three faults', core, t0);
    const incidents = core.intelligence.incidents();
    const origins = incidents.map((i) => i.origin?.assetId).sort();
    expect(origins).toEqual(['CT-401', 'MCC-520', 'P-101']);
    const leads = incidents.map((i) => i.hypotheses[0]?.templateId).sort();
    expect(leads).toEqual(['bearing_wear', 'mcc_joint', 'tower_airflow_loss']);
  });
});

describe('who may confirm a hypothesis', () => {
  it('accepts an external assessment only for the current revision, and never as confirmed', () => {
    const { core, adapter, run, incident } = boot();
    adapter.trigger('mcc-sag');
    run(60);
    const inc = incident()!;
    // A provider (for example an LLM) that tries to hand back a "confirmed" diagnosis.
    const forged = inc.hypotheses.map((h) => ({ ...h, disposition: 'confirmed' as const, dispositionAt: 1 }));
    expect(core.intelligence.applyExternalAssessment(inc.id, inc.revision - 1, forged, 'external-test')).toBe(false);
    expect(core.intelligence.applyExternalAssessment(inc.id, inc.revision, forged, 'external-test')).toBe(true);
    expect(inc.reasoner).toBe('external-test');
    expect(inc.hypotheses.length).toBeGreaterThan(0);
    expect(inc.hypotheses.every((h) => h.disposition === 'unverified')).toBe(true);
  });

  it('lets an operator confirm, and says so in the summary', () => {
    const { core, adapter, run, incident } = boot();
    adapter.trigger('mcc-sag');
    run(60);
    const inc = incident()!;
    expect(inc.summary).toMatch(/not a verified diagnosis/i);
    expect(core.intelligence.setDisposition(inc.id, inc.hypotheses[0].key, 'confirmed', core.now)).toBe(true);
    expect(inc.hypotheses[0].disposition).toBe('confirmed');
    expect(inc.summary).toMatch(/confirmed by operator/i);
    // The verdict survives later re-assessments.
    run(20);
    expect(incident()!.hypotheses.find((h) => h.templateId === 'mcc_joint')?.disposition).toBe('confirmed');
  });
});

describe('operator workflow: acknowledge, recover, resolve', () => {
  it('acknowledges once, keeps the verdict open, and resolves when the plant recovers', () => {
    const { core, adapter, run, incident } = boot();
    adapter.trigger('cooling-fan');
    run(120);
    const inc = incident()!;
    expect(inc.status).not.toBe('resolved');
    expect(inc.acknowledged).toBe(false);
    const rev = inc.revision;
    expect(core.intelligence.acknowledge(inc.id)).toBe(true);
    expect(inc.acknowledged).toBe(true);
    expect(inc.revision).toBe(rev + 1);
    // A second acknowledgement is a no-op, and acknowledging is not a diagnosis.
    expect(core.intelligence.acknowledge(inc.id)).toBe(false);
    expect(inc.hypotheses.every((h) => h.disposition === 'unverified')).toBe(true);

    // Simulated repair: the process recovers on its own and the incident resolves.
    adapter.trigger('clear-faults');
    run(600);
    const after = incident()!;
    expect(after.id).toBe(inc.id);
    expect(core.operatingState('CT-401')).toBe('running');
    expect(after.status).toBe('resolved');
    expect(after.acknowledged).toBe(true);
    expect(core.anomalies.active()).toHaveLength(0);
    expect(after.hypotheses.some((h) => h.disposition === 'confirmed')).toBe(false);
    // Recovery must not open a second incident.
    expect(core.intelligence.incidents()).toHaveLength(1);
  });

  it('lets an operator rule out the leading hypothesis without anything else changing its verdict', () => {
    const { core, adapter, run, incident } = boot();
    adapter.trigger('pump-bearing');
    run(150);
    const inc = incident()!;
    const lead = inc.hypotheses[0];
    expect(core.intelligence.setDisposition(inc.id, lead.key, 'ruled_out', core.now)).toBe(true);
    run(30);
    expect(incident()!.hypotheses.find((h) => h.key === lead.key)?.disposition).toBe('ruled_out');
    expect(core.intelligence.setDisposition(inc.id, lead.key, 'unverified', core.now)).toBe(true);
    expect(incident()!.hypotheses.find((h) => h.key === lead.key)?.disposition).toBe('unverified');
  });
});

describe('reset and repeatability', () => {
  const fingerprint = (core: AtlasCore) => ({
    anomalies: core.anomalies
      .all()
      .map((a) => `${a.signalId}:${a.kind}:${a.severity}:${a.startedAt}`)
      .sort(),
    incidents: core.intelligence.incidents().map((i) => ({
      origin: i.origin?.assetId,
      assets: i.assets.map((a) => a.assetId),
      hypotheses: i.hypotheses.map((h) => `${h.templateId}:${h.support.toFixed(6)}`),
      recommendations: i.recommendations.map((r) => r.text),
    })),
  });

  it('a reset discards all state, and re-running the same scenario reproduces the same result exactly', () => {
    const { core, adapter, run } = boot();
    adapter.trigger('pump-bearing');
    run(150);
    const first = fingerprint(core);
    expect(first.incidents).toHaveLength(1);

    core.reset();
    expect(core.anomalies.all()).toHaveLength(0);
    expect(core.intelligence.incidents()).toHaveLength(0);
    expect(adapter.describe().assets.length).toBeGreaterThan(0);

    run(120);
    adapter.trigger('pump-bearing');
    run(150);
    expect(fingerprint(core)).toEqual(first);
  });

  it('a reset to a different seed still finds the same fault', () => {
    const { core, adapter, run, incident } = boot();
    core.reset(7);
    run(120);
    adapter.trigger('mcc-sag');
    run(120);
    expect(incident()?.origin?.assetId).toBe('MCC-520');
    expect(incident()?.hypotheses[0].templateId).toBe('mcc_joint');
  });
});

describe('source independence', () => {
  it('reaches the same conclusion from replayed telemetry as from the live simulator', () => {
    // Record a run by tapping the simulator's output.
    const sim = new SimulationAdapter(TEST_SEED);
    const batches: RecordedBatch[] = [];
    let current: RecordedBatch = { readings: [], events: [] };
    const tap: IngestSink = {
      ingest: (readings) => {
        current.readings = readings;
        batches.push(current);
        current = { readings: [], events: [] };
      },
      sourceEvent: (e) => current.events.push(e),
    };
    sim.connect(tap);
    for (let i = 0; i < 120 * 4; i++) sim.advance();
    sim.trigger('pump-bearing');
    for (let i = 0; i < 150 * 4; i++) sim.advance();

    const replayCore = new AtlasCore(new ReplayAdapter(sim.describe(), batches, sim.tickS));
    while (replayCore.advance(1) === 1);

    const live = boot();
    live.adapter.trigger('pump-bearing');
    live.run(150);

    const a = replayCore.intelligence.incidents()[0];
    const b = live.incident()!;
    expect(a.hypotheses[0].key).toBe(b.hypotheses[0].key);
    expect(a.hypotheses[0].support).toBeCloseTo(b.hypotheses[0].support, 6);
    expect(a.assets.map((x) => x.assetId)).toEqual(b.assets.map((x) => x.assetId));
  });
});
