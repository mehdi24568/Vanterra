# Security

Vanterra is a local, single-user application that investigates a **simulated** plant and OT network. It has no industrial protocol libraries and never connects to real equipment or networks.

## Reporting

Please do not post vulnerability details in a public issue. Open an issue asking for a private contact, and details can be exchanged privately.

## Controls (each verified in code, most by tests)

| Area | Control | Evidence |
| --- | --- | --- |
| Equipment control | The simulator's controller-write functions are the only write path, and no code outside the simulator, its adapter and the evaluation harness may reference them | `src/cyber/cyber.test.ts` (*no code outside the simulator can write a controller setting*) |
| AI authority | Agents have no tools, cannot write anything, and cannot confirm a cause; outputs pass a schema gate and a grounding gate (invented evidence, assets or hypotheses, certainty and probability wording, causal overreach) | `src/agents/workflow.test.ts`; 0 of 99 adversarial answers accepted (EVALUATION.md §3) |
| Incident integrity | An AI run never changes an incident or an operator verdict | governance checks in the agent tests and in every live run |
| API key | Read only in the Node process; never sent to the browser or included in status responses; `ANTHROPIC_BASE_URL` from the environment is ignored so another tool's setting cannot redirect requests | `server/atlasAi.test.ts` |
| AI endpoint input | Body limit 400 KB; the context must match a strict schema (unknown fields such as an injected `systemPrompt` are rejected); at most two concurrent runs | `server/atlasAi.test.ts` |
| Cross-site requests | `POST /api/ai/investigate` requires `application/json` and refuses a foreign `Origin` or a cross-site `Sec-Fetch-Site`, so a website open in the same browser cannot start a run (which would cost money with Claude or hours of CPU with a local model) | `server/atlasAi.test.ts` (*refuses to start an investigation from another site*) |
| Local model | Calls go only to the configured Ollama address (default `127.0.0.1:11434`), one at a time, with a timeout and an output cap | `server/ollamaProvider.test.ts` |
| Logs | The AI service logs run IDs, status, timings and counts, not investigation content or keys | `server/atlasAi.ts` |
| Repository | `.env` files (except `.env.example`) are ignored; every commit was scanned for keys, tokens, private keys, personal email addresses and local paths before the repository was made public | docs/PUBLISHING.md |

## Known risks and limits

- **Development server.** Vanterra runs on Vite's development server, which listens on localhost by default. Do not start it with `--host` on an untrusted network: the server is a development tool, not a hardened web server.
- **Ollama has no authentication.** Any process on the machine can use the local model server. That is Ollama's design, not something Vanterra changes.
- **Gates catch patterns, not wrong reasoning.** An answer that cites real evidence but draws a wrong conclusion passes both gates. That is why AI output stays advisory and only a person confirms.
- **Dependencies.** `npm audit` (2026-11-20): 0 advisories in runtime dependencies; 9 moderate advisories in the ESLint development toolchain (through `minimatch`), which is not part of the application.
- **No persistence**, so no investigation data is stored on disk today. The desktop plan ([docs/DESKTOP_ARCHITECTURE.md](docs/DESKTOP_ARCHITECTURE.md) §11) covers storage, key storage and IPC hardening.
