/**
 * Local inference through Ollama (https://ollama.com): no API key, no usage cost.
 *
 * Uses Ollama's native chat API with structured outputs: the agent's zod schema is
 * converted to JSON Schema and passed in `format`, so the model is constrained to the
 * same shape the Claude provider is. Its output then goes through the same schema and
 * grounding gates as any other provider; nothing here is trusted.
 *
 * Thinking-capable models are asked not to think (`think: false`): the workflow never
 * requests or stores chain-of-thought, and on a CPU it would multiply latency.
 */
import { z } from 'zod';
import { LlmError } from '../src/agents/provider';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/agents/provider';

export interface OllamaOptions {
  baseURL: string;
  model: string;
  /** Context window to request (tokens). Agent inputs are roughly 5–12k tokens. */
  numCtx: number;
  /** How long Ollama keeps the model loaded after a call. */
  keepAlive: string;
}

const THINKING_FAMILIES = /^(qwen3|deepseek-r1|gpt-oss|magistral)/i;

export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama';
  readonly testDouble = false;
  readonly model: string;

  constructor(private readonly options: OllamaOptions) {
    this.model = options.model;
  }

  /** Is Ollama running, and is the configured model downloaded? */
  async health(): Promise<{ ok: boolean; reason: string | null }> {
    let tags: { models?: { name: string; model?: string }[] };
    try {
      const res = await fetch(`${this.options.baseURL}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return { ok: false, reason: `Ollama answered ${res.status} at ${this.options.baseURL}.` };
      tags = (await res.json()) as typeof tags;
    } catch {
      return { ok: false, reason: `Ollama is not reachable at ${this.options.baseURL}. Start Ollama, then check again.` };
    }
    const names = (tags.models ?? []).flatMap((m) => [m.name, m.model ?? '']);
    const wanted = this.model.includes(':') ? [this.model] : [this.model, `${this.model}:latest`];
    if (!names.some((n) => wanted.includes(n))) {
      return { ok: false, reason: `Model ${this.model} is not downloaded in Ollama. Run: ollama pull ${this.model}` };
    }
    return { ok: true, reason: null };
  }

  async complete<T>(request: LlmRequest<T>): Promise<LlmResponse> {
    const started = performance.now();
    const format = z.toJSONSchema(request.schema as z.ZodType);
    delete (format as Record<string, unknown>).$schema;
    const body = {
      model: this.model,
      stream: false,
      format,
      keep_alive: this.options.keepAlive,
      ...(THINKING_FAMILIES.test(this.model) ? { think: false } : {}),
      options: { temperature: 0, num_ctx: this.options.numCtx, num_predict: request.maxOutputTokens },
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
    };
    const timeout = AbortSignal.timeout(request.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await fetch(`${this.options.baseURL}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    } catch (err) {
      if (request.signal?.aborted) throw new LlmError('aborted', 'Request cancelled');
      if (timeout.aborted) throw new LlmError('timeout', `No answer from the local model within ${Math.round(request.timeoutMs / 1000)} s`);
      throw new LlmError('network', `Ollama is not reachable at ${this.options.baseURL}${err instanceof Error && err.message ? ` (${err.message})` : ''}`);
    }

    let text: string;
    try {
      text = await res.text();
    } catch {
      if (request.signal?.aborted) throw new LlmError('aborted', 'Request cancelled');
      throw new LlmError('timeout', `The local model did not finish within ${Math.round(request.timeoutMs / 1000)} s`);
    }
    if (!res.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        /* keep raw text */
      }
      if (res.status === 404) throw new LlmError('config', `Ollama: ${message}. Run: ollama pull ${this.model}`, 404);
      if (res.status === 400) throw new LlmError('bad_request', `Ollama rejected the request: ${message}`, 400);
      throw new LlmError('server', `Ollama error ${res.status}: ${message}`, res.status);
    }

    let reply: { message?: { content?: string }; done_reason?: string; prompt_eval_count?: number; eval_count?: number };
    try {
      reply = JSON.parse(text) as typeof reply;
    } catch {
      throw new LlmError('bad_response', 'Ollama returned a response that is not JSON');
    }
    if (reply.done_reason === 'length') throw new LlmError('bad_response', `Output was cut off at ${request.maxOutputTokens} tokens`);
    const content = reply.message?.content ?? '';
    let output: unknown;
    try {
      output = JSON.parse(content);
    } catch {
      // Not JSON: hand the raw text back so the caller's schema check records what was wrong.
      output = content;
    }
    return {
      output,
      usage: { inputTokens: reply.prompt_eval_count ?? 0, outputTokens: reply.eval_count ?? 0 },
      model: this.model,
      latencyMs: Math.round(performance.now() - started),
    };
  }
}
