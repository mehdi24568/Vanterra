/**
 * Claude provider, through the official Anthropic SDK.
 *
 * One request per agent turn: a system prompt, one user message carrying the JSON
 * context, and a structured-output schema. No tools, no conversation state.
 *
 * Runs only in the Node process behind the dev/preview server. Credentials come from
 * the environment and never reach the browser.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { LlmError } from '../src/agents/provider';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/agents/provider';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicConfig {
  apiKey?: string;
  authToken?: string;
  baseURL: string;
  model: string;
  effort: Effort;
  /** Let the API re-run a request that a safety classifier declines on a fallback model. */
  refusalFallback: boolean;
}

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic';
  readonly testDouble = false;
  readonly model: string;
  private readonly client: Anthropic;

  constructor(private readonly config: AnthropicConfig) {
    this.model = config.model;
    this.client = new Anthropic({
      apiKey: config.apiKey ?? null,
      authToken: config.authToken ?? null,
      baseURL: config.baseURL,
      // The SDK retries 408/409/429/5xx and connection errors with backoff.
      maxRetries: 2,
    });
  }

  async complete<T>(request: LlmRequest<T>): Promise<LlmResponse> {
    const started = performance.now();
    const common = {
      model: this.config.model,
      max_tokens: request.maxOutputTokens,
      system: request.system,
      messages: [{ role: 'user' as const, content: request.user }],
    };
    const options = { timeout: request.timeoutMs, signal: request.signal };

    try {
      // Thinking is adaptive by default on current models; depth is set through effort.
      // `create` rather than the `parse` helper: the stop reason must be inspected before
      // the body is trusted, and the workflow validates the answer against the schema itself.
      const message = this.config.refusalFallback
        ? await this.client.beta.messages.create(
            {
              ...common,
              betas: [FALLBACK_BETA],
              fallbacks: 'default',
              output_config: { format: betaZodOutputFormat(request.schema), effort: this.config.effort },
            },
            options,
          )
        : await this.client.messages.create(
            { ...common, output_config: { format: zodOutputFormat(request.schema), effort: this.config.effort } },
            options,
          );

      if (message.stop_reason === 'refusal') {
        throw new LlmError('refusal', 'The model declined this request');
      }
      if (message.stop_reason === 'max_tokens') {
        throw new LlmError('bad_response', `Output was cut off at ${request.maxOutputTokens} tokens`);
      }

      const blocks = message.content as Array<{ type: string; text?: string }>;
      const text = blocks.map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('');
      let output: unknown;
      try {
        output = JSON.parse(text);
      } catch {
        // Not JSON: hand the raw text back so the caller's schema check records what was wrong.
        output = text;
      }
      return {
        output,
        usage: {
          inputTokens:
            message.usage.input_tokens + (message.usage.cache_creation_input_tokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0),
          outputTokens: message.usage.output_tokens,
        },
        model: message.model,
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      throw toLlmError(err);
    }
  }
}

/** Map the SDK's typed errors onto the workflow's error kinds, most specific first. */
export function toLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new LlmError('aborted', 'Request cancelled');
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new LlmError('timeout', 'The model did not respond in time');
  if (err instanceof Anthropic.AuthenticationError) return new LlmError('auth', 'The API rejected the credentials (401). Check ANTHROPIC_API_KEY.', 401);
  if (err instanceof Anthropic.PermissionDeniedError) return new LlmError('auth', 'The credentials are not permitted to use this model (403).', 403);
  if (err instanceof Anthropic.NotFoundError) return new LlmError('config', 'Model not found or not available to this account (404). Check ATLAS_LLM_MODEL.', 404);
  if (err instanceof Anthropic.RateLimitError) return new LlmError('rate_limit', 'Rate limited by the provider (429), after retries.', 429);
  if (err instanceof Anthropic.BadRequestError) return new LlmError('bad_request', `The provider rejected the request (400): ${err.message}`, 400);
  if (err instanceof Anthropic.APIConnectionError) return new LlmError('network', 'Could not reach the model provider.');
  if (err instanceof Anthropic.APIError) return new LlmError('server', `Provider error${err.status ? ` (${err.status})` : ''}, after retries.`, err.status ?? null);
  return new LlmError('server', err instanceof Error ? err.message : String(err));
}
