/**
 * The plain-language briefing: everyday words, grounded statements, the right answer to
 * "should this become a cyber investigation?", and no claims the assessment does not make.
 */
import { describe, expect, it } from 'vitest';
import type { Incident } from '../core/types';
import { boot } from '../runtime/testHarness';
import type { Rig } from '../runtime/testHarness';
import type { Briefing } from './briefing';

const byOrigin = (rig: Rig, assetId: string): Incident => rig.core.intelligence.incidents().find((i) => i.origin?.assetId === assetId)!;

/** Words a non-specialist should not need in the headline answers. */
const JARGON = /\b(PLC|HMI|EWS|SCADA|CEV-|ANM-|CYB-|ATT&CK|T0\d{3}|standing|criteri|anomal|telemetry|z-score|σ)\b/i;
/** Claims the deterministic assessment never makes. */
const OVERREACH = /\b(attack(er|ed)?|hack(er|ed)?|definitely|certainly|proves?|caused by|guaranteed|probabl[ey]|\d+\s?%)\b/i;

function statements(b: Briefing) {
  return [...b.known, ...b.suggests];
}

function expectGrounded(rig: Rig, inc: Incident, b: Briefing) {
  const anomalyIds = new Set(inc.anomalyIds);
  const eventIds = new Set(rig.core.cyber!.events.map((e) => e.id));
  for (const s of statements(b)) {
    for (const id of s.evidence) expect(anomalyIds.has(id) || eventIds.has(id), `${id} in "${s.text}"`).toBe(true);
    expect(s.text, s.text).not.toMatch(OVERREACH);
  }
  for (const text of [b.inShort, b.cyberInvestigation.label, b.cyberInvestigation.reason]) {
    expect(text, text).not.toMatch(JARGON);
    expect(text, text).not.toMatch(OVERREACH);
  }
  // Every observation (except the explicit "nothing recorded" fact) points at evidence,
  // uses everyday words, and is said once.
  for (const s of b.known) {
    if (!/^No security events were recorded/.test(s.text)) expect(s.evidence.length, s.text).toBeGreaterThan(0);
    expect(s.text, s.text).not.toMatch(JARGON);
  }
  expect(new Set(b.known.map((s) => s.text)).size).toBe(b.known.length);
}

describe('plain-language briefing', () => {
  it('flagship: recommends a cyber investigation, names the account and the missing approval, and does not claim intent', () => {
    const rig = boot();
    rig.adapter.trigger('cp-fan-setpoint');
    rig.run(180);
    const inc = byOrigin(rig, 'CT-401');
    const b = rig.core.briefIncident(inc.id)!;
    expect(b.standing).toBe('control_change_supported');
    expect(b.cyberInvestigation.answer).toBe('yes');
    expect(b.inShort).toMatch(/without an approved change record/);
    expect(b.inShort).toMatch(/Whether anyone meant harm is not known/);
    const change = rig.core.cyber!.events.find((e) => e.ruleId === 'UNAPPROVED-CHANGE')!;
    const fact = b.known.find((s) => s.evidence.includes(change.id))!;
    expect(fact.text).toMatch(/account "vendor\.remote"/);
    expect(fact.text).toMatch(/before the first unusual reading/);
    expect(fact.text).toMatch(/No approved change record covers it/);
    expect(b.suggests[0].text).toMatch(/supports a settings change/);
    expect(b.notKnown.length).toBeGreaterThan(0);
    expect(b.toSettle.length).toBeGreaterThan(0);
    expectGrounded(rig, inc, b);
  });

  it('a pump fault alone: no cyber investigation, and says the absence of evidence is not proof', () => {
    const rig = boot();
    rig.adapter.trigger('pump-bearing');
    rig.run(150);
    const inc = rig.incident()!;
    const b = rig.core.briefIncident(inc.id)!;
    expect(b.cyberInvestigation.answer).toBe('no');
    expect(b.cyberInvestigation.reason).toMatch(/absence of evidence, not proof/);
    expect(b.inShort).toMatch(/equipment or process problem/);
    expect(b.known.some((s) => /No security events were recorded/.test(s.text))).toBe(true);
    expectGrounded(rig, inc, b);
  });

  it('unrelated suspicious access during a pump fault: never recommends treating it as the cause', () => {
    const rig = boot();
    rig.adapter.trigger('pump-bearing');
    rig.adapter.trigger('ot-remote-access');
    rig.run(150);
    const inc = byOrigin(rig, 'P-101');
    const b = rig.core.briefIncident(inc.id)!;
    expect(['separately', 'no']).toContain(b.cyberInvestigation.answer);
    expect(b.known.some((s) => /none of them on the controller of this equipment/.test(s.text))).toBe(true);
    expect(b.suggests.some((s) => /not connected to this equipment/.test(s.text))).toBe(true);
    expectGrounded(rig, inc, b);
  });

  it('an approved change: not a security matter on this evidence, and cites the change record', () => {
    const rig = boot();
    rig.adapter.trigger('cp-approved-tuning');
    rig.run(180);
    const inc = byOrigin(rig, 'CT-401');
    const b = rig.core.briefIncident(inc.id)!;
    expect(b.cyberInvestigation.answer).toBe('no');
    expect(b.cyberInvestigation.label).toMatch(/approved change/);
    expect(b.known.some((s) => /matches approved change record CHG-1042/.test(s.text))).toBe(true);
    expectGrounded(rig, inc, b);
  });

  it('an equipment fault after a change keeps both explanations open and asks for both checks', () => {
    const rig = boot();
    rig.adapter.trigger('cp-fan-setpoint');
    rig.run(32);
    rig.adapter.trigger('cooling-fan');
    rig.run(90);
    const inc = byOrigin(rig, 'CT-401');
    const b = rig.core.briefIncident(inc.id)!;
    expect(b.standing).toBe('multiple_plausible');
    expect(b.cyberInvestigation.label).toMatch(/alongside an equipment check/);
    expectGrounded(rig, inc, b);
  });

  it('is read-only: briefing never changes the incident', () => {
    const rig = boot();
    rig.adapter.trigger('cp-fan-setpoint');
    rig.run(150);
    const inc = byOrigin(rig, 'CT-401');
    const before = JSON.stringify(inc);
    rig.core.briefIncident(inc.id);
    expect(JSON.stringify(inc)).toBe(before);
  });
});
