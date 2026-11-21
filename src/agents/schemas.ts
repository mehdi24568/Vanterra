/**
 * Output contracts for the five agents.
 *
 * Design rules encoded in the shapes themselves:
 *  - Every claim carries a `basis` (observation or inference) and an `evidence` list.
 *  - There is no numeric confidence anywhere: stances and strengths are categorical,
 *    so a model cannot manufacture a probability.
 *  - There is no field through which an agent could confirm a cause or change an
 *    incident's state. Objects are strict, so adding one is a schema violation.
 *
 * All objects are strict (no unknown keys) and every property is required, which is
 * also what provider-side structured outputs expect.
 */
import { z } from 'zod';

/**
 * Marks ID fields in the JSON Schema, so a provider that constrains generation (Ollama) can
 * restrict them to the IDs that exist in the investigation (`LlmRequest.citableIds`).
 */
export const ID_DESCRIPTION = 'Evidence ID exactly as written in the investigation data';

export const Id = z.string().describe(ID_DESCRIPTION);

export const ClaimSchema = z.strictObject({
  statement: z.string(),
  basis: z.enum(['observation', 'inference']),
  evidence: z.array(Id),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const EvidenceAnalystSchema = z.strictObject({
  summary: z.string(),
  observations: z.array(ClaimSchema),
  sequence: z.array(z.strictObject({ step: z.number(), assetId: Id, description: z.string(), evidence: z.array(Id) })),
  interpretations: z.array(ClaimSchema),
  gaps: z.array(z.strictObject({ description: z.string(), wouldClarify: z.string(), relatedTo: z.array(Id) })),
  evidenceQuality: z.enum(['sufficient', 'partial', 'insufficient']),
});
export type EvidenceAnalystOutput = z.infer<typeof EvidenceAnalystSchema>;

export const HypothesisAnalystSchema = z.strictObject({
  assessments: z.array(
    z.strictObject({
      hypothesisKey: Id,
      stance: z.enum(['supported', 'contested', 'unsupported']),
      rationale: z.string(),
      supporting: z.array(ClaimSchema),
      contradicting: z.array(ClaimSchema),
    }),
  ),
  leadingHypothesisKey: Id.nullable(),
  challengeToLeading: z.strictObject({ statement: z.string(), evidence: z.array(Id) }),
  discriminators: z.array(z.strictObject({ check: z.string(), separates: z.array(Id), expectedIfFirst: z.string() })),
  agreesWithDeterministicRanking: z.boolean(),
  rankingNote: z.string(),
});
export type HypothesisAnalystOutput = z.infer<typeof HypothesisAnalystSchema>;

export const ImpactAnalystSchema = z.strictObject({
  summary: z.string(),
  directlyAbnormal: z.array(z.strictObject({ assetId: Id, note: z.string(), evidence: z.array(Id) })),
  potentiallyAffected: z.array(
    z.strictObject({ assetId: Id, pathway: z.string(), exposure: z.enum(['high', 'moderate', 'low']), evidence: z.array(Id) }),
  ),
  cascades: z.array(z.strictObject({ description: z.string(), evidence: z.array(Id) })),
});
export type ImpactAnalystOutput = z.infer<typeof ImpactAnalystSchema>;

export const PlannerSchema = z.strictObject({
  checks: z.array(
    z.strictObject({
      priority: z.number(),
      action: z.string(),
      rationale: z.string(),
      targetAssetId: Id,
      addressesHypotheses: z.array(Id),
      resolvesGap: z.string().nullable(),
      investigativeValue: z.enum(['high', 'medium', 'low']),
      evidence: z.array(Id),
    }),
  ),
  sequencingNote: z.string(),
});
export type PlannerOutput = z.infer<typeof PlannerSchema>;

export const OrchestratorSchema = z.strictObject({
  conclusion: z.strictObject({ statement: z.string(), evidence: z.array(Id) }),
  standing: z.enum(['evidence_consistent', 'competing_explanations', 'insufficient_evidence']),
  leadingHypothesisKey: Id.nullable(),
  keyFindings: z.array(ClaimSchema),
  disagreements: z.array(z.strictObject({ between: z.array(z.string()), topic: z.string(), resolution: z.string() })),
  openQuestions: z.array(z.string()),
  limitations: z.array(z.string()),
  humanVerification: z.string(),
});
export type OrchestratorOutput = z.infer<typeof OrchestratorSchema>;

export type AgentId = 'evidence_analyst' | 'impact_analyst' | 'hypothesis_analyst' | 'investigation_planner' | 'orchestrator';

export interface AgentOutputs {
  evidence_analyst: EvidenceAnalystOutput;
  impact_analyst: ImpactAnalystOutput;
  hypothesis_analyst: HypothesisAnalystOutput;
  investigation_planner: PlannerOutput;
  orchestrator: OrchestratorOutput;
}

export const AGENT_SCHEMAS: { [K in AgentId]: z.ZodType<AgentOutputs[K]> } = {
  evidence_analyst: EvidenceAnalystSchema,
  impact_analyst: ImpactAnalystSchema,
  hypothesis_analyst: HypothesisAnalystSchema,
  investigation_planner: PlannerSchema,
  orchestrator: OrchestratorSchema,
};
