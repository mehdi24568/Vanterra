/**
 * Cyber-physical evaluation: cyber detection, false positives, and whether the
 * deterministic cyber-physical assessment reaches the conclusion the evidence warrants
 * - including the cases where the right answer is "not cyber" or "cannot tell".
 *
 * Ground truth is the scenario design. The cyber scripts are deterministic; seeds vary
 * the physical process noise, flow volumes and therefore detection timing.
 * Results: eval/results/cyber.{json,md}.
 */
import { describe, expect, it } from 'vitest';
import type { CpStanding } from '../cyber/assess';
import type { Rig } from '../runtime/testHarness';
import { boot } from '../runtime/testHarness';
import { EVAL_SEEDS } from './groundTruth';
import { pct, stats, num, table, writeResults } from './results';

interface Case {
  id: string;
  description: string;
  /** Conclusions that are correct for this case. */
  acceptable: CpStanding[];
  /** Origin asset whose incident is assessed; null for cyber-only cases. */
  origin: string | null;
  /** True when the right answer involves the cyber evidence explaining the physical deviation. */
  cyberCause: boolean;
  run: (rig: Rig) => void;
}

const CASES: Case[] = [
  {
    id: 'A',
    description: 'Physical fault only (pump bearing)',
    acceptable: ['physical_supported'],
    origin: 'P-101',
    cyberCause: false,
    run: (r) => {
      r.adapter.trigger('pump-bearing');
      r.run(150);
    },
  },
  {
    id: 'A+B',
    description: 'Physical fault with unrelated suspicious access',
    acceptable: ['physical_supported', 'correlated_not_causal'],
    origin: 'P-101',
    cyberCause: false,
    run: (r) => {
      r.adapter.trigger('pump-bearing');
      r.adapter.trigger('ot-remote-access');
      r.run(150);
    },
  },
  {
    id: 'C',
    description: 'Unapproved fan-speed change (flagship)',
    acceptable: ['control_change_supported'],
    origin: 'CT-401',
    cyberCause: true,
    run: (r) => {
      r.adapter.trigger('cp-fan-setpoint');
      r.run(150);
    },
  },
  {
    id: 'C′',
    description: 'Approved fan-drive tuning',
    acceptable: ['authorized_change_supported'],
    origin: 'CT-401',
    cyberCause: true,
    run: (r) => {
      r.adapter.trigger('cp-approved-tuning');
      r.run(150);
    },
  },
  {
    id: 'trip+late change',
    description: 'Fan trip, then an unapproved change after onset',
    acceptable: ['physical_supported', 'possible_relationship', 'correlated_not_causal'],
    origin: 'CT-401',
    cyberCause: false,
    run: (r) => {
      r.adapter.trigger('cooling-fan');
      r.run(30);
      r.core.ingestSecurity([
        { type: 'plc_audit', t: r.core.now, plcId: 'PLC-500', action: 'parameter_write', parameterId: 'PLC-500:CT401_FAN_SPEED_SP', oldValue: 100, newValue: 35, identity: 'vendor.remote', srcHost: 'EWS-01' },
      ]);
      r.run(60);
    },
  },
  {
    id: 'change+trip',
    description: 'Unapproved change, then an independent fan trip',
    acceptable: ['multiple_plausible'],
    origin: 'CT-401',
    cyberCause: true,
    run: (r) => {
      r.adapter.trigger('cp-fan-setpoint');
      r.run(32);
      r.adapter.trigger('cooling-fan');
      r.run(90);
    },
  },
];

const B_RULES = ['AUTH-BURST', 'ENG-SESSION', 'FIRST-SEEN', 'CONTROLLER-READ', 'CONDUIT'];

describe('cyber-physical evaluation', () => {
  it('measures detection, false positives and conclusions over ten seeds, and writes eval/results/cyber.*', () => {
    // Normal operation: cyber false positives.
    let normalHours = 0;
    let normalNotable = 0;
    let normalCases = 0;
    for (const seed of EVAL_SEEDS) {
      const r = boot(seed);
      r.run(1800);
      normalHours += 0.5;
      normalNotable += r.core.cyber!.events.filter((e) => e.severity !== 'info').length;
      normalCases += r.core.cyber!.cases.length;
    }

    // Scenario B: cyber detection on its own.
    const bRuns = EVAL_SEEDS.map((seed) => {
      const r = boot(seed);
      const t0 = r.core.now;
      r.adapter.trigger('ot-remote-access');
      r.run(150);
      const fired = new Set(r.core.cyber!.events.map((e) => e.ruleId));
      const firstWarn = r.core.cyber!.events.find((e) => e.severity !== 'info' && e.severity !== 'advisory');
      const c = r.core.cyber!.cases[0];
      return {
        seed,
        rulesFired: B_RULES.filter((x) => fired.has(x)).length,
        cases: r.core.cyber!.cases.length,
        physicalIncidents: r.core.intelligence.incidents().length,
        physicalEffectClaimed: c ? r.core.assessCyberCase(c.id)!.physicalEffectObserved : false,
        firstWarningS: firstWarn ? (firstWarn.t - t0) / 1000 : null,
      };
    });

    // Assessment cases.
    const runs = CASES.flatMap((k) =>
      EVAL_SEEDS.map((seed) => {
        const r = boot(seed);
        const t0 = r.core.now;
        k.run(r);
        const inc = r.core.intelligence.incidents().find((i) => i.origin?.assetId === k.origin);
        const a = inc ? r.core.assessIncident(inc.id) : null;
        const change = r.core.cyber!.events.find((e) => e.ruleId === 'UNAPPROVED-CHANGE' || e.ruleId === 'APPROVED-CHANGE');
        return {
          case: k.id,
          seed,
          incidentFound: !!inc,
          standing: a?.standing ?? null,
          correct: !!a && k.acceptable.includes(a.standing),
          misattribution: !k.cyberCause && !!a && ['control_change_supported', 'authorized_change_supported', 'multiple_plausible'].includes(a.standing),
          missedCause: k.cyberCause && !!a && ['physical_supported', 'correlated_not_causal', 'insufficient_evidence'].includes(a.standing),
          unknownsStated: !!a && a.unknowns.length > 0,
          changeToIncidentS: change && inc ? (inc.openedAt - change.t) / 1000 : null,
          changeDetectedS: change ? (change.t - t0) / 1000 : null,
          incidentUnchanged: !!inc && inc.hypotheses.every((h) => h.disposition === 'unverified'),
        };
      }),
    );

    const per = CASES.map((k) => {
      const rows = runs.filter((x) => x.case === k.id);
      const standings = [...new Set(rows.map((x) => x.standing))].join(', ');
      return {
        case: k.id,
        description: k.description,
        expected: k.acceptable.join(' or '),
        runs: rows.length,
        incidentFound: rows.filter((x) => x.incidentFound).length,
        correct: rows.filter((x) => x.correct).length,
        misattribution: rows.filter((x) => x.misattribution).length,
        missedCause: rows.filter((x) => x.missedCause).length,
        observed: standings,
        changeToIncident: stats(rows.flatMap((x) => (x.changeToIncidentS === null ? [] : [x.changeToIncidentS]))),
      };
    });
    const totalRuns = runs.length;
    const correct = runs.filter((x) => x.correct).length;
    const misattrib = runs.filter((x) => x.misattribution).length;
    const missed = runs.filter((x) => x.missedCause).length;

    const md = `
## Cyber-physical evaluation — measured

Generated by \`npm run eval\` on ${new Date().toISOString().slice(0, 10)}. Seeds: ${EVAL_SEEDS.join(', ')}. The cyber scripts are deterministic; seeds vary physical noise, flow volumes and detection timing.

### Cyber detection

| Measure | Result |
|---|---|
| Notable cyber events in normal operation | ${normalNotable} in ${num(normalHours, 1)} simulated hours (${normalCases} cases) |
| Scenario B: expected rules fired (${B_RULES.join(', ')}) | ${bRuns.reduce((a, r) => a + r.rulesFired, 0)} / ${B_RULES.length * bRuns.length} |
| Scenario B: grouped into one case | ${bRuns.filter((r) => r.cases === 1).length} / ${bRuns.length} |
| Scenario B: physical incidents opened / physical effect claimed | ${bRuns.reduce((a, r) => a + r.physicalIncidents, 0)} / ${bRuns.filter((r) => r.physicalEffectClaimed).length} |
| Scenario B: first warning-level event after start (median s) | ${num(stats(bRuns.flatMap((r) => (r.firstWarningS === null ? [] : [r.firstWarningS]))).median)} |

### Cyber-physical conclusions

${table(
  ['Case', 'Description', 'Correct conclusion', 'Incident found', 'Correct', 'Wrongly attributed to cyber', 'Cyber cause missed', 'Conclusions observed', 'Change → incident s (median)'],
  per.map((p) => [p.case, p.description, p.expected, `${p.incidentFound}/${p.runs}`, `${p.correct}/${p.runs}`, p.misattribution, p.missedCause, p.observed, num(p.changeToIncident.median)]),
)}

Overall: **${correct} of ${totalRuns}** runs reached a correct conclusion (${pct(correct / totalRuns)}); **${misattrib}** physical-only runs were wrongly attributed to a cyber cause; **${missed}** runs with a real control change missed it. Unknowns were stated in ${runs.filter((x) => x.unknownsStated).length} of ${runs.filter((x) => x.standing).length} assessments. No assessment changed an incident or a disposition (${runs.filter((x) => x.incidentFound && !x.incidentUnchanged).length} violations).
`;
    writeResults('cyber', { generated: new Date().toISOString(), seeds: EVAL_SEEDS, normal: { hours: normalHours, notable: normalNotable, cases: normalCases }, scenarioB: bRuns, summary: per, runs }, md);
    console.log(md);
    expect(runs).toHaveLength(CASES.length * EVAL_SEEDS.length);
  });
});
