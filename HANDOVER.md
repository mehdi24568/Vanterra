# Vanterra — status and roadmap

Updated 2026-11-20. The product (formerly ATLAS) is described in [README.md](README.md), its design in [ARCHITECTURE.md](ARCHITECTURE.md), and its measurements in [EVALUATION.md](EVALUATION.md).

## 1. Status

| Capability | Implemented | Tested | Live-validated |
| --- | --- | --- | --- |
| Physical pipeline: detection, correlation, hypotheses, impact, checks | yes | unit and scenario tests; 10-seed evaluation | n/a (deterministic) |
| OT model, security telemetry, five cyber rules, cases, ATT&CK context | yes | 15 cyber tests; 10-seed evaluation (0 false positives in 5 h) | n/a |
| Cyber-physical assessment (7 conclusions, unknowns, next steps) | yes | 60/60 evaluation runs correct; independent blind-authored evaluation 90/90 (80/90 before the IND-05 fix) | n/a |
| Overview, Spatial with OT layer, workbench, Cyber & OT, demo launcher | yes | browser at 1440 × 900, 820 px, 768 px and 700 px; 13 scripted captures; 82 s screen-capture demo | n/a |
| Agent layer with cyber context and causal-overreach gate | yes | test double; adversarial gate (0/99) | **small local sample** (`qwen3:4b`, EVALUATION.md §4) |
| Claude provider and AI service | yes | local API stub; browser failure path; cross-site request refusal | **no** (no API key) |
| Ollama provider (local, free) | yes | local stub of the Ollama API: queueing, slow answers, cut-off connections, cancellation, deadline, output cap, full five-agent run | **yes, on a CPU-only laptop** (full review 20 min, Quick AI review 1.5–2 min) |
| Plain-language briefing ("In plain words", Cyber-physical tab) | yes | 6 tests: verdicts per case, evidence exists, no jargon or overreach, read-only; checked in the browser | n/a (deterministic); **not yet tested with users** |
| Ask Vanterra (Ask tab): instant engine answers + checked model answers; "Run AI agents" button | yes | 8 tests (grounding, overreach with negation, repair, rejected drafts, failures); WCAG contrast test | **yes**: accepted, cited answer in 57 s on `qwen3:1.7b`, CPU |
| Windows desktop app (Electron, `app://`, no local server; Ollama auto-start; NSIS installer) | yes, 0.5.0 | bridge and runtime tests (6); packaged-app smoke test; no listening ports verified | **yes**: AI available in the packaged app with zero configuration |

Verified on 2026-11-21: type-check and lint clean; 177 tests pass in 15 files; the build succeeds; `npm run eval` runs all four suites.

**Repository:** public on GitHub, [mehdi24568/Vanterra](https://github.com/mehdi24568/Vanterra), branch `main`. See docs/PUBLISHING.md.

## 2. Open items that need the owner

1. **Licence:** none is included, so the public code is all rights reserved. Add MIT or Apache-2.0 to allow reuse (docs/PUBLISHING.md).
2. **Code signing** (paid) before distributing a Windows installer widely (docs/DESKTOP_ARCHITECTURE.md §12).

## 3. Roadmap

1. Validate the plain-language briefing with 3–5 non-specialists, then prototype investigation drills (docs/PRODUCT_DISCOVERY.md §8).
1. Desktop application, remaining work: in-app model download, persistence (phase 3), code signing and auto-update (docs/DESKTOP_ARCHITECTURE.md).
2. Broader live AI measurement on a machine with enough free memory to keep the model resident (all four live cases, several runs each), so answer quality can be compared with the deterministic engine rather than only observed.
3. More cyber scenarios: communication loss (loss of view), program download, and a session through an unexpected path. Each needs a rule test and an evaluation case.
4. A second independent evaluation round, with scenarios written by a domain expert rather than an AI author, and without access to the scenario-language interface.
5. Asset-model and OT-inventory import; a real data-source adapter behind the existing interfaces.
6. Code splitting for the 1.2 MB bundle.
7. Dev tooling: `npm audit` reports 9 moderate advisories in the ESLint toolchain (via `minimatch`); none in runtime dependencies. Update ESLint when a fixed release is available.

## 4. Decisions

- The deterministic engine is the source of truth. AI and the cyber-physical assessment are read-only with respect to incidents, and only an operator confirms.
- Cyber-physical links come from declared relationships only, never from time or proximity alone. The strongest cyber conclusion is "control-system change supported; intent not established".
- ATT&CK mappings are verified reference data, shown as context with a caveat.
- No paid services, no real networks, no equipment control. The single cyber-to-physical write path stays inside the simulator, and a test enforces it.
- The name is Vanterra (docs/BRAND.md). Code identifiers keep the original `Atlas` prefix to avoid churn.

## 5. Environment notes

- No system Node.js or git on the development machine; a portable Node.js lives in `.tools/node`, and `start-vanterra.cmd` uses it.
- Windows PowerShell 5.1 corrupts UTF-8 when files are round-tripped through `Get-Content`/`Set-Content`. Edit files with an editor or with explicit UTF-8 I/O.
- `npm run capture` drives the installed Edge or Chrome through `playwright-core`; it downloads nothing.
