/**
 * The Ollama provider against a local HTTP stub of Ollama's API.
 * These prove the request shape, readiness check, error mapping and the integration with
 * the real agent workflow. They do NOT exercise a real model: no model is downloaded.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildInvestigationContext } from '../src/agents/buildContext';
import { runInvestigation } from '../src/agents/orchestrator';
import { LlmError } from '../src/agents/provider';
import { EvidenceAnalystSchema } from '../src/agents/schemas';
import type { AgentId } from '../src/agents/schemas';
import { mechanicalAnswer } from '../src/agents/testing/scriptedProvider';
import { boot } from '../src/runtime/testHarness';
import { configureAi, createAiService } from './atlasAi';
import { OllamaProvider } from './ollamaProvider';

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
let server: Server | null = null;

async function stub(handler: Handler): Promise<string> {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handler(req, body, res));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
const send = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = null;
});

const provider = (baseURL: string, model = 'qwen3:4b') => new OllamaProvider({ baseURL, model, numCtx: 8192, keepAlive: '5m' });
const request = (overrides: Partial<Parameters<OllamaProvider['complete']>[0]> = {}) => ({
  name: 'evidence_analyst',
  system: 'You are the Evidence Analyst.',
  user: '{"anomalies":[]}',
  schema: EvidenceAnalystSchema,
  maxOutputTokens: 2000,
  timeoutMs: 2000,
  ...overrides,
});

describe('Ollama provider (local inference) against a protocol stub', () => {
  it('sends a structured-output chat request with the agent schema, no thinking, temperature 0', async () => {
    let seen: Record<string, unknown> = {};
    const url = await stub((req, body, res) => {
      seen = { path: req.url, ...JSON.parse(body) };
      send(res, 200, { message: { content: '{"summary":"ok"}' }, done_reason: 'stop', prompt_eval_count: 812, eval_count: 40 });
    });
    const out = await provider(url).complete(request());
    expect(seen.path).toBe('/api/chat');
    expect(seen.model).toBe('qwen3:4b');
    expect(seen.stream).toBe(false);
    expect(seen.think).toBe(false);
    expect((seen.options as Record<string, unknown>).temperature).toBe(0);
    expect((seen.options as Record<string, unknown>).num_predict).toBe(2000);
    // The workflow allows 16k output tokens; locally that is capped so a looping answer stops.
    await provider(url).complete(request({ maxOutputTokens: 16_000 }));
    expect((seen.options as Record<string, unknown>).num_predict).toBe(4096);
    const format = seen.format as Record<string, unknown>;
    expect(format.type).toBe('object');
    expect(format.additionalProperties).toBe(false);
    expect(Object.keys(format.properties as object)).toContain('observations');
    expect((seen.messages as { role: string }[]).map((m) => m.role)).toEqual(['system', 'user']);
    expect(out.output).toEqual({ summary: 'ok' });
    expect(out.usage).toEqual({ inputTokens: 812, outputTokens: 40 });
  });

  it('does not send a think flag to models without thinking', async () => {
    let seen: Record<string, unknown> = {};
    const url = await stub((_req, body, res) => {
      seen = JSON.parse(body);
      send(res, 200, { message: { content: '{}' }, done_reason: 'stop' });
    });
    await provider(url, 'qwen2.5:3b').complete(request());
    expect('think' in seen).toBe(false);
  });

  it('reports readiness honestly: not running, model missing, ready', async () => {
    expect((await provider('http://127.0.0.1:9').health()).reason).toMatch(/not reachable/);
    const url = await stub((_req, _body, res) => send(res, 200, { models: [{ name: 'llama3.2:3b', model: 'llama3.2:3b' }] }));
    const missing = await provider(url).health();
    expect(missing.ok).toBe(false);
    expect(missing.reason).toMatch(/ollama pull qwen3:4b/);
    expect((await provider(url, 'llama3.2:3b').health()).ok).toBe(true);
  });

  it('maps failures to typed errors and never returns non-JSON as an answer', async () => {
    let mode = 'missing';
    const url = await stub((_req, _body, res) => {
      if (mode === 'missing') send(res, 404, { error: "model 'qwen3:4b' not found" });
      else if (mode === 'bad') send(res, 400, { error: 'invalid format' });
      else if (mode === 'cut') send(res, 200, { message: { content: '{"summ' }, done_reason: 'length' });
      else if (mode === 'text') send(res, 200, { message: { content: 'Here is my analysis...' }, done_reason: 'stop' });
      else if (mode === 'slow') setTimeout(() => send(res, 200, { message: { content: '{}' } }), 1500);
    });
    const p = provider(url);
    await expect(p.complete(request())).rejects.toMatchObject({ kind: 'config' });
    mode = 'bad';
    await expect(p.complete(request())).rejects.toMatchObject({ kind: 'bad_request' });
    mode = 'cut';
    await expect(p.complete(request())).rejects.toMatchObject({ kind: 'bad_response' });
    mode = 'text';
    expect((await p.complete(request())).output).toBe('Here is my analysis...');
    mode = 'slow';
    await expect(p.complete(request({ timeoutMs: 200 }))).rejects.toMatchObject({ kind: 'timeout' });
    const ctl = new AbortController();
    const pending = p.complete(request({ signal: ctl.signal, timeoutMs: 5000 }));
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    await expect(provider('http://127.0.0.1:9').complete(request())).rejects.toBeInstanceOf(LlmError);
    await expect(provider('http://127.0.0.1:9').complete(request())).rejects.toMatchObject({ kind: 'network' });
  });

  // Regression (first live run, qwen3:4b on a CPU): fetch abandons a request whose headers
  // take more than 300 s, and Ollama sends none until it has an answer. The provider must
  // wait as long as the agent timeout allows, so it does not use fetch for completions.
  it('waits for a late answer without a transport deadline, and reports a cut-off connection', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    let mode = 'late';
    const url = await stub((_req, _body, res) => {
      if (mode === 'late') setTimeout(() => send(res, 200, { message: { content: '{"summary":"late"}' }, done_reason: 'stop' }), 1200);
      else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"message":{"content":"{\\"summ');
        setTimeout(() => res.socket?.destroy(), 50);
      }
    });
    try {
      const out = await provider(url).complete(request({ timeoutMs: 5000 }));
      expect(out.output).toEqual({ summary: 'late' });
      expect(fetchSpy).not.toHaveBeenCalled();
      mode = 'cut';
      const cut = provider(url).complete(request({ timeoutMs: 5000 }));
      await expect(cut).rejects.toMatchObject({ kind: 'network' });
      await expect(cut).rejects.toThrow(/before the answer was complete/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // Regression (first live run): Ollama on a CPU has one slot, but two analysts start
  // together. The second must not be timed out while it waits behind the first.
  it('sends one call at a time and starts each timeout when the call is sent, within the run deadline', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let received = 0;
    const url = await stub((_req, _body, res) => {
      received++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight--;
        send(res, 200, { message: { content: '{"summary":"ok"}' }, done_reason: 'stop' });
      }, 600);
    });
    const p = provider(url);
    // Each call alone fits in 900 ms; both together take about 1200 ms.
    const both = await Promise.all([p.complete(request({ timeoutMs: 900 })), p.complete(request({ timeoutMs: 900 }))]);
    expect(both.map((r) => r.output)).toEqual([{ summary: 'ok' }, { summary: 'ok' }]);
    expect(maxInFlight).toBe(1);
    expect(both.every((r) => r.latencyMs < 900)).toBe(true);

    // The run deadline still applies to the wait: this call is never sent.
    received = 0;
    const first = p.complete(request({ timeoutMs: 5000 }));
    const late = p.complete(request({ timeoutMs: 5000, deadlineAt: Date.now() + 300 }));
    await expect(late).rejects.toMatchObject({ kind: 'timeout' });
    await first;
    expect(received).toBe(1);

    // Cancelling a queued call frees its place; later calls still run in order.
    received = 0;
    const ctl = new AbortController();
    const running = p.complete(request({ timeoutMs: 5000 }));
    const cancelled = p.complete(request({ timeoutMs: 5000, signal: ctl.signal }));
    const after = p.complete(request({ timeoutMs: 5000 }));
    ctl.abort();
    await expect(cancelled).rejects.toMatchObject({ kind: 'aborted' });
    await Promise.all([running, after]);
    expect(received).toBe(2);
    expect(maxInFlight).toBe(1);
  });

  it('is configured from the environment with zero cost and wider local time bounds', () => {
    const ai = configureAi({ ATLAS_LLM_PROVIDER: 'ollama' });
    expect(ai.provider?.id).toBe('ollama');
    expect(ai.provider?.testDouble).toBe(false);
    expect(ai.model).toBe('qwen3:4b');
    expect(ai.price).toEqual({ input: 0, output: 0 });
    expect(ai.limits.agentTimeoutMs).toBe(900_000);
  });

  it('reports itself unavailable, with the reason, when Ollama has no model', async () => {
    const url = await stub((_req, _body, res) => send(res, 200, { models: [] }));
    const service = createAiService({ ATLAS_LLM_PROVIDER: 'ollama', ATLAS_OLLAMA_URL: url });
    const s = await service.currentStatus();
    expect(s.available).toBe(false);
    expect(s.reason).toMatch(/ollama pull/);
  });

  it('runs the real five-agent workflow through the provider (stub answers, not a model)', async () => {
    const rig = boot();
    rig.adapter.trigger('cp-fan-setpoint');
    rig.run(150);
    const ctx = buildInvestigationContext(rig.core, rig.incident()!);
    const agentOf = (system: string): AgentId =>
      /Evidence Analyst/.test(system) ? 'evidence_analyst' : /Impact Analyst/.test(system) ? 'impact_analyst' : /Hypothesis Analyst/.test(system) ? 'hypothesis_analyst' : /Investigation Planner/.test(system) ? 'investigation_planner' : 'orchestrator';
    const url = await stub((_req, body, res) => {
      const b = JSON.parse(body) as { messages: { content: string }[] };
      const agent = agentOf(b.messages[0].content);
      send(res, 200, { message: { content: JSON.stringify(mechanicalAnswer(agent, JSON.parse(b.messages[1].content))) }, done_reason: 'stop', prompt_eval_count: 1000, eval_count: 100 });
    });
    const report = await runInvestigation(ctx, { provider: provider(url), limits: { agentTimeoutMs: 5000, runDeadlineMs: 20_000 }, price: { input: 0, output: 0 } });
    expect(report.status).toBe('complete');
    expect(report.provider).toBe('ollama');
    expect(report.testDouble).toBe(false);
    expect(report.estimatedCostUsd).toBe(0);
    expect(report.governance.invalidCitations).toBe(0);
    expect(report.governance.confirmedByAi).toBe(false);
  });
});
