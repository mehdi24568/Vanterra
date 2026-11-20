# Local AI with Ollama: zero API spending

Vanterra's optional five-agent review can run on a local model through [Ollama](https://ollama.com): no API key, no usage cost, and no data leaving the machine. The deterministic investigation, including the cyber-physical assessment, never needs a model.

## Status (2026-11-20)

| Item | State |
| --- | --- |
| Provider `server/ollamaProvider.ts` | **Implemented.** Ollama's native chat API with structured outputs (the agent's zod schema is sent as JSON Schema in `format`), temperature 0, `think: false` for thinking models, typed errors, readiness check |
| Validation | Unchanged: every local answer passes the same schema gate and grounding gate (evidence IDs, certainty, probability and causal-overreach wording) as any provider |
| Tests | 7 tests against a local stub of Ollama's API, including a full five-agent run through the provider. **These are not model runs.** |
| Real local inference | **Not run.** Ollama 0.40.16 is installed and running on the development machine, but **no model is downloaded**, and downloading one needs the owner's approval |

## Development-machine hardware (inspected, not assumed)

| | |
| --- | --- |
| OS | Windows 11 Pro 64-bit (build 26200) |
| CPU | Intel Core i5-1135G7, 4 cores / 8 threads |
| GPU | Intel Iris Xe (integrated). Ollama does not accelerate it, so inference runs on the CPU |
| RAM | 15.7 GB total, about 0.6 GB free at inspection time (heavily used) |
| Disk | 17.6 GB free on C: |
| Ollama | 0.40.16, server running on 127.0.0.1:11434, no models |

## Recommendation

| Model | Download | Context | Why or why not |
| --- | --- | --- | --- |
| **`qwen3:4b`** (recommended) | 2.5 GB | 256K | Best reasoning per gigabyte in this range; supports structured output; thinking is switched off. Fits in RAM with other applications closed |
| `qwen2.5:3b` (lighter fallback) | 1.9 GB | 32K | Faster on CPU and reliable at JSON; weaker reasoning |
| `phi4-mini` / `llama3.2:3b` | 2.5 / 2.0 GB | 128K | Viable alternatives |
| 7–8B models (`qwen2.5:7b`, `qwen3:8b`) | 4.7–5.2 GB | — | Not recommended here: memory pressure with 0.6 GB free, and a few tokens per second on this CPU |

Sizes and context windows are from the official ollama.com library pages, read on 2026-11-20.

**Expected performance (an estimate, not a measurement):** a CPU-only 4B model on this processor processes prompts at tens of tokens per second and generates at single-digit tokens per second. Agent inputs are about 5–12k tokens, so one agent call may take a few minutes and a full five-agent run tens of minutes. Local mode therefore defaults to a 900 s per-call timeout and a 3600 s run deadline. Quality on the grounding gates is unknown until measured.

## Enabling it (after approving the download)

1. Download the model (about 2.5 GB):
   ```
   ollama pull qwen3:4b
   ```
2. Add to `.env.local`:
   ```
   ATLAS_LLM_PROVIDER=ollama
   ATLAS_LLM_MODEL=qwen3:4b
   ```
3. Restart `npm run dev`. The status strip shows **AI: Ready** with `ollama`. If the model is missing or Ollama is not running, the AI tab says exactly that.
4. Measure it on the three fault scenarios: `npm run eval:live`. It refuses to run on a test double, so every number it writes comes from the model. Results go to `eval/results/agentic-live.md`.

## What does not change

- The deterministic engine stays the source of truth; AI output sits beside incidents and can never confirm anything.
- The scripted test double stays labelled as not a model and is never used for live results.
- No paid API is required for any part of Vanterra.
