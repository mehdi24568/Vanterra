/**
 * Cyber layer and cyber-physical assessment, end to end through the headless core.
 * The engines are never told which scenario is running.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Incident } from '../core/types';
import { boot } from '../runtime/testHarness';
import type { Rig } from '../runtime/testHarness';

const rules = (rig: Rig) => rig.core.cyber!.events.map((e) => e.ruleId);
const byOrigin = (rig: Rig, assetId: string): Incident | undefined => rig.core.intelligence.incidents().find((i) => i.origin?.assetId === assetId);

describe('OT security baseline', () => {
  it('raises no cyber events and no cases in fifteen minutes of normal operation', () => {
    const rig = boot();
    rig.run(900);
    expect(rig.core.cyber!.events).toHaveLength(0);
    expect(rig.core.cyber!.cases).toHaveLength(0);
  });

  it('declares every cyber-physical relationship explicitly', () => {
    const { core } = boot(undefined, 10);
    expect(core.cyber!.controllersOf('P-101')).toEqual(['PLC-200']);
    expect(core.cyber!.controllersOf('CT-401')).toEqual(['PLC-500']);
    expect(core.cyber!.controllersOf('TX-501')).toEqual([]); // monitored, not controlled
    for (const c of core.cyber!.model.controls) expect(core.graph.asset(c.assetId), c.assetId).toBeDefined();
    for (const p of core.cyber!.model.parameters) for (const a of p.affects) expect(core.graph.asset(a), a).toBeDefined();
  });
});

describe('Scenario B: suspicious remote engineering access (cyber only)', () => {
  it('detects each step, groups it into one case, and finds no physical effect', () => {
    const rig = boot();
    rig.adapter.trigger('ot-remote-access');
    rig.run(120);
    expect(rules(rig)).toEqual(expect.arrayContaining(['AUTH-BURST', 'ENG-SESSION', 'FIRST-SEEN', 'CONTROLLER-READ', 'CONDUIT']));
    expect(rules(rig)).not.toContain('UNAPPROVED-CHANGE');
    expect(rig.core.cyber!.cases).toHaveLength(1);
    const c = rig.core.cyber!.cases[0];
    expect(c.deviceIds).toContain('PLC-500');
    expect(c.identities).toContain('vendor.remote');
    // Nothing physical happened, and nothing physical is claimed.
    expect(rig.core.anomalies.all()).toHaveLength(0);
    expect(rig.core.intelligence.incidents()).toHaveLength(0);
    const a = rig.core.assessCyberCase(c.id)!;
    expect(a.physicalEffectObserved).toBe(false);
    expect(a.potentialImpact.find((p) => p.plcId === 'PLC-500')?.assets).toContain('CT-401');
    expect(a.summary).toMatch(/no physical deviation/i);
  });

  it('gives ATT&CK context only as context, with verified IDs and a caveat', () => {
    const rig = boot();
    rig.adapter.trigger('ot-remote-access');
    rig.run(120);
    const ev = rig.core.cyber!.events;
    expect(ev.find((e) => e.ruleId === 'ENG-SESSION')!.attack.map((t) => t.techniqueId)).toEqual(['T0859', 'T0886']);
    expect(ev.find((e) => e.ruleId === 'CONDUIT')!.attack.map((t) => t.techniqueId)).toEqual(['T0822']);
    expect(ev.find((e) => e.ruleId === 'AUTH-BURST')!.attack).toHaveLength(0);
    for (const e of ev) if (e.attack.length > 0) expect(e.limitations.join(' ')).toMatch(/does not establish that an adversary/);
    for (const e of ev) expect(e.limitations.length, e.ruleId).toBeGreaterThan(0);
  });
});

describe('Scenario C: unapproved fan-speed change (cyber-physical)', () => {
  it('links the change to the physical incident through declared relationships and supports it, without claiming intent', () => {
    const rig = boot();
    rig.adapter.trigger('cp-fan-setpoint');
    rig.run(180);
    const change = rig.core.cyber!.events.find((e) => e.ruleId === 'UNAPPROVED-CHANGE')!;
    expect(change).toBeDefined();
    expect(change.attack.map((t) => t.techniqueId)).toEqual(['T0836']);
    expect(change.evidence.mismatch).toMatch(/vendor\.remote is not eng\.controls/);
    expect(rig.core.intelligence.incidents()).toHaveLength(1);
    const inc = byOrigin(rig, 'CT-401')!;
    expect(inc).toBeDefined();
    const a = rig.core.assessIncident(inc.id)!;
    expect(a.standing).toBe('control_change_supported');
    expect(a.headline).toMatch(/not established/);
    expect(a.links.some((l) => l.eventId === change.id && l.relation.startsWith('PLC-500 controls'))).toBe(true);
    const cc = a.explanations.find((x) => x.key === 'control_change')!;
    expect(cc.status).toBe('supported');
    expect(cc.criteria.every((k) => k.observed)).toBe(true);
    expect(a.explanations.find((x) => x.key === 'equipment')!.status).toBe('not_supported');
    expect(a.unknowns.join(' ')).toMatch(/not established by the account name/);
    // The deterministic incident itself is untouched by the assessment.
    expect(inc.hypotheses.every((h) => h.disposition === 'unverified')).toBe(true);
  });

  it('treats an approved change as authorised, raises no security alert for it, and still explains the physical effect', () => {
    const rig = boot();
    rig.adapter.trigger('cp-approved-tuning');
    rig.run(180);
    expect(rules(rig)).toEqual(['APPROVED-CHANGE']);
    expect(rig.core.cyber!.events[0].changeRecordId).toBe('CHG-1042');
    expect(rig.core.cyber!.cases).toHaveLength(0);
    const inc = byOrigin(rig, 'CT-401')!;
    expect(inc).toBeDefined();
    expect(rig.core.assessIncident(inc.id)!.standing).toBe('authorized_change_supported');
  });
});

describe('epistemic discipline', () => {
  it('a physical anomaly does not imply cyber activity: pump fault alone is physical, and missing evidence is acknowledged', () => {
    const rig = boot();
    rig.adapter.trigger('pump-bearing');
    rig.run(150);
    const a = rig.core.assessIncident(rig.incident()!.id)!;
    expect(a.standing).toBe('physical_supported');
    expect(a.consideredEventIds).toHaveLength(0);
    expect(a.unknowns.join(' ')).toMatch(/absence of evidence is not evidence of absence/);
  });

  it('a cyber event does not establish causality: concurrent suspicious access is not linked to an unrelated pump fault', () => {
    const rig = boot();
    rig.adapter.trigger('pump-bearing');
    rig.adapter.trigger('ot-remote-access');
    rig.run(150);
    const pump = byOrigin(rig, 'P-101')!;
    const a = rig.core.assessIncident(pump.id)!;
    expect(a.links).toHaveLength(0);
    expect(['correlated_not_causal', 'physical_supported']).toContain(a.standing);
    expect(a.explanations.find((x) => x.key === 'unrelated_cyber')?.status).toBe('supported');
  });

  it('a change made after the physical onset cannot explain it', () => {
    const rig = boot();
    rig.adapter.trigger('cooling-fan');
    rig.run(30);
    const t = rig.core.now;
    // A late, unapproved write recorded directly (it does not reach the process model).
    rig.core.ingestSecurity([
      { type: 'plc_audit', t, plcId: 'PLC-500', action: 'parameter_write', parameterId: 'PLC-500:CT401_FAN_SPEED_SP', oldValue: 100, newValue: 35, identity: 'vendor.remote', srcHost: 'EWS-01' },
    ]);
    rig.run(60);
    const a = rig.core.assessIncident(byOrigin(rig, 'CT-401')!.id)!;
    expect(a.standing).not.toBe('control_change_supported');
    const cc = a.explanations.find((x) => x.key === 'control_change')!;
    expect(cc.status).toBe('not_supported');
    expect(cc.criteria.find((k) => k.description.startsWith('The change preceded'))!.observed).toBe(false);
  });

  // Regression (found by the independent evaluation, IND-05): an approved change started
  // the deviation, then the same setting was pushed below the approved range.
  it('does not hide a later unapproved change behind an approved one that started the deviation', () => {
    const rig = boot();
    const write = { plcId: 'PLC-500', parameterId: 'PLC-500:CT401_FAN_SPEED_SP', identity: 'eng.controls', srcHost: 'EWS-01' };
    rig.adapter.engineeringWrite({ ...write, oldValue: 100, newValue: 60 });
    rig.run(60);
    rig.adapter.engineeringWrite({ ...write, oldValue: 60, newValue: 40 });
    rig.run(60);
    expect(rules(rig)).toEqual(expect.arrayContaining(['APPROVED-CHANGE', 'UNAPPROVED-CHANGE']));
    const a = rig.core.assessIncident(byOrigin(rig, 'CT-401')!.id)!;
    expect(a.standing).toBe('control_change_supported');
    expect(a.headline).toMatch(/deepened it/);
    expect(a.explanations.find((x) => x.key === 'authorized_change')?.status).toBe('supported');
    expect(a.explanations.find((x) => x.key === 'control_change')?.status).toBe('supported');
    expect(a.nextSteps.join(' ')).toMatch(/beyond the approved range/);
  });

  it('an independent equipment fault keeps the physical explanation open even when a change came first', () => {
    const rig = boot();
    rig.adapter.trigger('cp-fan-setpoint');
    rig.run(32);
    rig.adapter.trigger('cooling-fan');
    rig.run(90);
    const a = rig.core.assessIncident(byOrigin(rig, 'CT-401')!.id)!;
    expect(a.standing).toBe('multiple_plausible');
    expect(a.explanations.find((x) => x.key === 'equipment')!.criteria.find((k) => k.description.startsWith('A trip'))!.observed).toBe(true);
  });

  it('assessment is read-only: it never changes an incident or an operator verdict', () => {
    const rig = boot();
    rig.adapter.trigger('cp-fan-setpoint');
    rig.run(150);
    const inc = byOrigin(rig, 'CT-401')!;
    rig.core.intelligence.setDisposition(inc.id, inc.hypotheses[0].key, 'ruled_out', rig.core.now);
    const before = JSON.stringify(inc);
    rig.core.assessIncident(inc.id);
    expect(JSON.stringify(inc)).toBe(before);
    expect(inc.hypotheses[0].disposition).toBe('ruled_out');
  });
});

describe('reset, repeatability and safety', () => {
  it('re-running the flagship scenario after a reset gives the same events and the same conclusion', () => {
    const rig = boot();
    const once = () => {
      rig.adapter.trigger('cp-fan-setpoint');
      rig.run(150);
      const inc = byOrigin(rig, 'CT-401')!;
      return { events: rig.core.cyber!.events.map((e) => `${e.id}:${e.ruleId}:${e.t}`), standing: rig.core.assessIncident(inc.id)!.standing, origin: inc.origin?.assetId };
    };
    const first = once();
    rig.core.reset();
    expect(rig.core.cyber!.events).toHaveLength(0);
    rig.run(120);
    expect(once()).toEqual(first);
  });

  it('existing physical scenarios are unchanged by the cyber layer (bit-identical telemetry)', () => {
    const a = boot();
    a.adapter.trigger('pump-bearing');
    a.run(60);
    const b = boot();
    b.adapter.trigger('pump-bearing');
    b.run(60);
    for (const s of a.core.signals) expect(a.core.telemetry.latest(s.id)).toBe(b.core.telemetry.latest(s.id));
    expect(a.core.cyber!.events).toHaveLength(0);
  });

  it('no code outside the simulator can write a controller setting', () => {
    const root = join(process.cwd(), 'src');
    const offenders: string[] = [];
    for (const f of readdirSync(root, { recursive: true }) as string[]) {
      // The simulator, its adapter and the evaluation harness (which drives the simulated
      // world) may write controller settings; the engines, runtime and UI may not.
      if (!/\.(ts|tsx)$/.test(f) || f.endsWith('.test.ts') || /^(simulation|adapters|eval)[\\/]/.test(f)) continue;
      if (/setControlParameter|applyControl|engineeringWrite|setSensorFault/.test(readFileSync(join(root, f), 'utf8'))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
