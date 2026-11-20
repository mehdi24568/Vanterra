# Contributing to Vanterra

## Setup

Node.js 20 or newer. On Windows, `start-vanterra.cmd` uses Node.js from PATH, or a portable Node.js unpacked into `.tools/node` (ignored by Git).

```bash
npm install
```

```bash
npm run dev
```

Before sending a change:

```bash
npm run check
```

```bash
npm run eval
```

`check` runs the type-check (strict), ESLint and the 135 tests. `eval` runs the offline evaluation suites (including the independent scenarios) and rewrites `eval/results/`. If a change alters a result, update EVALUATION.md with the new numbers and the reason.

## Rules the code relies on

These are properties the tests and the evaluation enforce. A change that breaks one needs a very good reason and a matching change to the documentation.

1. **The deterministic engine is the source of truth.** It runs in the browser with no network and no key. AI output never changes an incident, a hypothesis score or a disposition.
2. **Only an operator confirms.** `IntelligenceEngine.setDisposition` is the only path to `confirmed`. Do not add a schema field, provider option or API through which a model could confirm.
3. **Every evidence claim cites IDs that exist.** New agent output fields that carry claims must go through `grounding.ts`.
4. **Support scores are not probabilities.** Do not display them, or let a model restate them, as likelihoods.
5. **Keys stay on the server.** Never give a credential a `VITE_` prefix, never send one to the browser, never commit `.env.local`.
6. **The test double is always labelled.** Anything produced by `ScriptedProvider` must be marked `testDouble: true` and shown as such.
7. **Correlation rules are physical, not per-seed.** If a new rule is needed, write down the physical reason in ARCHITECTURE.md §8 and add a test for the case that motivated it.
8. **Results are measured, not asserted.** Do not put a number in documentation that a script in this repository did not produce.
9. **Cyber-physical links are declared, never inferred.** A cyber event may relate to physical equipment only through `controls` / `monitors` relations and parameter declarations in the OT model. Time or proximity alone must never link them.
10. **No conclusion claims intent.** The strongest cyber conclusion is "control-system change supported; intent not established". The grounding validator rejects unhedged attribution to an attack or attacker; keep it that way.
11. **No equipment control.** The only controller-write path is inside `src/simulation`. `src/cyber/cyber.test.ts` fails if any other code references it.
12. **ATT&CK mappings are verified reference data.** Add a technique to `src/cyber/attack.ts` only after checking its ID, name and tactic on attack.mitre.org, and record the content version.

## Where things go

| Change | Where |
| --- | --- |
| New signal, asset or relation | `src/simulation/facility.ts` |
| New fault scenario | `src/simulation/SimulationEngine.ts`, plus a scenario test and an entry in `src/eval/groundTruth.ts` |
| New hypothesis template | `src/intelligence/hypotheses.ts` |
| New data source | implement `DataSourceAdapter` (`src/adapters`) |
| Agent prompt or input slice | `src/agents/agents.ts` |
| Agent output shape | `src/agents/schemas.ts`, then `grounding.ts`, `scriptedProvider.ts` and `AiPanel.tsx` |
| Another LLM provider | implement `LlmProvider` (`src/agents/provider.ts`) and select it in `configureAi` (`server/atlasAi.ts`) |

## Tests

- Pipeline tests drive the headless `AtlasCore` through `boot()` in `src/runtime/testHarness.ts`. Set `ATLAS_TRACE=1` and pass `--silent=false` to print a scenario's timeline and reasoning.
- Agent tests use `ScriptedProvider`. Its script can return values, functions, errors or delayed answers, to test timeouts, repairs and failures.
- Provider tests run the real `AnthropicProvider` against a local HTTP server in the test file. No test calls the real API.
