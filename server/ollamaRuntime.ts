/**
 * Local model runtime management for the desktop app: make sure Ollama is serving, without
 * asking the user to open a terminal.
 *
 * - Already running (the Ollama tray app usually starts it at login): use it, change nothing.
 * - Installed but not running: start `ollama serve` (fixed executable path, no shell, hidden
 *   window) and remember that Vanterra started it, so it is stopped again on exit.
 * - Not installed: report it; the app explains how to get it. Nothing is downloaded here.
 * Only a loopback address is ever started; a remote Ollama URL is used as configured.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type OllamaState = 'running' | 'started' | 'not_installed' | 'remote_unreachable' | 'failed';

export interface OllamaRuntime {
  state: OllamaState;
  /** Set only when Vanterra started the server. */
  child: ChildProcess | null;
}

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export function findOllama(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'), env.ProgramFiles && join(env.ProgramFiles, 'Ollama', 'ollama.exe')];
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? null;
}

export async function ollamaReachable(baseURL: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${baseURL}/api/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

const isLoopback = (baseURL: string) => {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname);
  } catch {
    return false;
  }
};

export async function ensureOllama(opts: { baseURL: string; exe: string | null; waitMs?: number; spawnFn?: SpawnFn }): Promise<OllamaRuntime> {
  if (await ollamaReachable(opts.baseURL)) return { state: 'running', child: null };
  if (!isLoopback(opts.baseURL)) return { state: 'remote_unreachable', child: null };
  if (!opts.exe) return { state: 'not_installed', child: null };

  const child = (opts.spawnFn ?? (spawn as SpawnFn))(opts.exe, ['serve'], { windowsHide: true, stdio: 'ignore', shell: false });
  child.on?.('error', () => {
    /* reported through the reachability check below */
  });
  const deadline = Date.now() + (opts.waitMs ?? 15_000);
  while (Date.now() < deadline) {
    if (await ollamaReachable(opts.baseURL, 1000)) return { state: 'started', child };
    await new Promise((r) => setTimeout(r, 400));
  }
  child.kill?.();
  return { state: 'failed', child: null };
}
