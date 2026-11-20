/**
 * ATLAS AI service - a small server-side API mounted on the Vite dev and preview servers.
 *
 *   GET  /api/ai/status        is an AI provider configured? (never returns key material)
 *   POST /api/ai/investigate   run the agent workflow on a posted investigation context;
 *                              streams progress as newline-delimited JSON
 *
 * Why a server at all: an API key bundled into a browser application is public.
 * Here the key stays in the Node process; the browser sends a strictly-validated
 * context document and receives a report. The endpoint cannot be used as a general
 * proxy to the model, because prompts are fixed on this side and the only caller
 * input is the schema-checked context.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { ContextSchema } from '../src/agents/context';
import { DEFAULT_LIMITS, runInvestigation } from '../src/agents/orchestrator';
import type { LlmProvider } from '../src/agents/provider';
import type { RunEvent } from '../src/agents/report';
import { ScriptedProvider } from '../src/agents/testing/scriptedProvider';
import { AnthropicProvider } from './anthropicProvider';
import { OllamaProvider } from './ollamaProvider';
import type { Effort } from './anthropicProvider';

export interface AiStatus {
  available: boolean;
  provider: string;
  model: string | null;
  effort: string | null;
  /** True when the configured provider is the scripted test double, not a model. */
  testDouble: boolean;
  reason: string | null;
  limits: { maxModelCalls: number; agentTimeoutS: number; runDeadlineS: number };
}

type Env = Record<string, string | undefined>;

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_BODY_BYTES = 400_000;
const MAX_CONCURRENT_RUNS = 2;

function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Turns environment variables into a provider, limits and price.
 * Shared by the server middleware and the command-line verification/evaluation
 * scripts, so both exercise exactly the same configuration path.
 */
export function configureAi(env: Env) {
  const providerName = (env.ATLAS_LLM_PROVIDER ?? 'anthropic').trim().toLowerCase();
  const model = env.ATLAS_LLM_MODEL?.trim() || 'claude-opus-5-5';
  const effort = EFFORTS.includes(env.ATLAS_LLM_EFFORT as Effort) ? (env.ATLAS_LLM_EFFORT as Effort) : 'medium';
  const limits = {
    ...DEFAULT_LIMITS,
    agentTimeoutMs: positive(env.ATLAS_LLM_AGENT_TIMEOUT_S, DEFAULT_LIMITS.agentTimeoutMs / 1000) * 1000,
    runDeadlineMs: positive(env.ATLAS_LLM_RUN_DEADLINE_S, DEFAULT_LIMITS.runDeadlineMs / 1000) * 1000,
  };
  const priceIn = Number(env.ATLAS_LLM_PRICE_INPUT);
  const priceOut = Number(env.ATLAS_LLM_PRICE_OUTPUT);
  const price = Number.isFinite(priceIn) && Number.isFinite(priceOut) && priceIn > 0 && priceOut > 0 ? { input: priceIn, output: priceOut } : null;

  let provider: LlmProvider | null = null;
  let reason: string | null = null;
  const apiKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
  const authToken = env.ANTHROPIC_AUTH_TOKEN?.trim() || undefined;

  if (providerName === 'none') {
    reason = 'AI investigation is switched off (ATLAS_LLM_PROVIDER=none).';
  } else if (providerName === 'scripted') {
    if (env.ATLAS_ALLOW_SCRIPTED_PROVIDER === '1') provider = new ScriptedProvider({}, 700);
    else reason = 'The scripted test double is not enabled (set ATLAS_ALLOW_SCRIPTED_PROVIDER=1 for interface testing).';
  } else if (providerName === 'anthropic') {
    if (apiKey || authToken) {
      provider = new AnthropicProvider({
        apiKey,
        authToken,
        // Deliberately not read from ANTHROPIC_BASE_URL: an ambient value set for another
        // tool on this machine must not silently redirect requests.
        baseURL: env.ATLAS_LLM_BASE_URL?.trim() || 'https://api.anthropic.com',
        model,
        effort,
        refusalFallback: (env.ATLAS_LLM_REFUSAL_FALLBACK ?? 'default').trim().toLowerCase() !== 'off',
      });
    } else {
      reason = 'No API key configured. Set ANTHROPIC_API_KEY in .env.local and restart the server.';
    }
  } else if (providerName === 'ollama') {
    // Local inference: no key, no cost. CPU inference is slow, so the bounds are wider
    // unless set explicitly.
    const local = env.ATLAS_LLM_MODEL?.trim() || 'qwen3:4b';
    provider = new OllamaProvider({
      baseURL: (env.ATLAS_OLLAMA_URL?.trim() || 'http://127.0.0.1:11434').replace(/\/$/, ''),
      model: local,
      numCtx: positive(env.ATLAS_OLLAMA_NUM_CTX, 16384),
      keepAlive: env.ATLAS_OLLAMA_KEEP_ALIVE?.trim() || '10m',
      maxOutputTokens: positive(env.ATLAS_OLLAMA_NUM_PREDICT, 4096),
    });
    // Measured on a CPU-only laptop (i5-1135G7, 16 GB, qwen3:4b): single calls took 19–45 min
    // under memory pressure and an investigation needs 5–10 calls, so the earlier 15 min /
    // 1 h bounds could not succeed. Runs can still be cancelled at any time.
    limits.agentTimeoutMs = positive(env.ATLAS_LLM_AGENT_TIMEOUT_S, 3600) * 1000;
    limits.runDeadlineMs = positive(env.ATLAS_LLM_RUN_DEADLINE_S, 14_400) * 1000;
    return { providerName, provider, reason, model: local, effort, limits, price: { input: 0, output: 0 } };
  } else {
    reason = `Unknown ATLAS_LLM_PROVIDER "${providerName}". Supported: anthropic, ollama, none.`;
  }
  return { providerName, provider, reason, model, effort, limits, price };
}

/**
 * Only the app's own page may start an investigation. Any website open in the same
 * browser can send a "simple" cross-site POST (text/plain, no CORS preflight) to
 * localhost, and the run would start even though the page could not read the answer:
 * paid API calls with Claude, hours of CPU with a local model. Requiring JSON forces a
 * preflight, which this server never approves, and a foreign Origin or a cross-site
 * Sec-Fetch-Site header is refused outright.
 */
export function rejectForeignRequest(req: IncomingMessage): { code: number; message: string } | null {
  const h = req.headers ?? {};
  const type = String(h['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return { code: 415, message: 'Content-Type must be application/json.' };
  const site = String(h['sec-fetch-site'] ?? '');
  if (site && site !== 'same-origin' && site !== 'none') return { code: 403, message: 'Cross-site requests are not accepted.' };
  if (h.origin) {
    let host = '';
    try {
      host = new URL(String(h.origin)).host;
    } catch {
      /* unparseable origin: refused below */
    }
    if (!host || host !== h.host) return { code: 403, message: 'Cross-origin requests are not accepted.' };
  }
  return null;
}

export function createAiService(env: Env) {
  const { providerName, provider, reason, effort, limits, price } = configureAi(env);

  const status: AiStatus = {
    available: provider !== null,
    provider: provider?.id ?? providerName,
    model: provider ? provider.model : null,
    effort: provider && !provider.testDouble ? effort : null,
    testDouble: provider?.testDouble ?? false,
    reason,
    limits: {
      maxModelCalls: 5 * limits.maxAttemptsPerAgent,
      agentTimeoutS: Math.round(limits.agentTimeoutMs / 1000),
      runDeadlineS: Math.round(limits.runDeadlineMs / 1000),
    },
  };

  let activeRuns = 0;

  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('too_large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  /** Current status; providers with a health check (local models) are probed each time. */
  async function currentStatus(): Promise<AiStatus> {
    if (!provider?.health) return status;
    const h = await provider.health();
    return { ...status, available: h.ok, reason: h.reason };
  }

  async function investigate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const foreign = rejectForeignRequest(req);
    if (foreign) {
      req.resume();
      return json(res, foreign.code, { error: 'forbidden', message: foreign.message });
    }
    if (!provider) return json(res, 503, { error: 'ai_unavailable', message: reason });
    if (provider.health) {
      const h = await provider.health();
      if (!h.ok) return json(res, 503, { error: 'ai_unavailable', message: h.reason });
    }
    if (activeRuns >= MAX_CONCURRENT_RUNS) return json(res, 429, { error: 'busy', message: 'Another investigation is still running. Try again shortly.' });

    let body: string;
    try {
      body = await readBody(req);
    } catch (err) {
      return json(res, err instanceof Error && err.message === 'too_large' ? 413 : 400, { error: 'bad_request', message: 'Request body could not be read or is too large.' });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return json(res, 400, { error: 'bad_request', message: 'Body is not valid JSON.' });
    }
    const parsed = ContextSchema.safeParse((payload as { context?: unknown })?.context);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return json(res, 400, { error: 'invalid_context', message: `Investigation context rejected: ${first.path.join('.')} ${first.message}` });
    }

    activeRuns += 1;
    const controller = new AbortController();
    let finished = false;
    // If the browser goes away, stop spending tokens.
    res.on('close', () => {
      if (!finished) controller.abort();
    });
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const send = (event: RunEvent) => {
      if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
    };
    try {
      const report = await runInvestigation(parsed.data, { provider, limits, emit: send, signal: controller.signal, price });
      console.info(
        `[atlas-ai] ${report.runId} ${report.incidentId} ${report.status} in ${report.durationMs} ms, ${report.governance.modelCalls} calls, ` +
          `${report.usage.inputTokens}+${report.usage.outputTokens} tokens, ${report.governance.claimsRejected} claims rejected`,
      );
    } catch (err) {
      console.error('[atlas-ai] workflow error', err);
      send({ type: 'run_failed', message: 'The investigation workflow stopped unexpectedly.' });
    } finally {
      finished = true;
      activeRuns -= 1;
      res.end();
    }
  }

  function handle(req: IncomingMessage, res: ServerResponse, next: () => void): void {
    const url = (req.url ?? '').split('?')[0];
    if (url === '/api/ai/status' && req.method === 'GET') {
      void currentStatus().then((s) => json(res, 200, s));
      return;
    }
    if (url === '/api/ai/investigate' && req.method === 'POST') {
      void investigate(req, res);
      return;
    }
    if (url.startsWith('/api/ai/')) return json(res, 404, { error: 'not_found' });
    next();
  }

  return { status, currentStatus, handle };
}

/** Vite plugin: mounts the service on both the dev server and `vite preview`. */
export function atlasAi(env: Env): Plugin {
  const service = createAiService(env);
  return {
    name: 'atlas-ai',
    configureServer(server) {
      server.middlewares.use(service.handle);
      const s = service.status;
      server.config.logger.info(`  [atlas-ai] ${s.available ? `${s.provider} · ${s.model}${s.testDouble ? ' (TEST DOUBLE, not a model)' : ''}` : `unavailable: ${s.reason}`}`);
    },
    configurePreviewServer(server) {
      server.middlewares.use(service.handle);
    },
  };
}
