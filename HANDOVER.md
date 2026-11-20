# Vanterra — status and roadmap

Updated 2026-11-20. The product (formerly ATLAS) is described in [README.md](README.md), its design in [ARCHITECTURE.md](ARCHITECTURE.md), and its measurements in [EVALUATION.md](EVALUATION.md).

## 1. Status

| Capability | Implemented | Tested | Live-validated |
| --- | --- | --- | --- |
| Physical pipeline: detection, correlation, hypotheses, impact, checks | yes | unit and scenario tests; 10-seed evaluation | n/a (deterministic) |
| OT model, security telemetry, five cyber rules, cases, ATT&CK context | yes | 15 cyber tests; 10-seed evaluation (0 false positives in 5 h) | n/a |
| Cyber-physical assessment (7 conclusions, unknowns, next steps) | yes | 60/60 evaluation runs correct; independent blind-authored evaluation 90/90 (80/90 before the IND-05 fix) | n/a |
| Overview, Spatial with OT layer, workbench, Cyber & OT, demo launcher | yes | browser at 1440 × 900, 820 px, 768 px and 700 px; 13 scripted captures; 82 s screen-capture demo | n/a |
| Agent layer with cyber context and causal-overreach gate | yes | test double; adversarial gate (0/99) | **no** |
| Claude provider and AI service | yes | local API stub; browser failure path | **no** |
| Ollama provider (local, free) | yes | local stub of the Ollama API, including a full five-agent run | **no** (no model downloaded) |

Verified on 2026-11-20: type-check and lint clean; 128 tests pass in 9 files; the build succeeds; `npm run eval` runs all four suites.

**Repository:** public on GitHub, [mehdi24568/Vanterra](https://github.com/mehdi24568/Vanterra), branch `main`. See docs/PUBLISHING.md.

## 2. Open items that need the owner

1. **Live LLM validation.** The free route is local: approve `ollama pull qwen3:4b` (about 2.5 GB), then run `npm run eval:live` with `ATLAS_LLM_PROVIDER=ollama` (docs/LOCAL_AI.md) and update EVALUATION.md §4–5. The Claude route needs an API key, which the owner does not plan to buy. The product is complete without either.
2. **Licence:** none is included, so the public code is all rights reserved. Add MIT or Apache-2.0 to allow reuse (docs/PUBLISHING.md).

## 3. Roadmap

1. Measure local inference: run the five-agent review on `qwen3:4b` and record schema pass rate, grounding failures and latency on this hardware (CPU only).
2. More cyber scenarios: communication loss (loss of view), program download, and a session through an unexpected path. Each needs a rule test and an evaluation case.
3. A second independent evaluation round, with scenarios written by a domain expert rather than an AI author, and without access to the scenario-language interface.
4. Persistence of incidents, cases and verdicts; asset-model and OT-inventory import; a real data-source adapter behind the existing interfaces.
5. Code splitting for the 1.2 MB bundle.

## 4. Decisions

- The deterministic engine is the source of truth. AI and the cyber-physical assessment are read-only with respect to incidents, and only an operator confirms.
- Cyber-physical links come from declared relationships only, never from time or proximity alone. The strongest cyber conclusion is "control-system change supported; intent not established".
- ATT&CK mappings are verified reference data, shown as context with a caveat.
- No paid services, no real networks, no equipment control. The single cyber-to-physical write path stays inside the simulator, and a test enforces it.
- The name is Vanterra (docs/BRAND.md). Code identifiers keep the original `Atlas` prefix to avoid churn.

## 5. Environment notes

- No system Node.js or git on the development machine; a portable Node.js lives in `.tools/node`, and `start-atlas.cmd` uses it.
- Windows PowerShell 5.1 corrupts UTF-8 when files are round-tripped through `Get-Content`/`Set-Content`. Edit files with an editor or with explicit UTF-8 I/O.
- `npm run capture` drives the installed Edge or Chrome through `playwright-core`; it downloads nothing.
