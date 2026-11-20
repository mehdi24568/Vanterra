# Development progress log

Concise record of what was built in each phase, what was verified, and what was changed as a result of testing.

## Phase 1: Inspection and architecture

- The repository was empty, so the stack from the brief was used: React, TypeScript (strict), Vite, Three.js. Vitest and ESLint added for validation. No other runtime dependencies.
- The machine had no Node.js. A portable Node.js LTS was unpacked into `.tools/` after checksum verification, with `start-atlas.cmd` as a launcher.
- Domain model written first (`src/core/types.ts`) as the contract between engines.
- One deliberate change to the proposed architecture: a headless `AtlasCore` separate from the browser runtime, so the whole intelligence pipeline can be tested without a browser.

## Phase 2 to 5: Engines, built and tested headless before any UI

- Facility definition: 32 assets, 84 signals, 49 relations.
- Causal process model with three fault scenarios and four normal operations.
- Telemetry normalisation and ring-buffer history.
- Anomaly detection: six detectors with lifecycle and re-baselining.
- Asset graph, correlation and the rule-based reasoner with eleven templates.

**First end-to-end run: 11 of 14 scenario tests passed.** The failures and what they led to:

| Finding | Change |
| --- | --- |
| Bearing temperature was flagged a second before vibration, the wrong order physically | Friction heating made proportional to wear squared, so temperature trails vibration |
| A slow ambient drift put the chiller load within reach of the 4σ threshold during normal operation | Drift amplitude reduced; noted as a general limit of 40 s baselines |
| Two independent faults merged into one incident because the transformer's load changed in both | Three correlation rules added: unimplicated supplies do not link consumers; load-only anomalies do not implicate; incidents merge only along a chain |
| Cavitation scored 35 % because suction pressure had moved *above* baseline and so was not "normal" | Criterion changed from "within baseline" to "not low" |

**Second round, from reading the traces:**

| Finding | Change |
| --- | --- |
| After a duty changeover, the reactor refilling at high flow looked like heat-exchanger fouling at 100 % | Hypotheses are frozen at the moment of a commanded intervention; fouling template gained two contradicting criteria |
| A hot switchboard joint scored 50 % in the fan-trip scenario, where the heat was simply extra chiller load | "Bus voltage is normal" added as contradicting evidence |
| A rate-of-change anomaly fired just after a hold-off ended, on data from the commanded ramp | Samples from a hold-off are excluded from later slope windows |

## Phase 6: Sonar and 3D

- Sonar engine written and unit-tested as pure logic (contacts, radius, decay, echo sensitivity, pause).
- Procedural geometry for sixteen equipment types; custom shaders driven by the sonar's own pulse state.
- Rendered correctly on first launch with no console errors.

## Phase 7: Interface and browser testing

Tested in a real browser at 1480 × 900 and 375 × 812:

| Check | Result |
| --- | --- |
| Launch | No console errors; 60 fps; 0.5 ms per batch |
| Hover and click an asset in the scene | Label expands, inspector opens with live values |
| Sonar ping, continuous, pause, intensity, radius, interval, ground double-click | All verified against engine state |
| Category filters, hide and show all, relationship layer | Verified |
| Simulation pause, speeds up to ×8 (31.8 ticks/s measured), reset with a new seed | Verified |
| Pump scenario through the UI | Incident opened, 91 % rising to 100 % support, full cascade to a starved filler |
| Investigation drill-down: evidence row, trend chart, confirm and undo, checklist, asset navigation, inspector and back | All verified |
| Two faults together | Two incidents, origins CT-401 and MCC-520 |
| Changeover after the pump fault | Assessment frozen, plant recovered, incident resolved as "cause not confirmed" |
| Narrow layout | Drawers open full width, no horizontal overflow |

Changes made from browser testing:

- The scene was centring on the full canvas, leaving the subject behind panels. The camera's principal point is now shifted to the centre of the uncovered area, and the overview distance is fitted to it.
- Echo rings and event pulses stacked into an over-bright patch. Edge brightness is now capped, event pulses are drawn quieter, and bloom was reduced.
- Signal names were truncated in the inspector. Rows now use two lines.
- Labels that had never been shown were sitting at the top-left corner. They now start hidden.
- With two faults active, a burst of detection pings filled the pulse slots and a facility sweep was retired after three contacts, leaving half the site unscanned. Event pings can now only displace other event pings; a unit test covers it.

## Stress test: three faults at once

Injecting all three faults together was not in the brief, but it is the obvious way to find out whether correlation is doing real work. The first attempt produced one incident with the transformer named as origin. Reading the trace gave four causes, each now covered by a test:

| Finding | Change |
| --- | --- |
| The transformer and a switchboard were offered as origin because they showed load changes early | Load-only assets are not origin candidates while anything else is abnormal in its own right |
| A warm busbar counted as the board being "abnormal", which let it bridge its consumers | On electrical distribution equipment, temperature is treated as a consequence of load |
| A motor's rising current was linked to a board whose current had fallen | Reflected load must move in the same direction |
| The pump was linked to the cooling fault because both feed the same heat exchanger | Paths may not pass through a shared consumer; incidents merge only if one origin could have propagated to the other |

Result: three incidents, origins CT-401, MCC-520 and P-101, each leading with the correct hypothesis. Some downstream assets that both faults affect are attributed to one incident rather than the other, which is an honest ambiguity rather than an error.

The same session exposed two reporting faults, found because the preview pane was hidden and throttling frames: the frame-rate figure was computed from a clamped interval and over-reported, and the sonar slowed with the frame rate. The readout now uses the true interval and the sonar runs on real elapsed time.

## Final validation

- `tsc --noEmit`: clean, strict mode.
- `eslint .`: clean.
- `vitest run`: 45 tests passing in 5 files.
- `vite build`: succeeds; one 1 MB bundle (275 kB gzipped), most of it Three.js.

## Not done

- No LLM provider (interface and safety boundary only).
- No persistence, asset-model import, or real data adapter.
- The last browser pass at phone width was verified through DOM measurements rather than a screenshot, because the preview pane was hidden at that point.
- Not tested on Firefox or Safari, or on integrated graphics.

## Phase 7: Agentic AI layer, evaluation and portfolio delivery

Built:

- **Agent layer** (`src/agents`): a strict, bounded investigation context built from engine state; strict output schemas with no numeric confidence and no disposition field; a grounding validator; five agents with different input slices; a code-controlled orchestrator (parallel first stage, repair once, per-call timeout, run deadline, cancellation, deterministic cross-check, audit trail); report acceptance in the browser.
- **AI service** (`server`): a Vite plugin that keeps the API key in the Node process and streams progress as NDJSON; a Claude provider on the official SDK with structured output and typed error mapping; configuration from environment variables only.
- **Interface:** an AI review tab with live per-agent progress, findings with evidence chips, disagreements, governance and audit export; a three-way assessment (rule-based, AI-assisted, human); a guided demo; a status strip that separates the plant (condition, incidents) from the platform (pipeline health, AI service); tabbed investigation; drawers below 1100 px.
- **Evaluation harness** (`src/eval`): counterfactual twin runs for ground truth; 10-seed deterministic evaluation; an adversarial governance check; a live-model evaluation that refuses to run without a real provider.
- **Screenshots** captured from the running app with playwright-core and the installed Edge.

Found by testing and changed:

| Finding | Change |
| --- | --- |
| A network failure made every agent fail in turn (5 calls) | `network` added to the errors that stop a run at once; now 2 calls in about 1.2 s |
| Evaluation: pump fault and fan trip merged in 3 of 10 seeds (pump vibration linked to cooling water through the heat exchanger) | Vibration links only through mechanical relations |
| Evaluation: pump discharge pressure linked to the fan trip, giving a wrong origin in 1 seed | Pressure, flow and level paths may not leave their fluid circuit |
| Browser: a fan trip injected 30–90 s after the pump fault joined the pump incident | A trip links only through electrical or mechanical relations |
| Browser and evaluation: an MCC sag injected 90–180 s later joined through a motor already abnormal for reactor reasons | A supply's own fault must not follow the consumer abnormality by more than 5 s, checked along the whole path; sequential-fault runs added to the harness |
| The orchestrator's input listed its own unfinished status | Removed from its input |
| A basis tag stretched full width at 700 px; the scrollable status strip gave no cue | Tag aligned; fade at the strip's edge |

Verified: type-check, lint, 100 tests, production build; offline evaluation; browser checks at 1440×900 and 700×900 for the guided demo, all fault scenarios, acknowledge, repair, resolve, reset, AI unavailable, API failure and the scripted test double.

**Not verified:** any call to the live Claude API. No key was available. `npm run eval:live` is the verification step.

## Phase 8: Vanterra, cyber-physical intelligence

Built:

- **Name and identity:** VANTERRA was chosen after checking four candidates for existing companies and products (docs/BRAND.md). The design moved to graphite surfaces, a restrained steel accent and semantic colour (physical severity warm, cyber azure, AI violet, confirmed green), with less 3D glow.
- **Cyber layer:** a Purdue-style OT model as data (5 zones, 14 devices, conduits, role identities, writable parameters with expected physical signatures, change records); simulated security telemetry on its own random stream; a Cyber Engine with five rules and case grouping; ATT&CK for ICS context, with seven techniques verified on attack.mitre.org.
- **One cyber-to-physical path:** the cooling-tower fan speed setpoint, wired into the process model so that 100 % reproduces the original equations exactly.
- **Cyber-physical assessment:** declared-relationship linking, precedence and signature tests, a fault discriminator, seven explicit conclusions, unknowns and next steps.
- **Interface:** Overview, Cyber & OT, a workbench Cyber-physical tab, an OT layer in 3D, a scenario launcher, timeline and scenario groups for cyber, and keys 1–3 for navigation.
- **AI:** cyber evidence and the assessment in the agents' context; CEV and OT device IDs citable; a new `causal_overreach` gate.
- **Evaluation:** a cyber-physical suite over 10 seeds, with 6 assessment cases including deliberately misleading ones, cyber false positives and scenario-B detection.

Found by testing and changed:

| Finding | Change |
| --- | --- |
| Scripted edits through Windows PowerShell 5.1 garbled non-ASCII text in 8 files | Repaired by re-decoding only the garbled sequences; edits since use UTF-8-safe tools |
| The equipment explanation read as rejecting the airflow-loss mechanism itself | Reworded: both explanations share the physical mechanism and differ in what started it |
| The OT layer was too subtle, and PLC-500 sat behind the workbench | Larger cabinets and labels; PLC-500 moved within its area; the layer turns on when an incident opens on its Cyber-physical tab |
| Zone-map boxes touched at 700 px | Box width follows the available spacing |

Verified: 118 tests, type-check, lint, build; `npm run eval` (physical results unchanged; cyber-physical 60/60; 0 cyber false positives in 5 h; governance 0/99); browser at 1440, 820 and 700 px, including the flagship journey from Overview to Cyber & OT to the workbench.

**Not verified:** any live LLM call.