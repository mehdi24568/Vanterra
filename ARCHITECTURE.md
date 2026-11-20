# Vanterra architecture

This document describes how the prototype is built, why the main decisions were made, and where it is designed to be extended. The product was called ATLAS while sections 1–17 were written. Code identifiers (`AtlasCore`, `AtlasRuntime`) keep that name; sections 18–21 cover the cyber-physical evolution.

## 1. Shape of the system

```
                    ┌───────────────────────── AtlasCore (headless) ─────────────────────────┐
 DataSourceAdapter  │                                                                         │
 ┌──────────────┐   │  Telemetry       Anomaly          Intelligence                          │
 │ Simulation   │──▶│  Engine    ──▶   Detection  ──▶   Engine          ──▶  timeline         │
 │ Replay       │   │  normalise       6 detectors      correlate, rank,     incidents        │
 │ (OPC UA,     │   │  + history       + re-baseline    explain, project     health map       │
 │  MQTT, REST) │   │                                        │                                │
 └──────────────┘   │                  Asset Graph ◀─────────┘ ReasoningProvider              │
                    └────────────────────────────┬────────────────────────────────────────────┘
                                                 │ pulled, never pushed into React
                    ┌────────────────────────────▼───────────────┐
                    │ AtlasRuntime (browser)                     │
                    │  sim clock · Sonar Engine · view state     │
                    └───────┬──────────────────────┬─────────────┘
                 SceneFeed  │                      │  UI store (4 Hz snapshots)
                    ┌───────▼────────┐      ┌──────▼──────────────┐       ┌──────────────────────────┐
                    │ Spatial Engine │      │ React interface     │ POST  │ AI service (Node, server │
                    │ Three.js, rAF  │      │ panels, charts,     │──────▶│ side of Vite dev/preview)│
                    └────────────────┘      │ AiService client    │◀──────│ key · 5-agent workflow · │
                                            └─────────────────────┘ NDJSON│ schema + grounding gates │
                                                                          └────────────┬─────────────┘
                                                                                       │ HTTPS
                                                                               Claude Messages API
```

The pipeline in one line: **data source → telemetry → anomaly detection → asset graph and correlation → deterministic intelligence → agentic investigation → evidence-backed report → human verification.** Everything up to and including deterministic intelligence runs in the browser with no network. The agentic step is optional, runs server-side, and can only add an advisory report beside an incident.

Three properties follow from this shape and are the ones worth preserving:

1. **The core has no clock, DOM or renderer.** `AtlasCore` advances only when a batch is ingested, and its notion of "now" is the event time of the data. The same object runs in the browser, in the test suite, and could run in a server process unchanged.
2. **The source is behind one interface.** The engines receive `RawReading`s and `SourceEvent`s through an `IngestSink` and an asset model through `describe()`. They never import the simulator.
3. **The render loop never goes through React.** The Spatial Engine pulls from a `SceneFeed` every frame and writes uniforms and transforms directly. React receives compact snapshots four times a second and re-renders only the slices that changed.

## 2. Modules

| Module (brief) | Location | Responsibility |
| --- | --- | --- |
| Data Adapter Layer | `src/adapters` | `DataSourceAdapter` contract; `SimulationAdapter`; `ReplayAdapter` |
| Simulation Engine | `src/simulation` | Facility definition; causal process model; scenarios |
| Telemetry Engine | `src/telemetry` | Tag resolution, unit conversion, quality, ring-buffer history |
| Anomaly Detection Engine | `src/anomaly` | Six detectors, anomaly lifecycle, baseline re-learning |
| Asset Graph Engine | `src/graph` | Typed dependency graph, path search, propagation |
| Intelligence Engine | `src/intelligence` | Correlation, incidents, origin ranking, impact, recommendations; reasoning provider and hypothesis templates |
| Sonar Engine | `src/sonar` | Pulses, contacts, reveal energy, sweep reports |
| Spatial Engine | `src/spatial` | Scene, procedural geometry, shaders, camera, picking, labels |
| Visualisation Layer | `src/ui` | React panels, canvas charts, investigation view |
| Composition | `src/runtime` | `AtlasCore` (headless pipeline), `AtlasRuntime` (browser), UI store, `AiService` (browser client of the AI service) |
| Agent layer | `src/agents` | Investigation context, output schemas, grounding validator, five agents, bounded orchestrator, report acceptance; scripted test double in `testing/` |
| AI service | `server` | Vite plugin exposing `/api/ai/status` and `/api/ai/investigate`; Claude provider on the official SDK; configuration from environment |
| Evaluation | `src/eval` | Ground truth by counterfactual twin runs, deterministic metrics, offline governance checks, live-model evaluation |

`src/core/types.ts` is the contract between all of them. It imports nothing.

## 3. Domain model

- **Asset**: tag, category, area, position, drawing spec, metadata, signals. A drawing spec is declarative data (`{ kind: 'tank', radius, height }`); only the Spatial Engine interprets it.
- **Signal**: fully-qualified tag, measurement type, unit, engineering range, optional alarm limits, rate limit, setpoint reference, and which detectors apply.
- **Observation**: timestamp, asset, signal, type, value, unit, quality, source. The only form the intelligence layer sees.
- **Relation**: directed dependency `from → to` with a type (process, mechanical, electrical, cooling, utility) and a medium ("process fluid", "400 V supply").
- **Anomaly**: which detector fired, on what, since when, with the exact rule text and the numbers that satisfied it.
- **Incident**: anomalies, affected assets, correlation links, origin candidates, hypotheses, impact, recommendations, and a revision counter.

## 4. Simulation

`SimulationEngine` is a small causal model stepped at 4 Hz: feed pumps and their motors, a level-controlled reactor, a tower and chiller cooling loop around a heat exchanger, a packaging line, and a 400 V distribution system. State variables with first-order lags carry the dynamics.

Faults change physical parameters, not signals:

| Scenario | Parameter changed | What emerges |
| --- | --- | --- |
| Bearing degradation | `wearP101` ramps 0 → 0.85 | Vibration, then friction heat (∝ wear²), lost head and capacity, pressure ripple, higher motor current, reactor level falling, filler starved |
| Fan trip | `fanTripped` | Airflow collapses, basin heats, chiller loads then saturates, supply temperature rises, process outlet and reactor temperatures follow |
| Voltage depression | `sag520` ramps 0 → 12 % | Bus voltage falls, joint heats, every constant-power load on that board draws more current |

Everything downstream of the parameter comes out of the model equations. That matters for honesty: the intelligence layer is reasoning about consequences it was not told about. Simulation-control events appear on the timeline for the person running the demonstration but are never passed to detection or reasoning.

Runs are reproducible: a seeded PRNG drives all noise, and the test suite asserts that equal seeds give identical telemetry.

## 5. Telemetry

`TelemetryEngine.normalise` resolves the tag, converts source units to the signal's canonical unit, rejects unknown tags and non-finite or wildly out-of-range values, and marks readings in an unrecognised unit as `uncertain` rather than trusting them. Two simulated tags deliberately arrive in psi and °F to exercise this.

History is a fixed ring buffer per signal (2400 samples, ten minutes at 4 Hz) in typed arrays. Detection, reasoning and charts all read the same buffers.

## 6. Anomaly detection

Each observation updates one per-signal state and runs through:

| Detector | Condition | Persistence |
| --- | --- | --- |
| Absolute limit | 1 s mean beyond a warning or alarm limit | 1.5 s |
| Baseline deviation | 2 s mean more than 4σ from the learned baseline | 3 s |
| Rate of change | least-squares slope over 10 s beyond the signal's rate limit | 4 s |
| Variability | detrended scatter over 10 s more than 3× baseline σ | 4 s |
| Setpoint deviation | measurement more than 6 % from its controller demand | 5 s |
| Composite ratio | ratio of two signals more than 10 % above its learned value | 5 s |

Design points:

- **Baselines are learned, not configured.** Mean and σ come from the first 40 s of data, with a floor on σ (0.5 % of range) so a quiet signal does not become hypersensitive. Afterwards the mean adapts slowly, and only while the signal is behaving normally, so a fault is not absorbed into its own baseline.
- **Commanded changes re-learn rather than alarm.** A setpoint move or duty changeover arrives as a `SourceEvent` with a `rebaseline` scope. Deviation, rate and variability detection hold off for the stated time, then re-learn. Absolute limits stay live throughout. Samples taken during the hold-off are excluded from later slope calculations.
- **Every anomaly explains itself.** The `rule` field holds the sentence that was true, with numbers: `2 s mean 9.67 mm/s is 74.2σ above baseline 2.20 mm/s (σ 0.10); threshold 4σ for 3 s`.
- **Hysteresis and lifecycle.** Opening and holding use different thresholds; an anomaly clears after 6 s without the condition; severity only escalates while active.

Configuration lives in `DEFAULT_DETECTION` and in each signal's definition.

## 7. Asset graph

A typed in-memory adjacency structure. A graph database would add nothing at this scale; the public surface (`findPath`, `propagate`, `influenceReach`, neighbours) is small enough to re-implement over one later.

`findPath` is a breadth-first search over (asset, direction-of-last-step) states. The direction matters because of one rule that turned out to be central.

## 8. Correlation

An anomaly joins an incident if its asset is within three dependency steps of an asset already in it. Five refinements keep that from collapsing into "everything is connected to everything". Each one was added because a test with simultaneous independent faults showed the simpler rule merging them.

1. **Shared supplies do not link their consumers unless the supply is itself abnormal.** A path may not turn from "up to a supplier" to "down to another consumer" through an unimplicated asset. Two motors on the same switchboard are not related evidence. If the board's voltage is low, they are.
2. **Shared consumers do not link their suppliers.** The mirror case: the feed line and the cooling-water line both end at the heat exchanger, but a problem on one is not evidence about the other. If the exchanger itself is abnormal it is a member, and each supplier links to it directly.
3. **Load is not the same as fault.** An asset whose only anomalies say how much is being drawn through it is not "implicated": current and power always, and temperature too on electrical distribution equipment, since a busbar runs warmer simply because it carries more. A transformer carrying less load because a fan tripped tells you nothing about the voltage on its other feeder.
4. **Reflected load must move the same way.** A motor drawing more current is linked to its switchboard only if the board's current has risen too.
5. **Incidents merge only along a chain, and only if one origin could have reached the other.** A new anomaly related to two incidents merges them only when its asset sits between them (upstream of one, downstream of the other) *and* a disturbance at one incident's origin could plausibly have propagated to the other's. The second condition exists because a loop in the plant (cooling water returning to its tower) puts almost any two assets in a chain.

Four further rules restrict *which relations* a path may use, by what the anomaly measures. They were added after the evaluation harness (section 17) and a browser test found independent faults being merged:

6. **Vibration travels only through a shaft.** A vibration anomaly may link only along mechanical relations. Without this, pump vibration was "explained" by a cooling-water upset three process steps away (3 of 10 seeds, pump fault plus fan trip).
7. **Pressure, flow and level stay in their own fluid circuit.** A heat exchanger passes heat between the process and the cooling water, not hydraulics, so a hydraulic anomaly's path may not switch between process, cooling and utility relations. The search state includes the circuit for this.
8. **A trip is explained by its supply or a coupled machine.** A status (trip) anomaly may link only along electrical and mechanical relations: a fan does not trip because warm water reaches its tower.
9. **A supply's own fault must come first.** A path that leaves an electrical supply downstream treats the supply's voltage as a possible cause of what lies beyond it. If the asset at the end of the path was abnormal more than 5 s before the supply anomaly, the link is refused: a bus that sags long after a motor's load changed did not cause that change. The 5 s allowance comes from supply voltage being detected about 3 s after a fault in every evaluation run. This rule assumes a consumer fault does not itself depress the bus voltage, which holds in this simulated plant.

A consequence worth knowing: an asset belongs to one incident at a time, and its later anomalies join that incident. If a fault elsewhere later affects an asset already in an incident, those anomalies are attributed to the earlier incident (seen when the fan trips after the pump fault has already changed the chiller's load).

The same notion of "implicated" is used for origin ranking: an asset that only shows a load change is not offered as an origin candidate while anything else in the incident shows an abnormality of its own.

Each link records the path and a rationale at the moment of linking, so the investigation can show *why* two things were considered related, not just that they were.

A lone advisory is recorded but does not open an incident. An incident opens on a warning-level anomaly, or on two related anomalies of any severity.

## 9. Reasoning

The Intelligence Engine owns correlation, lifecycle, origin ranking and impact. Explaining an incident is delegated to a `ReasoningProvider`.

**Origin candidates** are ranked by `0.5 × earliness + 0.5 × coverage`, where coverage is the share of the other affected assets that lie on influence paths from the candidate. It is presented as where to look first, not as a finding.

**Hypotheses** come from templates in `hypotheses.ts`. A template is a failure mechanism plus weighted criteria: things that should be visible if the mechanism were at work, and things that should not. Criteria are written relative to a focal asset through the graph ("the motor that drives it", "the line it discharges into"), so a template applies to any asset of the right kind.

```
support = clamp( (Σ observed supporting weights − Σ observed contradicting weights) / Σ all supporting weights , 0, 1 )
```

A template is listed only if one of its entry conditions is observed. The effect is that the investigation shows the leading explanation and the plausible alternatives it considered and why they score lower: in the pump scenario, cavitation is listed at about 5 % because suction pressure is not low.

Two rules protect the assessment from being misled:

- **After an intervention, the assessment is frozen.** Once a commanded change touches an incident's assets, later readings show the plant's response, not more evidence about the cause.
- **A cleared incident keeps the assessment made while its evidence was live.**

**Impact** follows dependencies forward from the origin with attenuation per step and when the carrying medium changes. Crossing from process into the cooling loop is attenuated hard; a cooling problem crossing into the process it serves is not.

**The epistemic line** is enforced in code. Engines produce observations, detections, correlations and hypotheses. `disposition: 'confirmed'` can be set only through `setDisposition`, an operator action. `applyExternalAssessment`, the entry point for asynchronous providers, discards results for a stale revision and overwrites any disposition a provider supplies. Both behaviours are tested.

### Where the LLM fits

The language-model layer (section 15) does **not** replace the `ReasoningProvider`. It reviews the deterministic result and produces a separate, advisory report. `applyExternalAssessment` remains available for a provider that wants to replace hypothesis scoring, and keeps its revision guard and its refusal to accept a confirmation, but the shipped agent layer does not use it: AI output is never written into the incident.

## 10. Sonar

`SonarEngine` owns pulses (origin, radius, speed, intensity). Each update advances the wavefronts and tests them against asset positions. A crossing is a *contact*: the asset gains reveal energy, which then decays; its health is sampled; an abnormal asset returns an echo.

Everything visual is driven from that state. The shaders receive the same pulse list as uniforms and evaluate the wavefront per fragment, so the picture and the contact logic cannot disagree. Intensity sets deposited energy, how long assets stay revealed, and whether advisory-level conditions echo at all. A new detection triggers a local pulse from that asset, which is why an affected machine lights up immediately.

## 11. Spatial engine and performance

- **Geometry** is procedural, built from primitives and merged to one mesh per asset. Dimensions are chosen so nozzles, shafts and pipe routes line up.
- **Draw calls:** two per asset (surface, edges), one instanced mesh for every signal marker, one buffer for every relationship arc, one for the ground, plus a couple of dozen static ground labels. About a hundred in total; adding signals does not add draw calls.
- **Shading** is custom and unlit: dark solid surfaces, edge lines, height contours and a Fresnel rim, all scaled by reveal energy and tinted by health. Bloom is the only post-process.
- **Labels** are DOM elements positioned by direct transform writes. Which labels to show is decided ten times a second by relevance and greedy de-cluttering.
- **Picking** is ray casting against asset meshes and the instanced markers.
- **Panels and framing:** the camera's principal point is shifted so that its target sits in the centre of the area not covered by panels.

Measured on the development machine: 60 fps at 1480 × 900, and about 0.5 ms to process one batch of 84 observations, including detection and reasoning.

## 12. Replacing the simulator

1. Implement `DataSourceAdapter`: `describe()` returns the asset model; `connect(sink)` starts delivering `sink.ingest(readings, id)`.
2. Map source identifiers to signal tags, and supply units where they differ from canonical ones.
3. Publish commanded changes as `SourceEvent`s with a `rebaseline` scope where the source system knows about them (setpoint changes, sequence steps).
4. Construct `new AtlasCore(adapter)`.

A push source (OPC UA subscription, MQTT) does not implement `ClockedAdapter`; it calls the sink on its own schedule and the core follows event time. `ReplayAdapter` shows the shape for historical data, and `scenarios.test.ts` proves the point: a recorded run replayed through it produces the same incident, hypothesis and score as the live simulator.

What a real deployment still needs that this prototype does not have: authentication and transport for the source, persistence for history and incidents, an asset-model import, and handling for late and out-of-order data.

## 13. Testing

`npm test` runs 126 tests in 9 files:

- **Unit:** telemetry normalisation, each detector, graph search and its rules, sonar mechanics.
- **End to end, headless:** each scenario is run through the whole pipeline and asserted on what the engines concluded: first anomaly, incident membership, origin, leading hypothesis and its score band, rejected alternatives and the contradiction that rejected them.
- **Negative cases:** fifteen minutes of nominal operation, a planned rate change in both directions, and a routine changeover must produce no anomalies at all.
- **Separation:** two and three simultaneous faults, three faults injected 30, 60 and 90 s apart, and the seeds that once merged a pump fault with a fan trip.
- **Operator workflow:** acknowledge, recover after a simulated repair, resolve; rule out and restore a hypothesis; reset and re-run gives a bit-identical result.
- **Boundary:** an external provider cannot confirm; a stale assessment is rejected.
- **Agent layer** (`src/agents/workflow.test.ts`, scripted test double): context bounds, grounding validator, orchestration order and concurrency, timeouts, deadline, cancellation, authentication, network and configuration failure with deterministic fallback, malformed output and repair, invented evidence, conflicting conclusions, attempts to confirm, tampered and stale reports.
- **Claude provider** (`server/atlasAi.test.ts`): the real provider class and the official SDK against a local HTTP stub of the Messages API: request shape, authentication header, retries on 429/5xx, error mapping, refusal, truncation, non-JSON output, timeout, abort. These prove the provider code, not the real service.
- **Cyber layer** (`src/cyber/cyber.test.ts`): each cyber rule, case grouping, ATT&CK context, the cyber-physical standings including the misleading cases, the approved-then-unapproved escalation regression, read-only assessment, and a check that no code outside the simulator can write a controller setting.
- **Ollama provider** (`server/ollamaProvider.test.ts`): request shape against a local stub of the Ollama API, health check, error mapping, configuration defaults, and a full five-agent run through the provider. Like the Claude tests, these prove the code, not a real model.

Set `ATLAS_TRACE=1` and pass `--silent=false` to print each scenario's full timeline, hypotheses and criteria.

## 14. Known limits

| Area | Limit |
| --- | --- |
| Baselines | 40 s learning window; a baseline learned while a fault is already present will treat it as normal |
| Correlation | Structural and temporal rules; no learned causal strengths. An asset belongs to one incident at a time |
| Reasoning | Eleven hand-written templates; frozen after an intervention |
| AI layer | Never executed against the real API in this repository's history: see EVALUATION.md |
| Scale | One facility in memory; fine for hundreds of assets, untested beyond |
| Persistence | None: incidents and AI reports live in memory |
| Sonar targets | An asset is contacted at one point; long pipelines reveal when the wave reaches their reference point |

## 15. Agentic investigation layer

### Responsibilities

| Agent | Reads | Produces |
| --- | --- | --- |
| Evidence Analyst | anomalies, signal states and baselines, assets | observations (cited), sequence of events, interpretations, evidence gaps, evidence quality |
| Impact Analyst | assets, relations, deterministic exposure, anomalies | directly abnormal vs potentially affected assets (with pathway and exposure), cascades |
| Hypothesis Analyst | rule-based hypotheses with criteria, evidence findings | per-hypothesis stance with supporting and contradicting claims, a challenge to the leading hypothesis, discriminating checks, agreement with the deterministic ranking |
| Investigation Planner | hypotheses, gaps, hypothesis review, deterministic checks | prioritised physical checks, each tied to the hypotheses it separates and the gap it closes |
| Investigation Orchestrator | the specialists' outputs, rule-based baseline, agent status, cross-check disagreements | conclusion with standing (consistent / competing / insufficient), key findings, disagreements and their resolution, open questions, limitations, what a person must verify |

Each agent sees a different slice of the investigation context (`buildAgentInput`), built from engine state by `buildInvestigationContext` and validated against a strict schema both before sending and on the server.

### Orchestration (code, not model)

```
stage 1 ─┬─ Evidence Analyst ─┐     (parallel)
         └─ Impact Analyst  ──┤
stage 2 ── Hypothesis Analyst ┤     (gets stage-1 findings)
stage 3 ── Investigation Planner    (gets hypothesis review + gaps)
stage 4 ── Investigation Orchestrator (gets everything + deterministic cross-check)
```

- `planTasks` skips an agent with nothing to analyse and records why.
- `crossCheck` compares agent outputs with each other and with the deterministic engine without a model (for example an asset called abnormal with no detection on it), and hands the disagreements to the orchestrator.
- Limits: at most 2 calls per agent (one answer, one repair), 90 s per call, 240 s per run, so at most 10 model calls. All configurable.
- An authentication, configuration, bad-request, network or abort error stops the run at once; a timeout or a bad answer fails that agent only, and later agents are told what is missing.
- The run returns `complete`, `partial` or `failed`. A failed run changes nothing; the deterministic investigation is complete without it.

### Validation gates

Every answer passes two gates before it is used:

1. **Schema** (`schemas.ts`): strict zod objects, every field required, no unknown keys. No numeric confidence and no disposition field exist, so a model cannot express "87 % likely" or "confirmed" in a field.
2. **Grounding** (`grounding.ts`): every cited ID must exist in that run's context; observations must cite something; unknown assets and hypothesis keys are rejected; certainty wording ("the root cause is confirmed") and probability wording ("87 % probability") are rejected; a number with a unit that appears nowhere in the context is flagged. List items with a rejected issue are removed; a rejected top-level conclusion rejects the whole answer.

A rejected answer gets one repair attempt with the specific issues fed back. The browser re-validates the final report (`acceptReport`): schema, citations, incident identity and `confirmedByAi === false`.

### Governance

- AI reports are stored beside incidents in `AiService`, never inside them. No code path lets a report change a hypothesis, its score or its disposition. Only `setDisposition`, called from an operator action, can confirm or rule out.
- A report records the evidence signature it was built on and is marked out of date when the incident's detections change.
- The audit trail records, per model call: agent, attempt, FNV-1a hash and size of the input, the input itself, the raw output, validation issues, whether it was accepted, latency and tokens. It can be exported from the AI tab.
- No chain-of-thought is requested, stored or displayed. The interface shows structured findings, citations, disagreements and validation results.
- The interface keeps three assessments side by side: rule-based engine, AI-assisted review, human verdict.

## 16. AI service, provider and security

- **Provider abstraction** (`src/agents/provider.ts`): `LlmProvider.complete({ name, system, user, schema, maxOutputTokens, timeoutMs, signal })` returns parsed output and token usage, or throws a typed `LlmError` (`auth`, `config`, `rate_limit`, `timeout`, `network`, `server`, `bad_request`, `bad_response`, `refusal`, `aborted`).
- **Claude provider** (`server/anthropicProvider.ts`): official `@anthropic-ai/sdk`, Messages API with structured output (`output_config.format` from the zod schema) and `output_config.effort`. Default model `claude-opus-5-5`. The SDK retries 408/409/429/5xx twice with backoff; `stop_reason: refusal` and `max_tokens` are failures, not answers; text that is not JSON is never returned as an answer. Server-side refusal fallback is on by default and can be switched off.
- **Key isolation:** the key is read from the environment of the Node process (`.env.local` via Vite's `loadEnv`) by the Vite plugin in `server/atlasAi.ts`. Nothing without a `VITE_` prefix reaches the browser bundle. `/api/ai/status` never returns key material. The endpoint accepts only a schema-valid investigation context (at most 400 KB, at most 2 concurrent runs); prompts are fixed on the server, so it cannot be used as a general proxy to the model.
- `ANTHROPIC_BASE_URL` set in the environment for some other tool is deliberately ignored; only `ATLAS_LLM_BASE_URL` redirects requests.
- A static build (`vite build`) has no AI endpoints: AI is available with `npm run dev` and `npm run preview`.
- **Scripted test double** (`src/agents/testing/scriptedProvider.ts`): assembles answers mechanically from the context. It exists for tests and interface work, is enabled only with `ATLAS_LLM_PROVIDER=scripted` and `ATLAS_ALLOW_SCRIPTED_PROVIDER=1`, and every report and screen it produces says it is not a language model.

## 17. Evaluation

`npm run eval` (offline: physical, cyber-physical and agent-governance suites) and `npm run eval:live` (needs a key) are described with their results in [EVALUATION.md](EVALUATION.md). Ground truth comes from the simulator, which knows what it injected, and from counterfactual twin runs: two simulators with the same seed in lock-step, the fault injected into one only, so their difference is the fault's effect with noise cancelled.

## 18. Cyber layer

**Where it lives.** The OT architecture is facility data, like the asset model: `src/simulation/otModel.ts`. Security telemetry is produced by `src/simulation/CyberSimulation.ts`, inside the simulated "world". Detection is in the core: `src/cyber/CyberEngine.ts`. The adapter contract gained one optional capability, `SecuritySource.describeOt()`, and the sink gained `ingestSecurity(records)`. A real deployment would map a passive OT network sensor and controller audit logs onto these. `src/core/types.ts` still imports nothing.

**Model.** Five zones (L4 enterprise, DMZ, L3 operations, L2 supervisory, L1 control); 14 devices; network links; four permitted conduits (zone to zone, by protocol); four role identities; `controls` / `monitors` relations from each PLC to physical assets; writable parameters, each with the assets it acts on and the signals expected to move when it is lowered; and approved change records (controller, parameters, account, source host, window, allowed value range).

**Cyber-to-physical path.** Exactly one: a scripted controller write calls `SimulationEngine.setControlParameter`, and only the cooling-tower fan speed setpoint is wired into the process model. The fan model reduces to the original equations at 100 %, and the security simulation has its own random stream, so every existing physical run is bit-identical. A test enforces that no code outside `src/simulation` and `src/adapters` references the write path.

**Detection.** Five rules (AUTH-BURST, ENG-SESSION, CONDUIT, FIRST-SEEN, UNAPPROVED-CHANGE) plus informational APPROVED-CHANGE and CONTROLLER-READ records. FIRST-SEEN learns the communication baseline during the first 60 s and does not flag a flow covered by an active approved change with an open session. Events are deduplicated per rule and subject for 10 minutes. Events that share an account or device within 15 minutes form a case; informational events and lone advisories open no case.

**ATT&CK for ICS.** Seven technique IDs, names and tactics were verified on attack.mitre.org (content v20.1) and are stored in `src/cyber/attack.ts`. Rules attach them as context; every event that carries one also carries the caveat that a mapping is not a finding. Rules with no matching ICS technique, such as password guessing, say so instead of borrowing one.

## 19. One graph across three layers

The model keeps one set of identifiers across layers rather than three disconnected graphs:

- **Physical:** assets and typed relations (process, mechanical, electrical, cooling, utility), as before.
- **Cyber:** devices, zone membership, network links, conduits, identities, and the `controls` / `monitors` relations that join a PLC to physical asset IDs.
- **Intelligence:** anomalies (`ANM-`), incidents (`INC-`), cyber events (`CEV-`), cases (`CYB-`) and hypotheses. Each references the physical and cyber IDs above.

Navigation follows the joins in both directions. From a physical asset you reach its controller (device detail lists *controls*), then that controller's zone and events, then the event's case and the incident whose origin it controls, then that incident's evidence. From an event you reach the controlled equipment, which can be shown in 3D with the OT layer, and the cyber-physical assessment. No relationship is computed from proximity in time or space.

## 20. Cyber-physical assessment

`assessCyberPhysical(incident, anomalies, cyber, now)` in `src/cyber/assess.ts` is deterministic and read-only.

1. **Origin candidates:** the incident's origin plus alternatives within 0.1 of its score.
2. **Links:** cyber events in the window (30 minutes before onset, up to now) that touched a controller which `controls` an origin candidate. Nothing else is linked.
3. **Change test:** for linked parameter writes, the parameter must be declared to act on the origin; the change must precede the first detection (−2 s detection allowance, up to 600 s lead); and the deviation must match the declared signature (at least two of the expected signals, or all if fewer, anomalous in the expected direction).
4. **Fault discriminator:** a trip or high vibration on the origin equipment is independent evidence of an equipment fault.
5. **Standing**, first match wins: multiple_plausible (consistent change and fault signs) → control_change_supported / authorized_change_supported (consistent change) → possible_relationship (controller access before onset, no change) → correlated_not_causal (unlinked events within ±120 s) → physical_supported (strong or moderate physical lead) → insufficient_evidence.
6. **Explanations** (equipment fault, unapproved change, approved change, unrelated cyber activity) with per-criterion observed flags and evidence IDs; **unknowns**, always present (sensor validity, flow summaries rather than content, account rather than person, controller program not verified); and **next steps**, which are investigative only.

For cyber cases, `assessCase` lists the potential impact (equipment controlled by touched PLCs: declared reach, not observed effect) and any incident whose origin those PLCs control.

The agents receive the events and this assessment in their context (`cyber` in `ContextSchema`). CEV IDs and OT device IDs are citable. The grounding validator gained `causal_overreach`: unhedged attribution to an attack or attacker is rejected, while hedged statements ("whether it was malicious is not established") pass.

## 21. Interface architecture

- **Views:** `AppView` = `overview | spatial | cyber` in the UI store; keys 1–3. The WebGL scene stays mounted (one context) and `SpatialEngine.setPaused` stops drawing while a full-page view covers it.
- **Overview** (`OverviewPage.tsx`): computed indicators, a "requires attention" list merging incidents and cases with a domain tag from the assessment, facility areas with their controllers, recent changes, the demonstration launcher (`runtime.runScenario` resets to the seed first), and recent activity.
- **Cyber & OT** (`CyberPage.tsx`): SVG zone map by level, cases, a filterable event feed, and event / case / device detail (`cyber.tsx`).
- **Workbench:** a `Cyber-physical` tab, plus a one-line cyber-physical verdict under the three-way assessment. Opening an incident on that tab turns on the 3D OT layer.
- **OT layer** (`src/spatial/OtLayer.ts`): controller cabinets in their areas, control-room hosts, dashed control links to each controlled asset (declared only), and network links. Devices take the colour of recent event severity, and links to the focused incident are drawn at full strength.
- **Design layer:** `src/vanterra.css`, with semantic colour tokens (physical severity warm, cyber azure, AI violet, confirmed green), dashed for "possible", solid for "supported". See docs/BRAND.md.
## 22. Scenario language and local inference

**Scenario language (evaluation only).** `SimulationAdapter` exposes three hooks:
- `setSensorFault(tag, {bias, driftPerMin})` falsifies one reading without touching the process;
- `injectSecurity(records)` adds security records that travel the normal security path;
- `engineeringWrite(...)` records a controller audit entry and applies it to the process.

`src/eval/independent.eval.ts` composes scenarios from these plus the built-in scenarios. They are not reachable from the engines, runtime or UI; `src/cyber/cyber.test.ts` fails if code outside `src/simulation`, `src/adapters` or `src/eval` references them.

**Local inference.** `server/ollamaProvider.ts` implements `LlmProvider` over Ollama's `/api/chat`:
- the agent's zod schema is converted with `z.toJSONSchema` and sent as `format`, so outputs are schema-constrained before Vanterra's own gates run;
- temperature 0, and `think: false` for thinking models, so no chain-of-thought is produced;
- a `health()` readiness check (server reachable, model pulled) drives `/api/ai/status`, so the UI says exactly why local AI is unavailable;
- local mode defaults to longer bounds (900 s per call, 3600 s per run) and zero cost.

The same five agents, schema gate, grounding gate (including causal overreach), audit and read-only guarantees apply to every provider.