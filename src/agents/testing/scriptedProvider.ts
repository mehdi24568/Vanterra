/**
 * Scripted provider - a TEST DOUBLE. It is not a language model and does no reasoning.
 *
 * It exists so the agent workflow, its validators and its interface can be exercised
 * without network access or credentials: in unit tests (where individual answers are
 * scripted to be malformed, ungrounded, slow or contradictory) and, only when
 * explicitly enabled, behind the development server for interface testing.
 *
 * With no script, each agent's answer is assembled mechanically from the context it
 * was sent, so the IDs are real but the wording is boilerplate. Every report it
 * produces carries `testDouble: true`, and the interface labels it on every screen.
 */
import { LlmError } from '../provider';
import type { LlmProvider, LlmRequest, LlmResponse } from '../provider';
import type { AgentId } from '../schemas';

/* eslint-disable @typescript-eslint/no-explicit-any -- inputs are free-form JSON by design in a test double */

export type ScriptStep = unknown | ((input: any, attempt: number) => unknown) | Error | { delayMs: number; output?: unknown };

export type Script = Partial<Record<AgentId, ScriptStep[]>>;

const stanceOf = (pct: number) => (pct >= 60 ? 'supported' : pct >= 25 ? 'contested' : 'unsupported');

/** Mechanical, context-derived answer for one agent. */
export function mechanicalAnswer(agent: AgentId, input: any): unknown {
  switch (agent) {
    case 'evidence_analyst': {
      const anomalies: any[] = input.anomalies ?? [];
      const first = anomalies[0];
      const byAsset = new Map<string, any>();
      for (const a of anomalies) if (!byAsset.has(a.assetId)) byAsset.set(a.assetId, a);
      return {
        summary: `${anomalies.length} detections across ${byAsset.size} assets, beginning on ${first?.assetId ?? 'no asset'}.`,
        observations: [
          ...anomalies.slice(0, 6).map((a) => ({
            statement: `${a.signalId} is ${a.direction} at ${a.latest} ${a.unit} (${a.kind.replace(/_/g, ' ')}).`,
            basis: 'observation',
            evidence: [a.id, a.signalId],
          })),
          ...((input.cyberEvents ?? []) as any[]).slice(0, 3).map((e) => ({
            statement: `Cyber event ${e.id} (${e.ruleId}) recorded ${e.onsetS} s relative to the first detection: ${e.title}.`,
            basis: 'observation',
            evidence: [e.id],
          })),
        ],
        sequence: [...byAsset.values()].slice(0, 6).map((a, i) => ({
          step: i + 1,
          assetId: a.assetId,
          description: `First detection on ${a.assetId} ${a.onsetS} s after the incident's first anomaly.`,
          evidence: [a.id],
        })),
        interpretations: first
          ? [
              {
                statement: `Onsets spread outward from ${first.assetId}, which fits propagation along the recorded dependency paths.`,
                basis: 'inference',
                evidence: [first.assetId],
              },
            ]
          : [],
        gaps: first
          ? [
              {
                description: 'No independent measurement corroborates the earliest reading.',
                wouldClarify: 'Whether the first detection reflects the process or the instrument.',
                relatedTo: [first.signalId],
              },
            ]
          : [],
        evidenceQuality: anomalies.length >= 4 ? 'sufficient' : 'partial',
      };
    }
    case 'impact_analyst': {
      const assets: any[] = input.assets ?? [];
      const anomalies: any[] = input.anomalies ?? [];
      const impact: any[] = input.projectedImpact ?? [];
      const affected = assets.filter((a) => a.role === 'affected');
      return {
        summary: `${affected.length} assets show abnormal behaviour; ${impact.filter((i) => i.state === 'at_risk').length} more are exposed downstream.`,
        directlyAbnormal: affected.slice(0, 8).map((a) => ({
          assetId: a.id,
          note: `${anomalies.filter((x) => x.assetId === a.id).length} detections recorded.`,
          evidence: anomalies.filter((x) => x.assetId === a.id).slice(0, 2).map((x) => x.id),
        })),
        potentiallyAffected: impact
          .filter((i) => i.state === 'at_risk')
          .slice(0, 6)
          .map((i) => ({
            assetId: i.assetId,
            pathway: `Reached through ${i.path}.`,
            exposure: i.exposurePct >= 60 ? 'high' : i.exposurePct >= 35 ? 'moderate' : 'low',
            evidence: [i.assetId],
          })),
        cascades:
          impact.length > 0
            ? [{ description: 'If the condition persists, effects would continue along the listed dependency path.', evidence: [] }]
            : [],
      };
    }
    case 'hypothesis_analyst': {
      const hyps: any[] = input.hypotheses ?? [];
      const lead = hyps[0];
      const claims = (h: any, role: string) =>
        h.criteria
          .filter((c: any) => c.role === role && c.observed)
          .slice(0, 4)
          .map((c: any) => {
            const evidence = [...c.anomalyIds, ...c.signalIds].slice(0, 3);
            return { statement: c.description, basis: evidence.length ? 'observation' : 'inference', evidence };
          });
      const missing = lead ? lead.criteria.filter((c: any) => c.role === 'supports' && !c.observed) : [];
      return {
        assessments: hyps.map((h) => ({
          hypothesisKey: h.key,
          stance: stanceOf(h.supportPct),
          rationale: `Rule-based support is ${h.band}; observed criteria are listed.`,
          supporting: claims(h, 'supports'),
          contradicting: claims(h, 'contradicts'),
        })),
        leadingHypothesisKey: lead ? lead.key : null,
        challengeToLeading: {
          statement: missing.length
            ? `Evidence the leading explanation would predict is absent: ${missing[0].description.toLowerCase()}.`
            : 'No expected evidence is missing; the main risk is that the measurements themselves are wrong.',
          evidence: missing.length ? missing[0].signalIds.slice(0, 2) : [],
        },
        discriminators:
          hyps.length > 1
            ? [{ check: lead.verification, separates: [hyps[0].key, hyps[1].key], expectedIfFirst: 'The check finds the condition the leading explanation describes.' }]
            : [],
        agreesWithDeterministicRanking: true,
        rankingNote: 'Ranking follows the rule-based support order.',
      };
    }
    case 'investigation_planner': {
      const hyps: any[] = input.hypotheses ?? [];
      const gaps: any[] = input.evidenceGaps ?? [];
      const checks = hyps.slice(0, 2).map((h, i) => ({
        priority: i + 1,
        action: h.verification,
        rationale: `Bears directly on ${h.title}.`,
        targetAssetId: h.focalAssetId,
        addressesHypotheses: [h.key],
        resolvesGap: null,
        investigativeValue: i === 0 ? 'high' : 'medium',
        evidence: [h.focalAssetId],
      }));
      if (gaps[0] && hyps[0]) {
        checks.push({
          priority: checks.length + 1,
          action: 'Cross-check the earliest reading against a local instrument.',
          rationale: gaps[0].wouldClarify,
          targetAssetId: hyps[0].focalAssetId,
          addressesHypotheses: [],
          resolvesGap: gaps[0].description,
          investigativeValue: 'medium',
          evidence: gaps[0].relatedTo,
        });
      }
      return { checks, sequencingNote: 'Checks are ordered by how directly they bear on the leading explanation.' };
    }
    case 'orchestrator': {
      const baseline = input.ruleBasedBaseline;
      const hyp = input.specialists?.hypothesis_analyst;
      const ev = input.specialists?.evidence_analyst;
      const leadKey: string | null = hyp?.leadingHypothesisKey ?? baseline?.leadingHypothesisKey ?? null;
      const lead = baseline?.hypotheses?.find((h: any) => h.key === leadKey);
      const missing = Object.entries(input.agentStatus ?? {})
        .filter(([, s]) => s === 'failed')
        .map(([a]) => a);
      return {
        conclusion: {
          statement: lead
            ? `The evidence is consistent with: ${lead.title}. This remains a hypothesis until a person verifies it.`
            : 'No explanation in the knowledge base matches the evidence.',
          evidence: [leadKey, input.origin?.assetId].filter(Boolean),
        },
        standing: !lead ? 'insufficient_evidence' : hyp?.assessments?.filter((a: any) => a.stance === 'supported').length > 1 ? 'competing_explanations' : 'evidence_consistent',
        leadingHypothesisKey: leadKey,
        keyFindings: (ev?.observations ?? []).slice(0, 3),
        disagreements: (input.crossChecks ?? []).map((d: any) => ({ between: d.between, topic: d.topic, resolution: d.resolution })),
        openQuestions: (ev?.gaps ?? []).map((g: any) => g.description),
        limitations: [
          'Assembled mechanically by a scripted test double; no language model was involved.',
          ...(missing.length ? [`No contribution from: ${missing.join(', ')}.`] : []),
        ],
        humanVerification: lead ? 'Physical verification of the leading explanation is required before it is treated as the cause.' : 'Inspect the affected assets directly.',
      };
    }
  }
}

export class ScriptedProvider implements LlmProvider {
  readonly id = 'scripted';
  readonly model = 'scripted-test-double';
  readonly testDouble = true;
  /** Every request received, for assertions. */
  readonly calls: Array<{ agent: AgentId; attempt: number; user: string }> = [];

  constructor(
    private readonly script: Script = {},
    private readonly latencyMs = 0,
  ) {}

  async complete<T>(request: LlmRequest<T>): Promise<LlmResponse> {
    const agent = request.name as AgentId;
    const attempt = this.calls.filter((c) => c.agent === agent).length + 1;
    this.calls.push({ agent, attempt, user: request.user });
    if (request.signal?.aborted) throw new LlmError('aborted', 'Request aborted');

    const cut = request.user.indexOf('\n\nYour previous answer was not accepted');
    const input = JSON.parse(cut >= 0 ? request.user.slice(0, cut) : request.user);
    let step: ScriptStep = this.script[agent]?.[attempt - 1];
    let delay = this.latencyMs;
    if (step && typeof step === 'object' && !(step instanceof Error) && 'delayMs' in (step as object)) {
      const timed = step as { delayMs: number; output?: unknown };
      delay = timed.delayMs;
      step = timed.output;
    }
    if (delay > request.timeoutMs) {
      await new Promise((r) => setTimeout(r, Math.min(request.timeoutMs, 50)));
      throw new LlmError('timeout', `No response within ${Math.round(request.timeoutMs / 1000)} s`);
    }
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (step instanceof Error) throw step;
    const output = step === undefined ? mechanicalAnswer(agent, input) : typeof step === 'function' ? (step as (i: unknown, a: number) => unknown)(input, attempt) : step;
    return {
      output,
      usage: { inputTokens: Math.round(request.user.length / 4), outputTokens: Math.round(JSON.stringify(output ?? null).length / 4) },
      model: this.model,
      latencyMs: delay,
    };
  }
}
