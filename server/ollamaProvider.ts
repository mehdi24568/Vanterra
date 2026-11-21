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
 *
 * Transport: node:http, not fetch. Node's fetch (undici) abandons a request when the
 * response headers take more than 300 s, and Ollama sends none until it has an answer
 * (or, when streaming, until the first token). On a CPU, reading a 10k-token agent
 * input alone can take longer than that. Found by the first live run on qwen3:4b; the
 * only deadline now is the agent timeout the orchestrator sets.
 *
 * Queueing: on a CPU, Ollama serves one request at a time (one slot), but the workflow
 * starts two analysts together. Calls are therefore queued here, and each agent's timeout
 * starts when its call is actually sent, so the second analyst is not timed out while it
 * waits behind the first. The run deadline still bounds the wait. Also found by the
 * first live run.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
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
  /**
   * Upper bound on generated tokens per call. A complete agent answer is roughly
   * 400–1,800 tokens; the cap stops a small model that loops inside a JSON list from
   * running for hours on a CPU. Default 4096.
   */
  maxOutputTokens?: number;
  /**
   * Upper bound on items per list in the JSON Schema sent to Ollama (`maxItems`). Ollama
   * enforces it while generating, so a small model cannot write 15 observations at a few
   * tokens per second. Vanterra's own validation is unchanged. Default 6; 0 disables.
   */
  maxListItems?: number;
}

const THINKING_FAMILIES = /^(qwen3|deepseek-r1|gpt-oss|magistral)/i;

/** Adds `maxItems` to every array in a JSON Schema that has no tighter limit. Returns a copy. */
export function capArrays(schema: unknown, maxItems: number): unknown {
  if (Array.isArray(schema)) return schema.map((s) => capArrays(s, maxItems));
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) out[k] = capArrays(v, maxItems);
  if (out.type === 'array' && (typeof out.maxItems !== 'number' || out.maxItems > maxItems)) out.maxItems = maxItems;
  return out;
}

/**
 * One call at a time (Ollama on a CPU has one slot), in priority order: an interactive
 * question waits only for the call already running, not behind a queued five-agent review.
 * Within a priority, first come first served. A cancelled waiter leaves the queue.
 */
class CallQueue {
  private busy = false;
  private seq = 0;
  private waiting: { priority: number; seq: number; start: () => void }[] = [];

  acquire(priority: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new LlmError('aborted', 'Request cancelled'));
    if (!this.busy) {
      this.busy = true;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        priority,
        seq: ++this.seq,
        start: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        const i = this.waiting.indexOf(waiter);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(new LlmError('aborted', 'Request cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  release(): void {
    this.waiting.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    const next = this.waiting.shift();
    if (next) next.start();
    else this.busy = false;
  }
}

/** POST a JSON body and read the whole reply, with no deadline other than `signal`. */
function postJson(url: URL, body: string, signal: AbortSignal): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, signal }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      const cutOff = () => reject(new Error('the connection closed before the answer was complete'));
      res.on('error', cutOff);
      res.on('close', () => {
        if (!res.complete) cutOff();
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama';
  readonly testDouble = false;
  readonly model: string;
  private readonly queue = new CallQueue();

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
    await this.queue.acquire(request.priority === 'interactive' ? 1 : 0, request.signal);
    try {
      const left = (request.deadlineAt ?? Infinity) - Date.now();
      if (left <= 1000) throw new LlmError('timeout', 'The run deadline was reached while this call waited for the local model');
      return await this.send({ ...request, timeoutMs: Math.min(request.timeoutMs, left) });
    } finally {
      this.queue.release();
    }
  }

  private outputCap(requested: number): number {
    return Math.min(requested, this.options.maxOutputTokens ?? 4096);
  }

  private async send<T>(request: LlmRequest<T>): Promise<LlmResponse> {
    const started = performance.now();
    const schema = z.toJSONSchema(request.schema as z.ZodType) as Record<string, unknown>;
    delete schema.$schema;
    const listCap = this.options.maxListItems ?? 6;
    const format = listCap > 0 ? capArrays(schema, listCap) : schema;
    const body = {
      model: this.model,
      stream: false,
      format,
      keep_alive: this.options.keepAlive,
      ...(THINKING_FAMILIES.test(this.model) ? { think: false } : {}),
      options: { temperature: 0, num_ctx: this.options.numCtx, num_predict: this.outputCap(request.maxOutputTokens) },
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
    };
    const timeout = AbortSignal.timeout(request.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

    let status: number;
    let text: string;
    try {
      ({ status, text } = await postJson(new URL(`${this.options.baseURL}/api/chat`), JSON.stringify(body), signal));
    } catch (err) {
      if (request.signal?.aborted) throw new LlmError('aborted', 'Request cancelled');
      if (timeout.aborted) throw new LlmError('timeout', `No answer from the local model within ${Math.round(request.timeoutMs / 1000)} s`);
      const detail = err instanceof Error && err.message ? ` (${err.message})` : '';
      if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED') throw new LlmError('network', `Ollama is not reachable at ${this.options.baseURL}${detail}`);
      throw new LlmError('network', `The connection to Ollama at ${this.options.baseURL} failed${detail}`);
    }
    if (status < 200 || status >= 300) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        /* keep raw text */
      }
      if (status === 404) throw new LlmError('config', `Ollama: ${message}. Run: ollama pull ${this.model}`, 404);
      if (status === 400) throw new LlmError('bad_request', `Ollama rejected the request: ${message}`, 400);
      throw new LlmError('server', `Ollama error ${status}: ${message}`, status);
    }

    let reply: { message?: { content?: string }; done_reason?: string; prompt_eval_count?: number; eval_count?: number };
    try {
      reply = JSON.parse(text) as typeof reply;
    } catch {
      throw new LlmError('bad_response', 'Ollama returned a response that is not JSON');
    }
    if (reply.done_reason === 'length') throw new LlmError('bad_response', `Output was cut off at ${this.outputCap(request.maxOutputTokens)} tokens`);
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
