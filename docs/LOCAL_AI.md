# Local AI with Ollama: zero API spending

Vanterra's optional five-agent review can run on a local model through [Ollama](https://ollama.com): no API key, no usage cost, and no data leaving the machine. The deterministic investigation, including the cyber-physical assessment, never needs a model.

## Status (2026-11-20)

| Item | State |
| --- | --- |
| Provider `server/ollamaProvider.ts` | **Implemented.** Ollama's native chat API with structured outputs (the agent's zod schema is sent as JSON Schema in `format`), temperature 0, `think: false` for thinking models, one call at a time, output cap, typed errors, readiness check |
| Validation | Unchanged: every local answer passes the same schema gate and grounding gate (evidence IDs, certainty, probability and causal-overreach wording) as any provider |
| Tests | 9 tests against a local stub of Ollama's API (request shape, queueing, slow answers, cut-off connections, cancellation, deadlines, output cap, a full five-agent run). **These are not model runs.** |
| Real local inference | **Run.** `qwen3:4b` (Q4_K_M, 2.33 GB) on Ollama 0.40.16, CPU only. Real agent calls inside real Vanterra investigations; measurements below and in [EVALUATION.md §4](../EVALUATION.md#4-live-language-model) |

## Development-machine hardware (inspected, not assumed)

| | |
| --- | --- |
| OS | Windows 11 Pro 64-bit (build 26200) |
| CPU | Intel Core i5-1135G7, 4 cores / 8 threads |
| GPU | Intel Iris Xe (integrated). Ollama does not accelerate it, so inference runs on the CPU |
| RAM | 15.7 GB total; typically 0.3–2.4 GB available during the runs, because other applications were open |
| Ollama | 0.40.16, `127.0.0.1:11434`, one model: `qwen3:4b` |

## Measured performance

All figures come from Ollama's own timing log on the machine above.

| Measurement | Result |
| --- | --- |
| Model download | 2.33 GB in 100 s |
| Model in memory (16k context) | 4.76 GB reported by Ollama; the runner process used 5.1–6.6 GB private memory |
| Cold load | 14 s |
| Short structured call, model resident (112-token prompt) | prompt 29 tokens/s, generation **6.1 tokens/s**, 26 s in total |
| Agent call, pump-bearing Evidence Analyst (9,328-token input) | prompt 17 tokens/s (9 min), generation **0.88 tokens/s** for 1,661 tokens (32 min): **40 min 40 s** |
| Agent call, pump-bearing Impact Analyst (5,469-token input) | prompt 23 tokens/s (4 min), generation 1.44 tokens/s for 1,301 tokens: **19 min** |
| Repair call, Evidence Analyst (10,097 tokens; 9,319 reused from Ollama's prompt cache) | generation 0.81 tokens/s for 2,104 tokens: **45 min** |

**The bottleneck is memory, not the model or the orchestration.** Generation fell from 6.1 tokens/s with the model resident to 0.8–1.4 tokens/s during the runs, while Windows reported 2,500–14,000 page reads per second, only 4–5.8 GB of the runner's 5.1–6.6 GB in RAM, and the CPU at 83–100 %. The model was being read back from the page file for every token. Long contexts cost something too (attention over ~10k tokens), but not a factor of six.

What this means in practice:

- With other applications open on a 16 GB laptop, one five-agent investigation takes **hours**: each call takes 19–45 minutes, and an investigation makes 5–10 calls (one repair per agent is allowed).
- With enough free memory to keep the model resident (roughly 6–7 GB available), the same calls should be several times faster. That is an expectation from the resident-model measurement above, not a measured investigation.
- Agent inputs are 5–10k tokens (measured with Ollama's tokenizer: 4,916–10,097). They fit in the 16,384-token context with the 4,096-token output cap; no prompt was truncated (`truncated = 0` on every call).

## Reliability fixes found by running it for real

The first live runs exposed three defects that the stub tests could not, because the stub answers instantly. Each is fixed and has a regression test:

1. **Five-minute transport deadline.** Node's `fetch` gives up when response headers take more than 300 s; Ollama sends none until it has an answer (or, streaming, until the first token, after reading the whole input). Every agent call on this machine failed at exactly 5 min. The provider now uses `node:http`, whose only deadline is the agent timeout.
2. **Timeouts spent in a queue.** Ollama on a CPU serves one request at a time, but the workflow starts two analysts together; the second one's timeout ran while it waited. Calls are now queued in the provider, each timeout starts when the call is sent, and the run deadline still bounds the wait. Cancelling a queued call frees its place.
3. **Unbounded generation.** The workflow allows 16,000 output tokens; at 1 token/s a looping answer could run for hours. Local output is capped at 4,096 tokens (complete answers are about 400–2,100), configurable with `ATLAS_OLLAMA_NUM_PREDICT`.
4. **Overlong answers (0.4.1).** The installed 0.4.0 desktop app spent 16 minutes on one agent: 1,930 tokens at 2.45 tokens/s, because nothing limited list lengths. The JSON Schema sent to Ollama now caps every list at 6 items (`maxItems`, enforced while the model generates; `ATLAS_OLLAMA_MAX_LIST_ITEMS`), and the shared agent rules ask for the 3–5 most important items. Vanterra's own validation is unchanged. The AI tab now also says how long a local review takes and points to Ask for quick answers.
5. **Still too slow for a laptop (0.4.2).** Measured on the installed 0.4.1: answers were about a third shorter (first agent 1,290 tokens instead of 1,930), but a full five-agent review still took about 45 minutes, because generation slows sharply with long inputs: 8.7 tokens/s on a 2,190-token request, 4.0 on 4,800, and 1.5–2.6 on 8,500. Two changes:
   - **Quick AI review** is now the main AI action with a local model. It is one checked answer through the Ask path (best-supported explanation, what argues against it, the two most useful checks), the same path that answered in 57 s. The five-agent review remains as the deep option, labelled as slow.
   - **The first agent reads 28% less** (17,493 → 12,575 characters on the flagship incident): detections and cyber events are passed as identities and values, without detector internals. Citable IDs are unchanged.
6. **Quick AI review stuck behind the full review (0.4.3).** Measured on the installed 0.4.2: the Quick AI review itself needed about a minute of model time (2,439 tokens read in 31 s, 227 written in 28 s), but it waited about 8 minutes behind two queued five-agent review steps, because calls were served first come, first served. Interactive questions (Ask, Quick AI review) now go next after the call already running (regression test). The Ask tab says when it is waiting for a review step, and the button cannot be pressed again while a question is pending. A separate measurement through the same code on the flagship incident, with the model free: 3,876 tokens read in 56 s, 204 written in 38 s, about **1.5 minutes**, and the answer passed every check with 6 real citations.

Defaults for local mode now come from these measurements: 3600 s per call and 14400 s per run (they were 900 s and 3600 s, which could not succeed on this machine). Runs can be cancelled at any time.

## Enabling it

1. Install [Ollama](https://ollama.com) and download the model (about 2.3 GB):
   ```
   ollama pull qwen3:4b
   ```
2. Create `.env.local` in the project root:
   ```
   ATLAS_LLM_PROVIDER=ollama
   ATLAS_LLM_MODEL=qwen3:4b
   ```
3. Restart `npm run dev`. The status strip shows **AI: Ready** with `ollama`. If the model is missing or Ollama is not running, the AI tab says exactly that.
4. Close memory-heavy applications before starting an investigation; see the measurements above.
5. To measure it: `npm run eval:live -- --testTimeout=36000000`. It refuses to run on a test double, so every number it writes comes from the model. `ATLAS_LIVE_SCENARIOS=cp-fan-setpoint` limits it to the flagship cyber-physical case. Results go to `eval/results/agentic-live.{json,md}` after every scenario.

## Model choice

| Model | Download | Context | Notes |
| --- | --- | --- | --- |
| **`qwen3:1.7b`** (default in the app now) | 1.3 GB | 32K | Fits in memory on a busy 16 GB laptop. Measured: 11.2 tokens/s on a short call; **Ask answers in about 1 minute** (2.5k-token input at 60 tokens/s, then 5–7 tokens/s). Weaker reasoning than 4B; the checks still apply |
| `qwen3:4b` | 2.3 GB | 256K | Better reasoning; on this machine it paged and generated at 0.5–1.4 tokens/s during the agent runs |
| `qwen2.5:3b` | 1.9 GB | 32K | Alternative; not measured |
| 7–8B models | 4.7–5.2 GB | — | Not recommended on this hardware: the 4B model already pages |

Sizes and context windows are from the official ollama.com library pages, read on 2026-11-20.

## What does not change

- The deterministic engine stays the source of truth; AI output sits beside incidents and can never confirm anything.
- The scripted test double stays labelled as not a model and is never used for live results.
- No paid API is required for any part of Vanterra.
