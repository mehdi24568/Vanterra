import type { GroundingIssue, GroundingStats } from './grounding';
import type { LlmErrorKind, LlmUsage } from './provider';
import type { AgentId, AgentOutputs } from './schemas';

export type AgentStatus = 'completed' | 'degraded' | 'failed' | 'skipped';

/** What one agent contributed to one investigation. */
export interface AgentRun<K extends AgentId = AgentId> {
  agent: K;
  status: AgentStatus;
  /** Model calls made (at most the configured maximum). */
  attempts: number;
  latencyMs: number;
  usage: LlmUsage;
  /** Validated, sanitised output. Null when failed or skipped. */
  output: AgentOutputs[K] | null;
  issues: GroundingIssue[];
  stats: GroundingStats;
  /** Valid evidence IDs cited by the accepted output. */
  cited: string[];
  error: { kind: LlmErrorKind | 'validation' | 'deadline'; message: string } | null;
  skippedReason: string | null;
}

export interface Disagreement {
  between: string[];
  topic: string;
  resolution: string;
  /** Found by the orchestrator agent, or by a deterministic comparison of agent outputs. */
  source: 'orchestrator' | 'cross_check';
}

/** One model call, recorded for audit: what was sent, what came back, what was done with it. */
export interface AuditEntry {
  seq: number;
  agent: AgentId;
  attempt: number;
  at: string;
  inputHash: string;
  inputBytes: number;
  input: unknown;
  rawOutput: unknown;
  error: string | null;
  issues: GroundingIssue[];
  accepted: boolean;
  latencyMs: number;
  usage: LlmUsage;
}

export interface PlanStep {
  agent: AgentId;
  selected: boolean;
  reason: string;
}

export interface InvestigationReport {
  schemaVersion: 1;
  runId: string;
  incidentId: string;
  incidentRevision: number;
  /** Identity of the anomaly set the investigation was run on. */
  evidenceSignature: string;
  provider: string;
  model: string;
  /** True when produced by a test double rather than a language model. */
  testDouble: boolean;
  /** complete: every selected agent contributed. partial: some did. failed: none usable. */
  status: 'complete' | 'partial' | 'failed';
  startedAt: string;
  durationMs: number;
  plan: PlanStep[];
  agents: { [K in AgentId]: AgentRun<K> };
  disagreements: Disagreement[];
  governance: GroundingStats & {
    modelCalls: number;
    /** Structural guarantee, recorded for the audit trail: an AI run never confirms anything. */
    confirmedByAi: false;
  };
  usage: LlmUsage;
  estimatedCostUsd: number | null;
  audit: AuditEntry[];
  failure: string | null;
}

export type RunEvent =
  | { type: 'run_started'; runId: string; provider: string; model: string; testDouble: boolean; plan: PlanStep[] }
  | { type: 'agent_started'; agent: AgentId; attempt: number }
  | { type: 'agent_finished'; agent: AgentId; status: AgentStatus; latencyMs: number; attempts: number }
  | { type: 'run_finished'; report: InvestigationReport }
  | { type: 'run_failed'; message: string };
