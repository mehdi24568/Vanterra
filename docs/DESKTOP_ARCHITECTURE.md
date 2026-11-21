# Desktop architecture decision

**Goal:** download → install → launch → investigate. No terminal, no localhost URL, no ports, no configuration files, no manual Ollama start.

## Implementation status (0.4.2)

| Phase (§16) | State | Where |
| --- | --- | --- |
| 1. Shell | **Done.** Electron 45; the production build is served from `app://vanterra`; the renderer is sandboxed and isolated, with no Node access and no preload; strict CSP; navigation and new windows blocked; permission requests denied; single instance | `desktop/main.ts` |
| AI without a local server | **Done.** `/api/ai/*` requests from the page are answered inside the app by the unchanged AI service through `server/desktopBridge.ts` (3 tests), with the same checks | `server/desktopBridge.ts` |
| 2. Runtime manager | **Partly.** Ollama is detected, started if installed and not running (fixed path, no shell, loopback only), and stopped on exit only if Vanterra started it (3 tests). Default model `qwen3:1.7b`, no configuration. **Not yet:** an in-app model download | `server/ollamaRuntime.ts` |
| 3. Persistence | Not started | — |
| 4. Installer | **Done, unsigned.** NSIS, per-user, no admin rights, Start Menu and desktop shortcuts, uninstaller; 116 MB | `npm run desktop:dist` |

**Verified on the packaged app** (`scripts/smoke-desktop.mjs`, plus a normal launch):
- loads from `app://vanterra/`;
- the AI service reports available with Ollama and `qwen3:1.7b`, with zero configuration;
- WebGL2 and the 3D scene work;
- the flagship scenario, the incident and the Ask tab work;
- no console errors;
- **no listening TCP port and no UDP endpoint** owned by the app.

**Deviation from §3:** the AI service runs in the main process behind the protocol handler, not in a separate utility process over IPC. That kept the renderer and the service code unchanged, and with them every existing check and test. The service's work is network I/O to Ollama, which does not block the main process. A utility process remains the right move if CPU-heavy work is ever added there.

**Settings for power users:** `settings.json` in the app's data folder (`%APPDATA%\Vanterra`) may hold `ATLAS_*` values and, optionally, `ANTHROPIC_API_KEY`. API keys in the environment are deliberately not read, so a key set for another tool cannot start paid calls.

## 1. What exists today (verified)

| Part | Where it runs | Language | Notes |
| --- | --- | --- | --- |
| Simulation, telemetry, six detectors, graph correlation, cyber engine, cyber-physical assessment (`src/core`, `src/simulation`, `src/cyber`, …) | Browser page, main thread (`AtlasRuntime` ticks with timers) | TypeScript | Deterministic; no network, no storage |
| UI: React 19, Three.js scene, workbench | Browser page | TypeScript | Static build is 1.2 MB in `dist/` |
| AI service (`server/atlasAi.ts`): five-agent orchestrator, Claude and Ollama providers, schema and grounding gates | Node.js, as middleware inside the Vite dev/preview server | TypeScript | The only server-side code. Streams NDJSON over HTTP to the page |
| Local model | Ollama, a separate process on `127.0.0.1:11434` | external | Installed and started by the user |
| Persistence | none | — | Incidents, reports and verdicts live in memory and are lost on reload |
| Configuration | `.env.local` read by the Node process | — | Includes the optional Anthropic key |

The deterministic investigation needs no server at all; only the optional AI review does.

## 2. Decision: Electron

Use **Electron**, with the existing renderer unchanged and the AI service moved from Vite middleware into an Electron **utility process** reached over IPC.

Why, from this codebase rather than in general:

1. **The backend is Node.js and TypeScript.** The orchestrator, both providers, the zod schemas and the grounding gates run in Node today. Electron runs them as they are. Tauri's backend is Rust: keeping this code means shipping and supervising a separate Node.js sidecar (so the size advantage largely disappears and the app has two runtimes), and removing the sidecar means rewriting the orchestration and validation in Rust, which is the most safety-critical code in the project.
2. **The renderer needs no changes in either option.** Three.js on WebGL2 works in Electron's Chromium and in Tauri's WebView2 (also Chromium-based on Windows), so rendering is not a deciding factor.
3. **Memory is dominated by the model, not the shell.** The measured local model process uses about 4.8–6.6 GB on the development laptop ([LOCAL_AI.md](LOCAL_AI.md)). A lighter shell would save a small fraction of that; it does not change which machines can run the AI review.
4. **Packaging for Windows is mature:** an NSIS per-user installer (no administrator rights), Start Menu entry, optional desktop shortcut, uninstaller and update channel are standard with electron-builder.

**Accepted costs:** a larger installer than Tauri (Electron bundles Chromium and Node.js), and keeping Electron updated for security fixes.

**Rejected:** a plain browser plus local server (still requires a localhost URL and a running server; fails the goal); Tauri (above); a native rewrite (no benefit for this product).

## 3. Target architecture

```
┌────────────────────────── Vanterra.exe (Electron) ──────────────────────────┐
│ Main process: window, lifecycle, IPC router, settings, storage, runtime     │
│               manager (Ollama detection/start/stop, model management)       │
│      │ contextBridge (narrow, typed API)          │ MessagePort              │
│ Renderer (sandboxed): React UI, Three.js,     Utility process "ai":          │
│ deterministic core (unchanged)                orchestrator, providers,      │
│                                               schema + grounding gates      │
└───────────────────────────────────────────────────────│─────────────────────┘
                                                        │ HTTP, 127.0.0.1 only
                                                Ollama (external runtime)
```

## 4. Component boundaries

| Component | Owns | Must not |
| --- | --- | --- |
| Renderer | UI, 3D scene, simulation and all deterministic engines | Touch the filesystem, spawn processes, hold API keys, call model servers |
| Preload | A fixed API: `ai.status()`, `ai.investigate(context)` → event stream, `ai.cancel(runId)`, `models.list/pull/remove`, `store.save/load/list` | Expose `ipcRenderer`, Node APIs or generic channels |
| Main | Window and app lifecycle, settings, storage, process supervision | Run model inference or long computations |
| AI utility process | `runInvestigation`, providers, validation | Write files, spawn processes, receive anything except validated contexts |

## 5. Simulation integration

Unchanged: the deterministic core stays in the renderer. Moving it into a Web Worker would keep the UI responsive during heavy simulation, but that is only worth doing if profiling shows main-thread stalls; it is not a prerequisite.

## 6. Backend integration

`src/runtime/AiService.ts` currently `fetch`es `/api/ai/status` and `/api/ai/investigate`. In the desktop build it calls the preload API instead, behind the same interface, so the components do not change. The HTTP middleware remains for the web/dev build. The payload is validated with the existing `ContextSchema` at the IPC boundary, exactly as at the HTTP boundary today. With no localhost server in the product, the cross-site request risk addressed in `rejectForeignRequest` disappears for desktop users.

## 7. Application lifecycle

1. Single-instance lock; show the window immediately with a loading state.
2. Start the AI utility process; probe the runtime (below) in the background. The deterministic investigation is usable before the probe finishes.
3. Status strip shows *AI: ready / model missing / runtime not installed / busy*.
4. On close: cancel running investigations (the providers already honour cancellation), stop the utility process, stop Ollama **only if Vanterra started it**, flush storage.

## 8. Persistence

Minimum: JSON documents (incident snapshots, AI reports with their audit trail, operator verdicts) under `app.getPath('userData')`, written atomically by the main process. No database until queries require one. Reports already carry hashes and versions, which allows detecting stale reports on reload.

## 9. Local AI orchestration and inference runtime

| Option | Assessment |
| --- | --- |
| **A. Managed Ollama (recommended for the first release)** | Already integrated and run live ([LOCAL_AI.md](LOCAL_AI.md)). Vanterra detects it (`/api/version`), starts `ollama serve` if installed but not running (fixed executable path, no shell), lists models (`/api/tags`), downloads with progress (`/api/pull`) and removes (`/api/delete`). Cost: an external install the user must accept; Vanterra must not stop an Ollama instance it did not start. |
| B. Embedded runtime (llama.cpp through Node bindings, in the AI utility process) | Removes the external dependency and gives direct control of context size, threads and memory mapping. Costs: Vanterra then owns model downloads, runtime updates and native binaries. Revisit only if the Ollama dependency proves to be a real adoption barrier. |
| C. Other engines (e.g. ONNX Runtime with DirectML for the integrated GPU) | No measured advantage on this hardware; not pursued. |
| D. Provider abstraction | `LlmProvider` (`complete` + optional `health`) already separates Claude, Ollama and the test double. Option B would be one more provider. No change needed. |

**Model setup experience (future):** detect runtime → show compatible models with their download size, memory need and expected speed on this machine → download with progress and cancel → verify with a short structured-output test → enable AI review. Until then, the AI tab says exactly which step is missing (this part exists today).

Licences to confirm at release time: Ollama (MIT), the chosen model (Qwen3 is published under Apache-2.0), Electron (MIT).

## 10. IPC

Typed request/response for status and model management; a `MessagePort` per investigation for the event stream and cancellation. Every message from the renderer is validated in the receiving process.

## 11. Security

- Renderer: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict Content-Security-Policy, navigation and new windows blocked, app content served from a custom protocol rather than a local web server.
- No shell execution anywhere; only fixed executables (Ollama) at resolved paths.
- The AI has no tools and no write access; its output stays advisory, and only an operator can confirm (unchanged invariants, enforced by tests).
- Optional Anthropic key stored with Electron `safeStorage` (Windows DPAPI), never in plain-text configuration; never sent to the renderer.
- Logs record run IDs, timings and counts, never investigation content or keys (the current service already logs only these).
- No industrial protocol libraries; the simulator's single write path stays internal (enforced by an existing test).

## 12. Packaging and distribution

electron-builder → NSIS, per-user install, Start Menu entry, optional desktop shortcut, uninstaller. Releases on GitHub. Without a code-signing certificate Windows SmartScreen will warn on first run; signing is a paid prerequisite for a frictionless public release and is deferred.

## 13. Offline use

Everything works offline except downloading a model and the optional Claude provider. No telemetry.

## 14. Updates

electron-updater against GitHub Releases, after code signing is in place. Model updates stay manual and explicit.

## 15. Migration risks

| Risk | Mitigation |
| --- | --- |
| Local AI is slow on 16 GB laptops with other apps open (measured: hours per investigation under memory pressure) | Explain requirements before download; show expected duration; keep AI optional |
| Ollama not installed | Guided install step; deterministic investigation unaffected |
| Unsigned installer flagged by SmartScreen or antivirus | Document; sign before wide distribution |
| Two transports (HTTP for web, IPC for desktop) diverge | One `AiService` interface with two thin adapters; the same tests run against both |
| Losing work on crash | Atomic writes; save reports as they finish |

## 16. Migration phases

1. **Shell:** Electron app loading the existing production build from a custom protocol; AI service in a utility process over IPC; settings for provider and model. Exit: everything the web app does works without a terminal.
2. **Runtime manager:** Ollama detection, start/stop, model list/download/remove with progress; requirement checks.
3. **Persistence:** save and reopen investigations, reports and verdicts.
4. **Installer:** NSIS installer, Start Menu, shortcut, uninstaller; GitHub Release.
5. **Later:** code signing and auto-update; optional embedded runtime (Option B) if justified.

## 17. Minimum viable standalone release

Phases 1, 2 and 4: an installer that puts Vanterra in the Start Menu, opens a window, runs the full deterministic investigation offline, detects Ollama and a model, and runs the AI review with the existing validation. Persistence (phase 3) follows immediately after.
