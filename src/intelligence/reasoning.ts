/**
 * Reasoning provider contract.
 *
 * The Intelligence Engine owns correlation, incident lifecycle, origin ranking and
 * impact analysis. *Explaining* an incident is delegated to a ReasoningProvider so
 * that the deterministic rule-based reasoner shipped here can later sit beside (or
 * be replaced by) an LLM- or agent-based one.
 *
 * Contract for any provider:
 *   - Every hypothesis must cite the anomalies/signals it rests on (CriterionResult).
 *   - `disposition` must be returned as 'unverified'. Only an operator can confirm.
 *   - It may only use what is in the context. No hidden access to the data source.
 *
 * Asynchronous providers (remote models) should compute off-thread and deliver their
 * result through `IntelligenceEngine.applyExternalAssessment(incidentId, revision, ...)`,
 * which discards results that arrive for a stale revision.
 */
import type { Anomaly, BaselineInfo, HypothesisAssessment, SignalDefinition } from '../core/types';
import type { AssetGraph } from '../graph/AssetGraph';

export interface ReasoningContext {
  now: number;
  graph: AssetGraph;
  /** Every anomaly attached to the incident, active or cleared, oldest first. */
  anomalies: Anomaly[];
  /** Current best origin candidate, if any. */
  originAssetId: string | null;
  latest(signalId: string): number | undefined;
  baseline(signalId: string): BaselineInfo | undefined;
  zScore(signalId: string): number;
  signal(signalId: string): SignalDefinition | undefined;
  /** Is any anomaly currently active on this signal, anywhere in the facility? */
  hasActiveAnomaly(signalId: string): boolean;
}

export interface ReasoningProvider {
  readonly id: string;
  readonly label: string;
  assess(ctx: ReasoningContext): HypothesisAssessment[];
}
