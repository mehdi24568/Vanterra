/**
 * Vanterra desktop: Electron main process.
 *
 * - The page is the normal production build, loaded from the private `app://vanterra`
 *   scheme. No local web server runs and no port is opened.
 * - `/api/ai/*` requests from the page are answered inside the app by the same AI service
 *   the web build uses (server/atlasAi.ts), through server/desktopBridge.ts.
 * - The renderer is sandboxed, isolated, has no Node access and no preload bridge: it can
 *   only talk to the app through those same checked HTTP-style endpoints.
 * - Ollama is used if running, started if installed (and stopped again on exit), and
 *   reported as missing otherwise. The deterministic investigation never needs it.
 *
 * Configuration: none is required. Defaults are a local Ollama with qwen3:1.7b. Advanced
 * users can put ATLAS_* settings (and optionally ANTHROPIC_API_KEY) in settings.json in the
 * app's data folder; ambient environment API keys are deliberately not picked up.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { app, BrowserWindow, Menu, protocol, session, shell } from 'electron';
import { createAiService } from '../server/atlasAi';
import { handleWithMiddleware } from '../server/desktopBridge';
import { ensureOllama, findOllama } from '../server/ollamaRuntime';
import type { OllamaRuntime } from '../server/ollamaRuntime';

const HOST = 'vanterra';
const ORIGIN = `app://${HOST}`;
const DIST = join(app.getAppPath(), 'dist');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } }]);

/** settings.json in the app data folder: optional string settings for power users. */
function loadSettings(): Record<string, string> {
  const file = join(app.getPath('userData'), 'settings.json');
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string' && /^(ATLAS_|ANTHROPIC_API_KEY$)/.test(e[0])));
  } catch {
    return {};
  }
}

function aiEnvironment(): Record<string, string> {
  const fromProcess = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string' && e[0].startsWith('ATLAS_')));
  return { ATLAS_LLM_PROVIDER: 'ollama', ATLAS_LLM_MODEL: 'qwen3:1.7b', ATLAS_OLLAMA_KEEP_ALIVE: '30m', ...fromProcess, ...loadSettings() };
}

async function serveStatic(pathname: string): Promise<Response> {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = normalize(join(DIST, rel));
  if (!file.startsWith(DIST + sep)) return new Response('Not found', { status: 404 });
  let target = file;
  try {
    if (!(await stat(file)).isFile()) target = join(DIST, 'index.html');
  } catch {
    target = join(DIST, 'index.html');
  }
  const type = CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
  const headers: Record<string, string> = { 'content-type': type, 'x-content-type-options': 'nosniff' };
  if (type.startsWith('text/html')) headers['content-security-policy'] = CSP;
  return new Response(await readFile(target), { status: 200, headers });
}

let ollama: OllamaRuntime = { state: 'running', child: null };
let win: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'Vanterra',
    backgroundColor: '#0a0d12',
    show: false,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
  });
  w.once('ready-to-show', () => w.show());
  // Stay on the app: no navigation away, no new windows; https links open in the browser.
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${ORIGIN}/`)) e.preventDefault();
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  return w;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

    const env = aiEnvironment();
    const service = createAiService(env);
    protocol.handle('app', async (request) => {
      const url = new URL(request.url);
      if (url.host !== HOST) return new Response('Not found', { status: 404 });
      if (url.pathname.startsWith('/api/')) return (await handleWithMiddleware(service.handle, request)) ?? new Response('Not found', { status: 404 });
      return serveStatic(url.pathname);
    });

    win = createWindow();
    // Start the local model server first if needed (up to ~15 s), so the AI status is right
    // on first load. The window is already visible with the app's background colour.
    if ((env.ATLAS_LLM_PROVIDER ?? 'ollama') === 'ollama') {
      ollama = await ensureOllama({ baseURL: (env.ATLAS_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''), exe: findOllama() });
      console.info(`[vanterra] ollama: ${ollama.state}`);
    }
    await win.loadURL(`${ORIGIN}/`);
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    // Stop the model server only if Vanterra started it.
    if (ollama.state === 'started') ollama.child?.kill();
  });
}
