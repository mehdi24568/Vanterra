/**
 * Independent evaluation.
 *
 * Scenarios and their ground truth live in eval/independent/scenarios.json, written by
 * an author who worked only from eval/independent/AUTHORING_BRIEF.md and catalog.json
 * (facts about the plant), without access to the detection or reasoning code.
 *
 * This file only runs those scenarios and compares the system's outputs with the truth.
 * Outputs are recorded separately (eval/results/independent.json). Nothing here may be
 * tuned to make a scenario pass: a failure is reported, investigated in the product,
 * and fixed there with a regression test.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CpStanding } from '../cyber/assess';
import type { SecurityRecord } from '../cyber/types';
import type { Rig } from '../runtime/testHarness';
import { boot } from '../runtime/testHarness';
import { pct, table, writeResults } from './results';

/** Five seeds not used anywhere else in the evaluation. */
export const INDEPENDENT_SEEDS = [20260112, 11, 23, 37, 41];

const STANDINGS = ['physical_supported', 'control_change_supported', 'authorized_change_supported', 'possible_relationship', 'correlated_not_causal', 'multiple_plausible', 'insufficient_evidence'] as const;
const Standing = z.enum(STANDINGS);
const FLAG_RULE: Record<string, string> = {
  failed_logons: 'AUTH-BURST',
  out_of_window_session: 'ENG-SESSION',
  segmentation_violation: 'CONDUIT',
  new_communication: 'FIRST-SEEN',
  unapproved_change: 'UNAPPROVED-CHANGE',
  approved_change: 'APPROVED-CHANGE',
};
const Flag = z.enum(Object.keys(FLAG_RULE) as [string, ...string[]]);

const Record_ = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('auth'), host: z.string(), identity: z.string(), result: z.enum(['success', 'failure']), method: z.enum(['local', 'remote']), srcHost: z.string().nullable().optional() }),
  z.object({ kind: z.literal('flow'), src: z.string(), dst: z.string(), protocol: z.string(), bytes: z.number().optional() }),
  z.object({ kind: z.literal('logoff'), host: z.string(), identity: z.string() }),
  z.object({
    kind: z.literal('controllerAudit'),
    plcId: z.string(),
    action: z.enum(['parameter_write', 'program_upload', 'program_download', 'mode_change']),
    parameterId: z.string().nullable().optional(),
    oldValue: z.number().nullable().optional(),
    newValue: z.number().nullable().optional(),
    identity: z.string(),
    srcHost: z.string(),
  }),
]);

const Action = z.discriminatedUnion('type', [
  z.object({ atS: z.number().min(0), type: z.literal('builtin'), id: z.string() }),
  z.object({ atS: z.number().min(0), type: z.literal('sensorFault'), signalId: z.string(), bias: z.number().optional(), driftPerMin: z.number().optional() }),
  z.object({ atS: z.number().min(0), type: z.literal('security'), records: z.array(Record_) }),
  z.object({ atS: z.number().min(0), type: z.literal('engineeringWrite'), plcId: z.string(), parameterId: z.string(), oldValue: z.number(), newValue: z.number(), identity: z.string(), srcHost: z.string() }),
]);

const Scenario = z.object({
  id: z.string(),
  category: z.string(),
  title: z.string(),
  narrative: z.string(),
  durationS: z.number().min(60).max(900),
  actions: z.array(Action),
  truth: z.object({
    physicalIncidents: z.array(
      z.object({
        originAnyOf: z.array(z.string()).min(1),
        acceptableConclusions: z.array(Standing),
        forbiddenConclusions: z.array(Standing).default([]),
        note: z.string().optional(),
      }),
    ),
    maxPhysicalIncidents: z.number().int().min(0).optional(),
    minPhysicalIncidents: z.number().int().min(0).optional(),
    cyber: z.object({ expectNotableActivity: z.boolean().optional(), expectedFlags: z.array(Flag).default([]), forbiddenFlags: z.array(Flag).default([]) }).default({ expectedFlags: [], forbiddenFlags: [] }),
    rationale: z.string(),
  }),
});
const File = z.object({ author: z.string().optional(), scenarios: z.array(Scenario).min(1) });
type Scenario = z.infer<typeof Scenario>;

const CYBER_CAUSE: CpStanding[] = ['control_change_supported', 'authorized_change_supported', 'multiple_plausible'];
const NOT_CYBER: CpStanding[] = ['physical_supported', 'correlated_not_causal', 'insufficient_evidence'];
const UNCERTAIN: CpStanding[] = ['possible_relationship', 'correlated_not_causal', 'multiple_plausible', 'insufficient_evidence'];

function toRecord(r: z.infer<typeof Record_>): SecurityRecord {
  switch (r.kind) {
    case 'auth':
      return { type: 'auth', t: 0, host: r.host, identity: r.identity, result: r.result, method: r.method, srcHost: r.srcHost ?? null };
    case 'flow':
      return { type: 'flow', t: 0, src: r.src, dst: r.dst, protocol: r.protocol, bytes: r.bytes ?? 10_000 };
    case 'logoff':
      return { type: 'logoff', t: 0, host: r.host, identity: r.identity };
    case 'controllerAudit':
      return { type: 'plc_audit', t: 0, plcId: r.plcId, action: r.action, parameterId: r.parameterId ?? null, oldValue: r.oldValue ?? null, newValue: r.newValue ?? null, identity: r.identity, srcHost: r.srcHost };
  }
}

function runScenario(s: Scenario, seed: number): Rig {
  const rig = boot(seed);
  const actions = [...s.actions].sort((a, b) => a.atS - b.atS);
  let t = 0;
  for (const a of actions) {
    if (a.atS > t) rig.run(a.atS - t);
    t = Math.max(t, a.atS);
    switch (a.type) {
      case 'builtin':
        rig.adapter.trigger(a.id);
        break;
      case 'sensorFault':
        rig.adapter.setSensorFault(a.signalId, { bias: a.bias, driftPerMin: a.driftPerMin });
        break;
      case 'security':
        rig.adapter.injectSecurity(a.records.map(toRecord));
        break;
      case 'engineeringWrite':
        rig.adapter.engineeringWrite(a);
        break;
    }
  }
  if (s.durationS > t) rig.run(s.durationS - t);
  return rig;
}

interface IncidentOut {
  id: string;
  origin: string | null;
  lead: string | null;
  severity: string;
  assets: string[];
  standing: CpStanding | null;
  linkedEvents: number;
  minLeadS: number | null;
  /** For change conclusions: a supporting change explanation shows the change preceded the first detection. */
  precedenceShown: boolean;
  ungroundedEvidence: string[];
  confirmedWithoutOperator: boolean;
}

function observe(rig: Rig) {
  const core = rig.core;
  const incidents: IncidentOut[] = core.intelligence.incidents().map((i) => {
    const a = core.assessIncident(i.id);
    const ids = a ? a.explanations.flatMap((x) => x.criteria.flatMap((c) => c.evidence)) : [];
    return {
      id: i.id,
      origin: i.origin?.assetId ?? null,
      lead: i.hypotheses[0]?.templateId ?? null,
      severity: i.severity,
      assets: i.assets.map((x) => x.assetId),
      standing: a?.standing ?? null,
      linkedEvents: a?.links.length ?? 0,
      minLeadS: a && a.links.length ? Math.min(...a.links.map((l) => l.leadS)) : null,
      precedenceShown:
        !!a &&
        a.explanations.some(
          (x) => (x.key === 'control_change' || x.key === 'authorized_change') && x.status === 'supported' && x.criteria.some((c) => c.description.startsWith('The change preceded') && c.observed),
        ),
      ungroundedEvidence: ids.filter((id) => !core.intelligence.anomaly(id) && !core.cyber?.event(id)),
      confirmedWithoutOperator: i.hypotheses.some((h) => h.disposition !== 'unverified'),
    };
  });
  const events = core.cyber?.events ?? [];
  return {
    incidents,
    cyberRules: [...new Set(events.map((e) => e.ruleId))],
    notableCyber: events.filter((e) => e.severity === 'warning' || e.severity === 'critical').length,
    cases: core.cyber?.cases.length ?? 0,
  };
}

function score(s: Scenario, out: ReturnType<typeof observe>) {
  const findings: string[] = [];
  const truthInc = s.truth.physicalIncidents.map((ti) => {
    const match = out.incidents.find((i) => i.origin && ti.originAnyOf.includes(i.origin)) ?? out.incidents.find((i) => i.assets.some((a) => ti.originAnyOf.includes(a)));
    const originCorrect = !!match?.origin && ti.originAnyOf.includes(match.origin);
    const standing = match?.standing ?? null;
    const conclusionCorrect = !!standing && ti.acceptableConclusions.includes(standing);
    const forbidden = !!standing && ti.forbiddenConclusions.includes(standing);
    const truthHasCyberCause = ti.acceptableConclusions.length > 0 && ti.acceptableConclusions.every((c) => CYBER_CAUSE.includes(c));
    const truthNoCyberCause = ti.acceptableConclusions.length > 0 && !ti.acceptableConclusions.some((c) => CYBER_CAUSE.includes(c));
    const truthUncertain = ti.acceptableConclusions.length > 0 && ti.acceptableConclusions.every((c) => UNCERTAIN.includes(c));
    if (!match) findings.push(`no incident for origin ${ti.originAnyOf.join('/')}`);
    else {
      if (!originCorrect) findings.push(`incident ${match.id} origin ${match.origin}, expected ${ti.originAnyOf.join('/')}`);
      if (!conclusionCorrect) findings.push(`incident at ${match.origin}: concluded ${standing}, acceptable ${ti.acceptableConclusions.join('/')}`);
    }
    return {
      found: !!match,
      originCorrect,
      conclusionCorrect,
      forbidden,
      falseCyberAttribution: truthNoCyberCause && !!standing && CYBER_CAUSE.includes(standing),
      missedCyberCause: truthHasCyberCause && !!standing && NOT_CYBER.includes(standing),
      truthUncertain,
      uncertaintyRespected: truthUncertain ? !!standing && UNCERTAIN.includes(standing) : null,
      matchedId: match?.id ?? null,
    };
  });
  const matched = new Set(truthInc.map((t) => t.matchedId).filter(Boolean));
  const extra = out.incidents.filter((i) => !matched.has(i.id));
  const max = s.truth.maxPhysicalIncidents;
  const min = s.truth.minPhysicalIncidents ?? 0;
  const countOk = (max === undefined || out.incidents.length <= max) && out.incidents.length >= min;
  if (!countOk) findings.push(`${out.incidents.length} physical incidents, expected ${min}–${max ?? '∞'}`);
  // Extra incidents with no truth entry must not carry a cyber-cause conclusion either.
  const extraCyberAttribution = extra.filter((i) => i.standing && CYBER_CAUSE.includes(i.standing) && !s.truth.physicalIncidents.some((t) => t.acceptableConclusions.some((c) => CYBER_CAUSE.includes(c))));
  for (const i of extraCyberAttribution) findings.push(`unexpected incident ${i.id} at ${i.origin} concluded ${i.standing}`);

  const expectedRules = s.truth.cyber.expectedFlags.map((f) => FLAG_RULE[f]);
  const forbiddenRules = s.truth.cyber.forbiddenFlags.map((f) => FLAG_RULE[f]);
  const flagsFound = expectedRules.filter((r) => out.cyberRules.includes(r));
  const forbiddenFired = forbiddenRules.filter((r) => out.cyberRules.includes(r));
  for (const r of expectedRules.filter((x) => !out.cyberRules.includes(x))) findings.push(`expected cyber flag ${r} not raised`);
  for (const r of forbiddenFired) findings.push(`forbidden cyber flag ${r} raised`);
  const notableOk = s.truth.cyber.expectNotableActivity === undefined ? true : s.truth.cyber.expectNotableActivity ? out.notableCyber > 0 : out.notableCyber === 0;
  if (!notableOk) findings.push(s.truth.cyber.expectNotableActivity ? 'expected notable cyber activity, none reported' : `${out.notableCyber} warning-level cyber events, expected none`);

  const ungrounded = out.incidents.flatMap((i) => i.ungroundedEvidence);
  if (ungrounded.length) findings.push(`ungrounded evidence IDs: ${ungrounded.join(', ')}`);
  // A change conclusion must rest on a change that came before the first detection. (Metric
  // corrected after the first run: it originally required *every* linked event to precede
  // onset, which wrongly failed correct conclusions when later changes also existed.)
  const temporalViolations = out.incidents.filter((i) => (i.standing === 'control_change_supported' || i.standing === 'authorized_change_supported') && !i.precedenceShown);
  if (temporalViolations.length) findings.push('change conclusion with the change after onset');
  const autoConfirmed = out.incidents.filter((i) => i.confirmedWithoutOperator);
  if (autoConfirmed.length) findings.push('hypothesis confirmed without an operator');

  return {
    truthInc,
    countOk,
    extraIncidents: extra.length,
    extraCyberAttribution: extraCyberAttribution.length,
    flagsExpected: expectedRules.length,
    flagsFound: flagsFound.length,
    forbiddenFired: forbiddenFired.length,
    notableOk,
    ungrounded: ungrounded.length,
    temporalViolations: temporalViolations.length,
    autoConfirmed: autoConfirmed.length,
    pass: findings.length === 0,
    findings,
  };
}

describe('independent evaluation', () => {
  it('runs the independently authored scenarios and writes eval/results/independent.*', () => {
    const raw = JSON.parse(readFileSync(join(process.cwd(), 'eval', 'independent', 'scenarios.json'), 'utf8'));
    const parsed = File.safeParse(raw);
    if (!parsed.success) throw new Error(`scenarios.json does not match the brief's format: ${parsed.error.message}`);
    const scenarios = parsed.data.scenarios;

    const runs = scenarios.flatMap((s) =>
      INDEPENDENT_SEEDS.map((seed) => {
        const out = observe(runScenario(s, seed));
        return { scenario: s.id, category: s.category, seed, outputs: out, score: score(s, out) };
      }),
    );

    const truthIncRuns = runs.flatMap((r) => r.score.truthInc);
    const count = (pred: (x: (typeof truthIncRuns)[number]) => boolean) => truthIncRuns.filter(pred).length;
    const noCyberTruth = runs.flatMap((r) => r.score.truthInc.map((t, i) => ({ t, s: scenarios.find((x) => x.id === r.scenario)!.truth.physicalIncidents[i] }))).filter(({ s }) => !s.acceptableConclusions.some((c) => CYBER_CAUSE.includes(c)));
    const cyberTruth = runs.flatMap((r) => r.score.truthInc.map((t, i) => ({ t, s: scenarios.find((x) => x.id === r.scenario)!.truth.physicalIncidents[i] }))).filter(({ s }) => s.acceptableConclusions.length > 0 && s.acceptableConclusions.every((c) => CYBER_CAUSE.includes(c)));
    const uncertainTruth = truthIncRuns.filter((t) => t.truthUncertain);
    const flagsExpected = runs.reduce((a, r) => a + r.score.flagsExpected, 0);
    const flagsFound = runs.reduce((a, r) => a + r.score.flagsFound, 0);

    const metrics = {
      scenarios: scenarios.length,
      seeds: INDEPENDENT_SEEDS.length,
      runs: runs.length,
      scenarioRunsPassed: runs.filter((r) => r.score.pass).length,
      truthIncidents: truthIncRuns.length,
      incidentDetected: count((t) => t.found),
      originCorrect: count((t) => t.originCorrect),
      conclusionCorrect: count((t) => t.conclusionCorrect),
      forbiddenConclusion: count((t) => t.forbidden),
      falseCyberAttribution: noCyberTruth.filter(({ t }) => t.falseCyberAttribution).length + runs.reduce((a, r) => a + r.score.extraCyberAttribution, 0),
      noCyberTruthCases: noCyberTruth.length,
      missedCyberCause: cyberTruth.filter(({ t }) => t.missedCyberCause).length,
      cyberTruthCases: cyberTruth.length,
      uncertaintyRespected: uncertainTruth.filter((t) => t.uncertaintyRespected).length,
      uncertainTruthCases: uncertainTruth.length,
      incidentCountOk: runs.filter((r) => r.score.countOk).length,
      flagsExpected,
      flagsFound,
      forbiddenFlagsFired: runs.reduce((a, r) => a + r.score.forbiddenFired, 0),
      notableCyberCorrect: runs.filter((r) => r.score.notableOk).length,
      ungroundedEvidence: runs.reduce((a, r) => a + r.score.ungrounded, 0),
      temporalViolations: runs.reduce((a, r) => a + r.score.temporalViolations, 0),
      autoConfirmed: runs.reduce((a, r) => a + r.score.autoConfirmed, 0),
    };

    const perScenario = scenarios.map((s) => {
      const rs = runs.filter((r) => r.scenario === s.id);
      const findings = [...new Set(rs.flatMap((r) => r.score.findings))];
      const observed = [...new Set(rs.flatMap((r) => r.outputs.incidents.map((i) => `${i.origin}:${i.standing}`)))].join(', ') || 'no incident';
      return { id: s.id, category: s.category, title: s.title, passed: rs.filter((r) => r.score.pass).length, runs: rs.length, observed, findings };
    });
    const r = (n: number, d: number) => `${n} / ${d} (${pct(d ? n / d : null)})`;

    const md = `
## Independent evaluation — measured

Generated by \`npm run eval\` on ${new Date().toISOString().slice(0, 10)}. ${scenarios.length} scenarios from \`eval/independent/scenarios.json\` (author: ${parsed.data.author ?? 'unspecified'}), ${INDEPENDENT_SEEDS.length} seeds each (${INDEPENDENT_SEEDS.join(', ')}): ${runs.length} runs.

### Aggregate

| Metric | Result |
|---|---|
| Scenario runs fully matching the ground truth | ${r(metrics.scenarioRunsPassed, metrics.runs)} |
| Expected physical incidents detected | ${r(metrics.incidentDetected, metrics.truthIncidents)} |
| … with the correct origin | ${r(metrics.originCorrect, metrics.truthIncidents)} |
| … with an acceptable cyber-physical conclusion | ${r(metrics.conclusionCorrect, metrics.truthIncidents)} |
| Forbidden conclusions reached | ${metrics.forbiddenConclusion} |
| False cyber attribution (truth: no cyber cause) | ${metrics.falseCyberAttribution} in ${metrics.noCyberTruthCases} incident-runs |
| Missed cyber cause (truth: a change caused it) | ${metrics.missedCyberCause} in ${metrics.cyberTruthCases} incident-runs |
| Uncertainty respected (truth: only uncertain conclusions acceptable) | ${r(metrics.uncertaintyRespected, metrics.uncertainTruthCases)} |
| Incident count within the truth's bounds | ${r(metrics.incidentCountOk, metrics.runs)} |
| Expected cyber flags raised | ${r(metrics.flagsFound, metrics.flagsExpected)} |
| Forbidden cyber flags raised | ${metrics.forbiddenFlagsFired} |
| Notable-cyber-activity expectation met | ${r(metrics.notableCyberCorrect, metrics.runs)} |
| Ungrounded evidence IDs in assessments | ${metrics.ungroundedEvidence} |
| Change conclusions not resting on a change that preceded onset | ${metrics.temporalViolations} |
| Hypotheses confirmed without an operator | ${metrics.autoConfirmed} |

### Per scenario

${table(
  ['Scenario', 'Category', 'Title', 'Runs matching truth', 'System output (origin:conclusion)', 'Differences from truth'],
  perScenario.map((p) => [p.id, p.category, p.title, `${p.passed}/${p.runs}`, p.observed, p.findings.length ? p.findings.join('; ') : '—']),
)}
`;
    writeResults('independent', { generated: new Date().toISOString(), seeds: INDEPENDENT_SEEDS, metrics, perScenario, runs }, md);
    console.log(md);
    expect(runs.length).toBe(scenarios.length * INDEPENDENT_SEEDS.length);
  });
});
