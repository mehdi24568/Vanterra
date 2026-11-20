/**
 * LLM provider abstraction.
 *
 * The agent workflow talks to this interface only. A provider turns one request
 * (system prompt, one user message, an output schema) into one structured answer.
 * It has no tools, no memory and no access to the application.
 *
 * Implementations:
 *   server/anthropicProvider.ts            Claude through the official Anthropic SDK (the shipped provider)
 *   src/agents/testing/scriptedProvider.ts a deterministic test double, never presented as a model
 */
import type { z } from 'zod';

export interface LlmRequest<T> {
  /** Stable name for the schema (used by providers that cache compiled schemas). */
  name: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxOutputTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  /** Parsed JSON as returned by the model. Not yet trusted: the caller validates it. */
  output: unknown;
  usage: LlmUsage;
  /** Model that actually served the request. */
  model: string;
  latencyMs: number;
}

export type LlmErrorKind =
  | 'auth'
  | 'config'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'server'
  | 'bad_request'
  | 'bad_response'
  | 'refusal'
  | 'aborted';

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status: number | null;

  constructor(kind: LlmErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    this.status = status;
  }
}

export interface LlmProvider {
  /** Provider id, e.g. "anthropic". */
  readonly id: string;
  /** Configured model id. */
  readonly model: string;
  /** True for test doubles. Surfaces in every report and in the interface. */
  readonly testDouble: boolean;
  complete<T>(request: LlmRequest<T>): Promise<LlmResponse>;
}

/** USD per million tokens. Source: Anthropic price list as cached on 2026-11-03. */
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'claude-fable-5-2': { input: 8, output: 40 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};

/** Estimated cost in USD, or null when the model's price is not known. */
export function estimateCostUsd(model: string, usage: LlmUsage, override?: { input: number; output: number } | null): number | null {
  const price = override ?? MODEL_PRICES[model];
  if (!price) return null;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}
