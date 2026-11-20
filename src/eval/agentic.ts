/**
 * Shared scoring for the agent-layer evaluation (offline and live).
 *
 * Scoring compares an investigation report with three references:
 *   - the injected fault (ground truth: correct origin and mechanism),
 *   - the deterministic engine's own result (origin, leading hypothesis, exposure),
 *   - the evidence catalogue the model was given (for citation validity).
 * No human study was run; the injected fault stands in for a verified human verdict.
 */
import { buildInvestigationContext } from '../agents/buildContext';
import type { InvestigationContext } from '../agents/context';
import type { InvestigationReport } from '../agents/report';
import type { Incident } from '../core/types';
import { boot, TEST_SEED } from '../runtime/testHarness';
import type { FaultTruth } from './groundTruth';

export const INVESTIGATE_AFTER_S = 150;

export function scenarioCase(truth: FaultTruth, seed = TEST_SEED): { incident: Incident; ctx: InvestigationContext; before: string } {
  const rig = boot(seed);
  rig.adapter.trigger(truth.scenario);
  rig.run(INVESTIGATE_AFTER_S);
  const incident = rig.core.intelligence.incidents().find((i) => i.origin?.assetId === truth.origin) ?? rig.incident()!;
  const ctx = buildInvestigationContext(rig.core, incident);
  return { incident, ctx, before: JSON.stringify(incident.hypotheses) };
}

export function scoreReport(report: InvestigationReport, incident: Incident, truth: FaultTruth, before: string) {
  const templateOf = (key: string | null | undefined) => incident.hypotheses.find((h) => h.key === key)?.templateId ?? null;
  const truthKey = incident.hypotheses.find((h) => h.templateId === truth.leadTemplate)?.key ?? null;
  const deterministicLead = incident.hypotheses[0]?.templateId ?? null;
  const issues = report.audit.flatMap((a) => a.issues);
  const count = (code: string) => issues.filter((i) => i.code === code).length;
  const attempted = Object.values(report.agents).filter((a) => a.attempts > 0);

  const orch = report.agents.orchestrator.output;
  const hyp = report.agents.hypothesis_analyst.output;
  const impact = report.agents.impact_analyst.output;
  const plan = report.agents.investigation_planner.output;

  const deterministicAtRisk = new Set(incident.impact.filter((i) => i.state === 'at_risk').map((i) => i.assetId));
  const aiExposed = new Set([...(impact?.potentiallyAffected.map((p) => p.assetId) ?? []), ...(impact?.directlyAbnormal.map((p) => p.assetId) ?? [])]);
  const checks = plan?.checks ?? [];

  return {
    scenario: truth.scenario,
    provider: report.provider,
    model: report.model,
    testDouble: report.testDouble,
    status: report.status,
    agents: Object.fromEntries(Object.entries(report.agents).map(([k, a]) => [k, { status: a.status, attempts: a.attempts, latencyMs: a.latencyMs, error: a.error?.kind ?? null }])),
    durationS: report.durationMs / 1000,
    modelCalls: report.governance.modelCalls,
    repairs: attempted.reduce((n, a) => n + Math.max(0, a.attempts - 1), 0),
    inputTokens: report.usage.inputTokens,
    outputTokens: report.usage.outputTokens,
    estimatedCostUsd: report.estimatedCostUsd,
    // Grounding, measured on every model answer including ones later repaired.
    citationsAccepted: report.governance.citations,
    invalidCitationsInRawAnswers: count('unknown_evidence'),
    unknownAssetsInRawAnswers: count('unknown_asset'),
    unknownHypothesesInRawAnswers: count('unknown_hypothesis'),
    uncitedObservationsInRawAnswers: count('missing_citation'),
    certaintyOrProbabilityWording: count('certainty_language') + count('probability_language'),
    causalOverreachInRawAnswers: count('causal_overreach'),
    /** Every validation issue raised on any answer, by code: why answers were repaired or trimmed. */
    issueCodes: issues.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.code]: (acc[i.code] ?? 0) + 1 }), {}),
    /** Cyber events (CEV-…) cited in accepted output. */
    cyberCitationsAccepted: Object.values(report.agents).flatMap((a) => a.cited).filter((id) => String(id).startsWith('CEV-')).length,
    schemaFailures: count('schema'),
    claimsChecked: report.governance.claims,
    claimsRejected: report.governance.claimsRejected,
    unsupportedClaimRate: report.governance.claims ? report.governance.claimsRejected / report.governance.claims : null,
    figuresFlagged: report.governance.figuresFlagged,
    // Reasoning quality against ground truth and against the deterministic engine.
    aiLead: templateOf(orch?.leadingHypothesisKey ?? hyp?.leadingHypothesisKey ?? null),
    deterministicLead,
    truthLead: truth.leadTemplate,
    aiLeadMatchesTruth: templateOf(orch?.leadingHypothesisKey ?? hyp?.leadingHypothesisKey ?? null) === truth.leadTemplate,
    deterministicLeadMatchesTruth: deterministicLead === truth.leadTemplate,
    standing: orch?.standing ?? null,
    truthStance: hyp?.assessments.find((a) => a.hypothesisKey === truthKey)?.stance ?? null,
    alternativesWithContradictions: hyp ? hyp.assessments.filter((a) => a.hypothesisKey !== truthKey && a.contradicting.length > 0).length : null,
    alternativesAssessed: hyp ? hyp.assessments.filter((a) => a.hypothesisKey !== truthKey).length : null,
    challengeToLeadingGiven: !!hyp?.challengeToLeading.statement.trim(),
    impactRecallOfDeterministicAtRisk: deterministicAtRisk.size ? [...deterministicAtRisk].filter((a) => aiExposed.has(a)).length / deterministicAtRisk.size : null,
    impactAssetsBeyondDeterministic: [...aiExposed].filter((a) => !deterministicAtRisk.has(a) && !incident.assets.some((x) => x.assetId === a)).length,
    checks: checks.length,
    checksOnOrigin: checks.filter((c) => c.targetAssetId === truth.origin).length,
    firstCheckOnOrigin: checks.length ? [...checks].sort((a, b) => a.priority - b.priority)[0].targetAssetId === truth.origin : null,
    checksLinkedToHypotheses: checks.filter((c) => c.addressesHypotheses.length > 0).length,
    checksCitingEvidence: checks.filter((c) => c.evidence.length > 0).length,
    disagreementsFound: report.disagreements.length,
    // Governance invariants.
    confirmedByAi: report.governance.confirmedByAi,
    incidentUnchanged: JSON.stringify(incident.hypotheses) === before,
  };
}

export type Score = ReturnType<typeof scoreReport>;
