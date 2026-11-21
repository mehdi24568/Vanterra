/**
 * The desktop bridge drives the real AI service with Fetch API requests, as the Electron
 * `app://` protocol handler does: status, streaming investigation, routing, and the
 * same-origin protection.
 */
import { describe, expect, it } from 'vitest';
import { buildInvestigationContext } from '../src/agents/buildContext';
import { boot } from '../src/runtime/testHarness';
import { createAiService } from './atlasAi';
import { handleWithMiddleware } from './desktopBridge';

const ORIGIN = 'app://vanterra';

function context() {
  const rig = boot();
  rig.adapter.trigger('mcc-sag');
  rig.run(60);
  return buildInvestigationContext(rig.core, rig.incident()!);
}

describe('desktop bridge (app:// requests to the AI service)', () => {
  it('serves status as JSON and passes non-API paths on', async () => {
    const service = createAiService({});
    const res = (await handleWithMiddleware(service.handle, new Request(`${ORIGIN}/api/ai/status`)))!;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/json/);
    expect((await res.json()).available).toBe(false);
    expect(await handleWithMiddleware(service.handle, new Request(`${ORIGIN}/index.html`))).toBeNull();
  });

  it('streams a full investigation from the page origin', async () => {
    const service = createAiService({ ATLAS_LLM_PROVIDER: 'scripted', ATLAS_ALLOW_SCRIPTED_PROVIDER: '1' });
    const res = (await handleWithMiddleware(
      service.handle,
      new Request(`${ORIGIN}/api/ai/investigate`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ context: context() }) }),
    ))!;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/ndjson/);
    const events = (await res.text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string });
    expect(events[0].type).toBe('run_started');
    expect(events.at(-1)!.type).toBe('run_finished');
  });

  it('keeps the same-origin protection: other origins and non-JSON bodies are refused', async () => {
    const service = createAiService({ ATLAS_LLM_PROVIDER: 'scripted', ATLAS_ALLOW_SCRIPTED_PROVIDER: '1' });
    const post = (headers: Record<string, string>) =>
      handleWithMiddleware(service.handle, new Request(`${ORIGIN}/api/ai/investigate`, { method: 'POST', headers, body: JSON.stringify({ context: {} }) }));
    expect((await post({ 'Content-Type': 'application/json', Origin: 'https://evil.example' }))!.status).toBe(403);
    expect((await post({ 'Content-Type': 'text/plain', Origin: ORIGIN }))!.status).toBe(415);
    expect((await post({ 'Content-Type': 'application/json', Origin: ORIGIN }))!.status).toBe(400); // passes the origin check, then the schema rejects {}
  });
});
