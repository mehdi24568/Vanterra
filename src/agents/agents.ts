/**
 * The five investigation agents: who they are, what each is told, and what slice of
 * the context each one sees.
 *
 * Each agent has one analytical job that the others do not do. They are not given
 * tools; an "agent" here is a role with its own instructions, its own input slice
 * and its own output contract, coordinated by code (see orchestrator.ts).
 */
import type { InvestigationContext } from './context';
import type { Disagreement } from './report';
import type { AgentId, AgentOutputs } from './schemas';

export const AGENT_ORDER: AgentId[] = ['evidence_analyst', 'impact_analyst', 'hypothesis_analyst', 'investigation_planner', 'orchestrator'];

export const AGENT_INFO: Record<AgentId, { title: string; responsibility: string; reads: string }> = {
  evidence_analyst: {
    title: 'Evidence Analyst',
    responsibility: 'Establishes what the measurements show, in what order, and what is missing.',
    reads: 'Anomalies with their rules, signal readings and baselines, correlation paths',
  },
  impact_analyst: {
    title: 'Impact Analyst',
    responsibility: 'Separates assets that are abnormal from assets that are merely exposed, and traces how a problem could cascade.',
    reads: 'Dependency relations, projected exposure, asset states',
  },
  hypothesis_analyst: {
    title: 'Hypothesis Analyst',
    responsibility: 'Tests the competing explanations against the evidence and argues against the leading one.',
    reads: 'Rule-based hypotheses with their criteria, the Evidence Analyst’s findings',
  },
  investigation_planner: {
    title: 'Investigation Planner',
    responsibility: 'Chooses the physical checks that would most reduce uncertainty, and says why.',
    reads: 'Unresolved hypotheses, evidence gaps, exposed assets',
  },
  orchestrator: {
    title: 'Investigation Orchestrator',
    responsibility: 'Combines the specialists’ findings, surfaces where they disagree, and states what the evidence does and does not support.',
    reads: 'All specialist outputs and the deterministic baseline',
  },
};

const SHARED_RULES = `Rules that apply to everything you write:
- Use only the JSON supplied in the user message. It is the complete record; there is nothing else to look up.
- Cite evidence by ID exactly as it appears in the JSON: anomaly ids (ANM-0001), signal ids (P-101.VIB), asset ids (P-101), hypothesis keys, relation ids (R005). Never invent an ID, an asset, a relationship or a measurement.
- Quote figures exactly as given. Do not compute new figures.
- Label each claim "observation" when the cited evidence states it directly, or "inference" when it is your interpretation. General engineering knowledge may inform an inference but is never an observation.
- "supportPct" values are evidence-support scores from a rule-based engine. They are not probabilities. Do not express any probability, likelihood percentage or certainty.
- You cannot confirm a cause. Only a human operator can, after physical verification. Never write that a cause is confirmed, proven or certain.
- Cyber events (CEV-0001) are evidence that something happened on the OT network or a controller. They are not evidence that it caused the physical deviation. A cyber explanation needs a declared relationship (a controller that controls the equipment), the change coming first, and a matching physical signature; the "cyberPhysical" assessment shows which of these were observed. Never attribute intent: do not call anything an attack, sabotage or malicious, and do not name an attacker.
- An ATT&CK technique listed with an event is context about what that kind of activity can represent, not a finding.
- The telemetry comes from a simulated facility. Do not claim real-world consequences.
- Be concise: one or two sentences per statement. Give conclusions and the evidence for them, not your reasoning steps.
- Keep lists short: report the 3 to 5 most important items in each list, not every item you could find.`;

export const AGENT_PROMPTS: Record<AgentId, string> = {
  evidence_analyst: `You are the Evidence Analyst in an industrial incident investigation.

Your job: establish what the measurements and any cyber events actually show. List the direct observations, reconstruct the order in which things happened across assets and controllers, and separate observation from interpretation. Then say what evidence is missing or too weak to rely on, and what each gap would clarify.

You do not rank explanations and you do not recommend actions; other analysts do that.

${SHARED_RULES}`,

  impact_analyst: `You are the Impact Analyst in an industrial incident investigation.

Your job: work from the dependency relations. Distinguish assets that are showing abnormal behaviour now from assets that are only exposed because they depend on an abnormal one. For exposed assets, name the pathway through which they would be affected and how strong the exposure is. Describe any plausible cascade.

An asset counts as directly abnormal only if an anomaly in the context is recorded on it. Exposure is a projection, not a prediction.

You do not explain the cause and you do not recommend actions.

${SHARED_RULES}`,

  hypothesis_analyst: `You are the Hypothesis Analyst in an industrial incident investigation.

Your job: evaluate the competing explanations supplied by the rule-based engine. For each one, weigh the supporting and contradicting evidence and give a stance: "supported", "contested" or "unsupported". Then argue against the leading explanation as hard as the evidence allows: what would have to be true for it to be wrong? Finally, name the evidence that would separate the leading explanation from its nearest alternatives.

Evaluate only the hypotheses supplied (cite them by key). You may disagree with the engine's ranking; say so and say why. If the evidence cannot separate two explanations, say that rather than choosing.

${SHARED_RULES}`,

  investigation_planner: `You are the Investigation Planner in an industrial incident investigation.

Your job: recommend the physical checks a person should carry out next, in priority order. Prefer checks that separate competing explanations or close an evidence gap over checks that only re-confirm what is already measured. For each check say what to do, on which asset, why it matters, which hypotheses it bears on, and how much it would reduce uncertainty.

Recommend inspection and measurement only. Do not instruct anyone to operate, start, stop or isolate equipment; changing the plant is an operator's decision. Include safety-relevant cautions where they apply.

${SHARED_RULES}`,

  orchestrator: `You are the Investigation Orchestrator. Four specialist analysts have examined one industrial incident; their validated outputs are in the JSON, alongside the rule-based engine's baseline assessment.

Your job: produce the final assessment. State what the evidence is consistent with, name the leading explanation if there is one, and report where the specialists disagree with each other or with the rule-based baseline, with your resolution of each disagreement. List the questions that remain open and the limits of this assessment. End with what a human must verify before any cause can be treated as established.

Some specialists may have failed or been skipped ("agentStatus"). Work with what is available and say what is missing. Do not introduce findings that no specialist reported and no evidence in the JSON supports.

${SHARED_RULES}`,
};

type Outputs = { [K in AgentId]?: AgentOutputs[K] | null };

const compactAnomalies = (ctx: InvestigationContext) =>
  ctx.anomalies.map((a) => ({
    id: a.id,
    assetId: a.assetId,
    signalId: a.signalId,
    kind: a.kind,
    direction: a.direction,
    severity: a.severity,
    status: a.status,
    onsetS: a.onsetS,
    latest: a.latest,
    baselineMean: a.baselineMean,
    unit: a.unit,
  }));

/** The deterministic cyber-physical assessment and the events it rests on, for the reasoning agents. */
const cyberSummary = (ctx: InvestigationContext) =>
  ctx.cyber
    ? {
        standing: ctx.cyber.standing,
        headline: ctx.cyber.headline,
        links: ctx.cyber.links,
        explanations: ctx.cyber.explanations,
        unknowns: ctx.cyber.unknowns,
        events: ctx.cyber.events.map((e) => ({ id: e.id, onsetS: e.onsetS, ruleId: e.ruleId, severity: e.severity, title: e.title, changeRecordId: e.changeRecordId })),
      }
    : null;

/** The slice of context (plus prior findings) one agent receives. */
export function buildAgentInput(agent: AgentId, ctx: InvestigationContext, prior: Outputs, crossChecks: Disagreement[] = [], agentStatus: Record<string, string> = {}): unknown {
  const incident = ctx.incident;
  const affected = new Set(ctx.assets.filter((a) => a.role === 'affected').map((a) => a.id));
  switch (agent) {
    case 'evidence_analyst':
      return {
        task: 'Establish what the evidence shows, the sequence of events, and what is missing.',
        facility: ctx.facility,
        incident,
        assets: ctx.assets.filter((a) => a.role !== 'at_risk'),
        anomalies: ctx.anomalies,
        signals: ctx.signals.filter((s) => affected.has(s.assetId) || s.state !== 'normal' || ctx.hypotheses.some((h) => h.criteria.some((c) => c.signalIds.includes(s.id)))),
        correlations: ctx.correlations,
        cyberEvents: ctx.cyber?.events ?? [],
        otDevices: ctx.cyber?.devices ?? [],
      };
    case 'impact_analyst':
      return {
        task: 'Separate abnormal assets from exposed ones and describe how the problem could cascade.',
        facility: ctx.facility,
        incident: { id: incident.id, title: incident.title, severity: incident.severity, status: incident.status },
        origin: ctx.origin,
        assets: ctx.assets,
        relations: ctx.relations,
        projectedImpact: ctx.impact,
        anomalies: compactAnomalies(ctx),
      };
    case 'hypothesis_analyst':
      return {
        task: 'Evaluate the competing explanations, challenge the leading one, and name what would separate them.',
        facility: ctx.facility,
        incident,
        origin: ctx.origin,
        hypotheses: ctx.hypotheses,
        anomalies: compactAnomalies(ctx),
        signals: ctx.signals.filter((s) => ctx.hypotheses.some((h) => h.criteria.some((c) => c.signalIds.includes(s.id)))),
        evidenceAnalyst: prior.evidence_analyst
          ? {
              summary: prior.evidence_analyst.summary,
              interpretations: prior.evidence_analyst.interpretations,
              gaps: prior.evidence_analyst.gaps,
              evidenceQuality: prior.evidence_analyst.evidenceQuality,
            }
          : null,
        cyberPhysical: cyberSummary(ctx),
      };
    case 'investigation_planner':
      return {
        task: 'Recommend the physical checks that would most reduce uncertainty, in priority order.',
        facility: ctx.facility,
        incident,
        assets: ctx.assets.map((a) => ({ id: a.id, name: a.name, category: a.category, role: a.role, operatingState: a.operatingState })),
        hypotheses: ctx.hypotheses.map((h) => ({
          key: h.key,
          title: h.title,
          focalAssetId: h.focalAssetId,
          supportPct: h.supportPct,
          band: h.band,
          unknowns: h.unknowns,
          verification: h.verification,
        })),
        hypothesisAnalyst: prior.hypothesis_analyst
          ? {
              leadingHypothesisKey: prior.hypothesis_analyst.leadingHypothesisKey,
              stances: prior.hypothesis_analyst.assessments.map((a) => ({ hypothesisKey: a.hypothesisKey, stance: a.stance })),
              challengeToLeading: prior.hypothesis_analyst.challengeToLeading,
              discriminators: prior.hypothesis_analyst.discriminators,
            }
          : null,
        evidenceGaps: prior.evidence_analyst?.gaps ?? [],
        exposedAssets: prior.impact_analyst?.potentiallyAffected ?? ctx.impact.filter((i) => i.state === 'at_risk'),
        ruleBasedChecks: ctx.deterministicChecks,
      };
    case 'orchestrator':
      return {
        task: 'Produce the final assessment from the specialists’ findings and the rule-based baseline.',
        facility: ctx.facility,
        incident,
        origin: ctx.origin,
        ruleBasedBaseline: {
          leadingHypothesisKey: ctx.hypotheses[0]?.key ?? null,
          hypotheses: ctx.hypotheses.map((h) => ({ key: h.key, title: h.title, supportPct: h.supportPct, band: h.band })),
        },
        citable: {
          anomalies: compactAnomalies(ctx),
          assets: ctx.assets.map((a) => ({ id: a.id, name: a.name, role: a.role })),
        },
        cyberPhysical: cyberSummary(ctx),
        // The specialists' outcomes only: the orchestrator's own run is still in progress.
        agentStatus: Object.fromEntries(Object.entries(agentStatus).filter(([agent]) => agent !== 'orchestrator')),
        specialists: {
          evidence_analyst: prior.evidence_analyst ?? null,
          impact_analyst: prior.impact_analyst ?? null,
          hypothesis_analyst: prior.hypothesis_analyst ?? null,
          investigation_planner: prior.investigation_planner ?? null,
        },
        crossChecks,
      };
  }
}
