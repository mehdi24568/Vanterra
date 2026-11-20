/**
 * Investigation workflow - a bounded, code-controlled orchestration of five agents.
 *
 *   stage 1 (parallel)   Evidence Analyst | Impact Analyst
 *   stage 2              Hypothesis Analyst      (reads the Evidence Analyst's findings)
 *   stage 3              Investigation Planner   (reads gaps, discriminators, exposure)
 *   stage 4              Orchestrator            (synthesis, disagreements, limits)
 *
 * Control flow is ordinary code rather than model-driven: the stages, their order and
 * their inputs are fixed, so the run is reproducible in shape and impossible to loop.
 *
 * Bounds and termination:
 *   - at most `maxAttemptsPerAgent` model calls per agent (one answer, one repair);
 *   - a per-call timeout and an overall deadline;
 *   - the run ends when stage 4 returns, when the deadline passes, when the caller
 *     aborts, or immediately on an unrecoverable provider error (credentials, config).
 *
 * Every answer passes two gates before it is used: the output schema, then the
 * grounding validator. A failed specialist does not fail the run; the orchestrator
 * is told what is missing and the report is marked partial.
 */
import { AGENT_INFO, AGENT_PROMPTS, buildAgentInput } from './agents';
import { catalogueOf, evidenceSignature } from './context';
import type { InvestigationContext } from './context';
import { ground, needsRepair, repairFeedback } from './grounding';
import type { GroundingIssue, GroundingStats } from './grounding';
import { LlmError, estimateCostUsd } from './provider';
import type { LlmProvider, LlmUsage } from './provider';
import type { AgentRun, AuditEntry, Disagreement, InvestigationReport, PlanStep, RunEvent } from './report';
import { AGENT_SCHEMAS } from './schemas';
import type { AgentId, AgentOutputs } from './schemas';

export interface RunLimits {
  maxAttemptsPerAgent: number;
  agentTimeoutMs: number;
  runDeadlineMs: number;
  maxOutputTokens: number;
}

export const DEFAULT_LIMITS: RunLimits = {
  maxAttemptsPerAgent: 2,
  agentTimeoutMs: 90_000,
  runDeadlineMs: 240_000,
  maxOutputTokens: 16_000,
};

export interface RunDeps {
  provider: LlmProvider;
  limits?: Partial<RunLimits>;
  emit?: (event: RunEvent) => void;
  signal?: AbortSignal;
  /** Overrides the built-in price table for cost estimates. */
  price?: { input: number; output: number } | null;
  runId?: string;
}

const ZERO_STATS = (): GroundingStats => ({ claims: 0, claimsRejected: 0, citations: 0, invalidCitations: 0, figuresFlagged: 0 });

/** Provider errors after which continuing the run cannot succeed. */
const UNRECOVERABLE = new Set(['auth', 'config', 'aborted', 'bad_request', 'network']);

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Decide which analyses this incident needs. Rule-based, and reported with reasons. */
export function planTasks(ctx: InvestigationContext): PlanStep[] {
  const multiAsset = ctx.assets.filter((a) => a.role === 'affected').length > 1;
  return [
    { agent: 'evidence_analyst', selected: true, reason: `${ctx.anomalies.length} detections to examine` },
    ctx.impact.length > 0 || multiAsset
      ? { agent: 'impact_analyst', selected: true, reason: `${ctx.impact.filter((i) => i.state === 'at_risk').length} exposed assets downstream` }
      : { agent: 'impact_analyst', selected: false, reason: 'One affected asset and no projected downstream exposure' },
    ctx.hypotheses.length > 0
      ? { agent: 'hypothesis_analyst', selected: true, reason: `${ctx.hypotheses.length} competing explanations to evaluate` }
      : { agent: 'hypothesis_analyst', selected: false, reason: 'The rule-based engine produced no hypotheses to evaluate' },
    { agent: 'investigation_planner', selected: true, reason: 'Checks are always planned' },
    { agent: 'orchestrator', selected: true, reason: 'Final synthesis' },
  ];
}

/** Deterministic comparison of specialist outputs: disagreements a model might gloss over. */
export function crossCheck(ctx: InvestigationContext, out: { [K in AgentId]?: AgentOutputs[K] | null }): Disagreement[] {
  const found: Disagreement[] = [];
  const engineLead = ctx.hypotheses[0]?.key ?? null;
  const hyp = out.hypothesis_analyst;
  const ev = out.evidence_analyst;
  const imp = out.impact_analyst;
  const orch = out.orchestrator;
  const title = (key: string | null) => ctx.hypotheses.find((h) => h.key === key)?.title ?? key ?? 'none';

  if (hyp && hyp.leadingHypothesisKey && engineLead && hyp.leadingHypothesisKey !== engineLead) {
    found.push({
      between: ['hypothesis_analyst', 'rule_based_engine'],
      topic: `Leading explanation. Analyst: ${title(hyp.leadingHypothesisKey)}. Engine: ${title(engineLead)}.`,
      resolution: 'Not resolved by comparison. Both are shown; the difference is a reason to prioritise checks that separate them.',
      source: 'cross_check',
    });
  }
  if (hyp && ev && ev.evidenceQuality === 'insufficient' && hyp.assessments.some((a) => a.hypothesisKey === hyp.leadingHypothesisKey && a.stance === 'supported')) {
    found.push({
      between: ['evidence_analyst', 'hypothesis_analyst'],
      topic: 'The Evidence Analyst rates the evidence insufficient, while the Hypothesis Analyst treats the leading explanation as supported.',
      resolution: 'Treat the leading explanation as provisional until the listed evidence gaps are closed.',
      source: 'cross_check',
    });
  }
  if (imp) {
    const withAnomaly = new Set(ctx.anomalies.map((a) => a.assetId));
    const wrong = imp.directlyAbnormal.filter((d) => !withAnomaly.has(d.assetId)).map((d) => d.assetId);
    if (wrong.length > 0) {
      found.push({
        between: ['impact_analyst', 'detection_engine'],
        topic: `Listed as abnormal without a recorded detection: ${wrong.join(', ')}.`,
        resolution: 'The detection engine is the source of truth for what is abnormal; these assets are exposed, not abnormal.',
        source: 'cross_check',
      });
    }
  }
  if (orch && hyp && orch.leadingHypothesisKey !== hyp.leadingHypothesisKey) {
    found.push({
      between: ['orchestrator', 'hypothesis_analyst'],
      topic: `Leading explanation. Orchestrator: ${title(orch.leadingHypothesisKey)}. Hypothesis Analyst: ${title(hyp.leadingHypothesisKey)}.`,
      resolution: 'Not resolved by comparison. Read the orchestrator’s stated reasons against the analyst’s evidence.',
      source: 'cross_check',
    });
  }
  if (orch && ev && orch.standing === 'evidence_consistent' && ev.evidenceQuality === 'insufficient') {
    found.push({
      between: ['orchestrator', 'evidence_analyst'],
      topic: 'The final assessment calls the evidence consistent, while the Evidence Analyst rates it insufficient.',
      resolution: 'Give weight to the Evidence Analyst: the conclusion rests on evidence it considers incomplete.',
      source: 'cross_check',
    });
  }
  return found;
}

export async function runInvestigation(ctx: InvestigationContext, deps: RunDeps): Promise<InvestigationReport> {
  const limits: RunLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const provider = deps.provider;
  const emit = deps.emit ?? (() => {});
  const started = Date.now();
  const deadline = started + limits.runDeadlineMs;
  const catalogue = catalogueOf(ctx);
  const plan = planTasks(ctx);
  const audit: AuditEntry[] = [];
  const runId = deps.runId ?? `RUN-${started.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  let unrecoverable: { kind: string; message: string } | null = null;
  let servedModel = provider.model;

  emit({ type: 'run_started', runId, provider: provider.id, model: provider.model, testDouble: provider.testDouble, plan });

  const blank = <K extends AgentId>(agent: K): AgentRun<K> => ({
    agent,
    status: 'skipped',
    attempts: 0,
    latencyMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    output: null,
    issues: [],
    stats: ZERO_STATS(),
    cited: [],
    error: null,
    skippedReason: null,
  });

  const outputs: { [K in AgentId]?: AgentOutputs[K] | null } = {};
  const runs = {
    evidence_analyst: blank('evidence_analyst'),
    impact_analyst: blank('impact_analyst'),
    hypothesis_analyst: blank('hypothesis_analyst'),
    investigation_planner: blank('investigation_planner'),
    orchestrator: blank('orchestrator'),
  };

  async function runAgent<K extends AgentId>(agent: K, crossChecks: Disagreement[] = []): Promise<void> {
    const run = runs[agent] as AgentRun<K>;
    const step = plan.find((p) => p.agent === agent)!;
    if (!step.selected) {
      run.skippedReason = step.reason;
      emit({ type: 'agent_finished', agent, status: 'skipped', latencyMs: 0, attempts: 0 });
      return;
    }
    run.status = 'failed';
    const agentStatus = Object.fromEntries(Object.values(runs).map((r) => [r.agent, r.status]));
    const input = buildAgentInput(agent, ctx, outputs, crossChecks, agentStatus);
    const inputJson = JSON.stringify(input);
    const schema = AGENT_SCHEMAS[agent];
    let feedback: string | null = null;

    for (let attempt = 1; attempt <= limits.maxAttemptsPerAgent; attempt++) {
      if (unrecoverable) {
        run.error = { kind: unrecoverable.kind as 'auth', message: unrecoverable.message };
        break;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 1000) {
        run.error = { kind: 'deadline', message: `Run deadline of ${Math.round(limits.runDeadlineMs / 1000)} s reached before ${AGENT_INFO[agent].title} could ${attempt === 1 ? 'start' : 'retry'}` };
        break;
      }
      if (deps.signal?.aborted) {
        run.error = { kind: 'aborted', message: 'Investigation cancelled' };
        break;
      }
      run.attempts = attempt;
      emit({ type: 'agent_started', agent, attempt });
      const entry: AuditEntry = {
        seq: audit.length + 1,
        agent,
        attempt,
        at: new Date().toISOString(),
        inputHash: fnv1a(inputJson + (feedback ?? '')),
        inputBytes: inputJson.length,
        input: feedback ? { ...(input as object), repairFeedback: feedback } : input,
        rawOutput: null,
        error: null,
        issues: [],
        accepted: false,
        latencyMs: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
      audit.push(entry);

      let output: unknown;
      try {
        const response = await provider.complete({
          name: agent,
          system: AGENT_PROMPTS[agent],
          user: feedback ? `${inputJson}\n\n${feedback}` : inputJson,
          schema,
          maxOutputTokens: limits.maxOutputTokens,
          timeoutMs: Math.min(limits.agentTimeoutMs, remaining),
          deadlineAt: deadline,
          signal: deps.signal,
        });
        output = response.output;
        servedModel = response.model || servedModel;
        entry.rawOutput = output;
        entry.latencyMs = response.latencyMs;
        entry.usage = response.usage;
        run.latencyMs += response.latencyMs;
        run.usage.inputTokens += response.usage.inputTokens;
        run.usage.outputTokens += response.usage.outputTokens;
      } catch (err) {
        const e = err instanceof LlmError ? err : new LlmError('server', err instanceof Error ? err.message : String(err));
        entry.error = `${e.kind}: ${e.message}`;
        run.error = { kind: e.kind, message: e.message };
        if (UNRECOVERABLE.has(e.kind)) unrecoverable = { kind: e.kind, message: e.message };
        // Transient transport errors are retried inside the provider; here they end the agent.
        break;
      }

      const parsed = schema.safeParse(output);
      if (!parsed.success) {
        const issues: GroundingIssue[] = parsed.error.issues.slice(0, 12).map((i) => ({
          code: 'schema',
          path: i.path.join('.'),
          detail: i.message,
          action: 'rejected',
        }));
        entry.issues = issues;
        if (attempt < limits.maxAttemptsPerAgent) {
          feedback = repairFeedback(issues);
          continue;
        }
        run.issues = issues;
        run.error = { kind: 'validation', message: `Output did not match the required schema after ${attempt} attempts` };
        break;
      }

      const checked = ground(parsed.data, catalogue, ctx, 'check');
      const last = attempt === limits.maxAttemptsPerAgent;
      if (needsRepair(checked.issues) && !last) {
        entry.issues = checked.issues;
        feedback = repairFeedback(checked.issues);
        continue;
      }
      const result = needsRepair(checked.issues) ? ground(parsed.data, catalogue, ctx, 'sanitise') : checked;
      entry.issues = result.issues;
      run.issues = result.issues;
      run.stats = result.stats;
      if (result.output === null) {
        run.error = { kind: 'validation', message: 'Rejected: a top-level statement asserted certainty or a probability' };
        break;
      }
      entry.accepted = true;
      run.output = result.output as AgentOutputs[K];
      run.cited = result.cited;
      run.error = null;
      run.status = result.stats.claimsRejected > 0 || result.issues.some((i) => i.action === 'rejected') ? 'degraded' : 'completed';
      (outputs as Record<string, unknown>)[agent] = run.output;
      break;
    }
    emit({ type: 'agent_finished', agent, status: run.status, latencyMs: run.latencyMs, attempts: run.attempts });
  }

  // Stage 1: two independent readings of the context.
  await Promise.all([runAgent('evidence_analyst'), runAgent('impact_analyst')]);
  // Stage 2 and 3 build on stage 1.
  await runAgent('hypothesis_analyst');
  await runAgent('investigation_planner');
  // Stage 4: synthesis, told where the specialists already disagree.
  await runAgent('orchestrator', crossCheck(ctx, outputs));

  const disagreements: Disagreement[] = [
    ...(runs.orchestrator.output?.disagreements ?? []).map((d) => ({ ...d, source: 'orchestrator' as const })),
    ...crossCheck(ctx, outputs),
  ];

  const selected = plan.filter((p) => p.selected).map((p) => p.agent);
  const usable = selected.filter((a) => runs[a].output !== null);
  const status: InvestigationReport['status'] = usable.length === selected.length ? 'complete' : usable.length === 0 ? 'failed' : 'partial';
  const all = Object.values(runs) as AgentRun[];
  const usage: LlmUsage = all.reduce((u, r) => ({ inputTokens: u.inputTokens + r.usage.inputTokens, outputTokens: u.outputTokens + r.usage.outputTokens }), {
    inputTokens: 0,
    outputTokens: 0,
  });
  const governance = all.reduce((g, r) => {
    g.claims += r.stats.claims;
    g.claimsRejected += r.stats.claimsRejected;
    g.citations += r.stats.citations;
    g.invalidCitations += r.stats.invalidCitations;
    g.figuresFlagged += r.stats.figuresFlagged;
    return g;
  }, ZERO_STATS());
  const firstError = all.find((r) => r.error)?.error;

  const report: InvestigationReport = {
    schemaVersion: 1,
    runId,
    incidentId: ctx.incident.id,
    incidentRevision: ctx.incident.revision,
    evidenceSignature: evidenceSignature(ctx.anomalies.map((a) => a.id)),
    provider: provider.id,
    model: servedModel,
    testDouble: provider.testDouble,
    status,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    plan,
    agents: runs,
    disagreements,
    governance: { ...governance, modelCalls: audit.length, confirmedByAi: false },
    usage,
    estimatedCostUsd: provider.testDouble ? null : estimateCostUsd(servedModel, usage, deps.price),
    audit,
    failure: status === 'failed' ? (firstError ? `${firstError.kind}: ${firstError.message}` : 'No agent produced a usable result') : null,
  };
  emit({ type: 'run_finished', report });
  return report;
}
