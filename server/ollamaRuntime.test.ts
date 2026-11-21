/**
 * Ollama runtime management against a local stub server: use a running server as is,
 * start it only when installed and only on loopback, and report what is missing.
 */
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureOllama } from './ollamaRuntime';

let server: Server | null = null;
const listen = (port = 0) =>
  new Promise<number>((resolve) => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"version":"stub"}');
    });
    server.listen(port, '127.0.0.1', () => resolve((server!.address() as AddressInfo).port));
  });
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = null;
});

/** A free loopback port with nothing listening. */
async function freePort(): Promise<number> {
  const port = await listen();
  await new Promise((r) => server!.close(r));
  server = null;
  return port;
}

describe('Ollama runtime management', () => {
  it('uses an Ollama that is already running and starts nothing', async () => {
    const port = await listen();
    let spawned = false;
    const r = await ensureOllama({ baseURL: `http://127.0.0.1:${port}`, exe: 'C:/fake/ollama.exe', spawnFn: () => ((spawned = true), new EventEmitter() as ChildProcess) });
    expect(r.state).toBe('running');
    expect(r.child).toBeNull();
    expect(spawned).toBe(false);
  });

  it('starts `ollama serve` without a shell when installed but not running', async () => {
    const port = await freePort();
    let call: { cmd: string; args: string[]; shell: unknown } | null = null;
    const r = await ensureOllama({
      baseURL: `http://127.0.0.1:${port}`,
      exe: 'C:/fake/ollama.exe',
      waitMs: 5000,
      spawnFn: (cmd, args, options) => {
        call = { cmd, args, shell: options.shell };
        void listen(port); // the "server" comes up shortly after being started
        return Object.assign(new EventEmitter(), { kill: () => true }) as unknown as ChildProcess;
      },
    });
    expect(r.state).toBe('started');
    expect(r.child).not.toBeNull();
    expect(call).toEqual({ cmd: 'C:/fake/ollama.exe', args: ['serve'], shell: false });
  });

  it('reports a missing install, and never starts anything for a remote address', async () => {
    const port = await freePort();
    expect((await ensureOllama({ baseURL: `http://127.0.0.1:${port}`, exe: null })).state).toBe('not_installed');
    let spawned = false;
    const remote = await ensureOllama({ baseURL: 'http://192.0.2.10:11434', exe: 'C:/fake/ollama.exe', spawnFn: () => ((spawned = true), new EventEmitter() as ChildProcess) });
    expect(remote.state).toBe('remote_unreachable');
    expect(spawned).toBe(false);
  });
});
