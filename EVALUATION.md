# Vanterra evaluation

This document reports what has been measured about Vanterra, how, and what has not been measured. Every number here was produced by a script in this repository and can be regenerated. Deterministic results and language-model results are kept in separate sections because they have different standing: the first are measured across seeds, and the second come from a **small live sample on a local model**.

| Part | Command | Status |
| --- | --- | --- |
| Detection, correlation, origin, hypotheses, separation, false positives | `npm run eval` | **Measured** — 10 seeds, 160 scenario runs (single faults also have a fault-free twin each) |
| Cyber detection, cyber false positives, cyber-physical conclusions | `npm run eval` | **Measured** — 10 seeds, 6 assessment cases, scenario B, 5 h normal operation |
| Independent, blind-authored scenarios (18 scenarios × 5 new seeds) | `npm run eval` | **Measured** — first run 80/90, after one product fix 90/90 (§2c) |
| Governance gate against adversarial model answers | `npm run eval` | **Measured** — 99 corrupted answers |
| Agent-workflow mechanics | `npm run eval` | **Measured with the scripted test double** — says nothing about reasoning quality |
| Live model: grounding, reasoning quality, latency, tokens, cost | `npm run eval:live` | **Local model (`qwen3:4b`, CPU): run on a small sample** (§4). Claude: not measured (no API key) |
| Human assessment | — | **Not studied** — no user study was run |

Raw results: `eval/results/*.json`; generated tables: `eval/results/*.md`.

---

## 1. Methodology

### Ground truth

The detection and reasoning engines never see what was injected. The evaluation harness does, which gives two kinds of ground truth:

1. **Injected fault.** Each fault scenario has a known origin asset and a known mechanism, which corresponds to one rule-based hypothesis template:

   | Scenario | Correct origin | Correct mechanism (template) |
   | --- | --- | --- |
   | `pump-bearing` | P-101 | `bearing_wear` |
   | `cooling-fan` | CT-401 | `tower_airflow_loss` |
   | `mcc-sag` | MCC-520 | `mcc_joint` |

2. **Counterfactual twin run.** Two simulators with the same seed advance in lock-step and the fault is injected into one only. Both consume the random stream identically, so the difference between them is the fault's effect with measurement noise cancelled. Of 82 measured signals, 28 remain bit-identical in the pump scenario, which confirms the streams stay aligned. A signal's effect is expressed in units of that signal's standard deviation in the fault-free twin:
   - **materially affected:** moved by ≥ 3 σ for ≥ 5 s in total (what a detector should find);
   - **affected:** moved by ≥ 1 σ at some point (a detection on such a signal is not a false positive).

### Metrics

| Metric | Definition |
| --- | --- |
| First detection | Time from injection to the first anomaly anywhere |
| After physical onset | First detection minus the first time any signal was materially affected. This separates the detector's delay from how fast the fault itself develops |
| Incident opens | Time from injection to the incident being opened |
| Signal recall | Materially affected signals that received a detection ÷ materially affected signals. Reported over monitored signals (watched by a statistical detector or with engineering limits) and over all signals |
| Signal precision | Detected signals that the fault actually moved (≥ 1 σ) ÷ detected signals |
| Origin / lead correct | The incident's top origin candidate and top hypothesis match the ground truth at the end of the window |
| Time to correct | First second at which an incident had both the correct origin and the correct leading hypothesis |
| Ranking stability | Share of the seconds after the incident opened in which origin and lead were both correct |
| Support margin | Leading hypothesis support minus the second's (support is an evidence score, not a probability) |
| Separation | Independent faults produce one incident each, none containing two faults' origins |
| False positives | Anomalies and incidents during normal operation and planned changes |

### Protocol

- Seeds 20260112 (the demo seed) and 1–9, chosen before the run and not tuned.
- 120 s pre-roll so baselines are learned; 240 s observation window after injection.
- Single faults: 3 scenarios × 10 seeds. Simultaneous faults: 4 combinations × 10 seeds. Sequential faults: 2 injection orders × gaps of 30, 60 and 90 s × 10 seeds. Normal operation: 30 min steady, a rate change 100 → 70 → 100 %, and a pump changeover, per seed.
- The harness measures and never gates. It runs in about a minute.

---

## 2. Deterministic results — measured

Run on 2026-11-17 (`eval/results/deterministic.md`).

### Single faults

| Scenario | Detected | First detection s, median (range) | After physical onset s | Incident opens s | Recall, monitored | Recall, all moved | Precision | False detections | One incident | Origin correct | Lead correct | Time to correct s | Stability |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pump-bearing | 10/10 | 11.1 (10.5–12.0) | 5.6 | 16.9 | 74.3 % of 35 | 65.0 % of 40 | 100 % | 0 | 10/10 | 10/10 | 10/10 | 19.0 | 99.3 % |
| cooling-fan | 10/10 | 3.5 (3.3–3.5) | 0.3 | 5.3 | 100 % of 14 | 93.3 % of 15 | 100 % | 0 | 10/10 | 10/10 | 10/10 | 6.0 | 100 % |
| mcc-sag | 10/10 | 3.0 (2.8–3.0) | 2.0 | 6.0 | 87.2 % of 15 | 87.2 % of 15 | 100 % | 0 | 10/10 | 10/10 | 10/10 | 6.0 | 100 % |

### Hypothesis quality

| Scenario | Mean support margin | Alternatives with an observed contradiction | Correct hypothesis contradicted | First recommended check on the true origin | Detections in the fault-free twin | Confirmed without an operator |
|---|---|---|---|---|---|---|
| pump-bearing | 0.53 | 100 % | 0/10 | 10/10 | 0 | none |
| cooling-fan | 0.80 | 100 % | 0/10 | 10/10 | 0 | none |
| mcc-sag | 1.00 | 100 % | 0/10 | 10/10 | 0 | none |

### Independent faults

| Faults | Runs | Kept separate | Origins correct | Leads correct |
|---|---|---|---|---|
| pump-bearing + cooling-fan, simultaneous | 10 | 10/10 | 10/10 | 10/10 |
| pump-bearing + mcc-sag, simultaneous | 10 | 10/10 | 10/10 | 10/10 |
| cooling-fan + mcc-sag, simultaneous | 10 | 10/10 | 10/10 | 10/10 |
| all three, simultaneous | 10 | 10/10 | 10/10 | 10/10 |
| pump → fan → MCC, 30 / 60 / 90 s apart | 30 | 30/30 | 30/30 | 30/30 |
| MCC → fan → pump, 30 / 60 / 90 s apart | 30 | 30/30 | 30/30 | 30/30 |

### Normal operation

| Activity | Runs | Simulated hours | Anomalies | Incidents |
|---|---|---|---|---|
| steady operation | 10 | 5.00 | 0 | 0 |
| rate change 100 → 70 → 100 % | 10 | 2.33 | 0 | 0 |
| feed pump changeover | 10 | 1.17 | 0 | 0 |

### Reading these results

- **Every fault was detected, on the right asset, with the right explanation, in every seed.** The pump fault takes longer because bearing wear develops gradually: the detector fires a median 5.6 s after the first signal moves by 3 σ.
- **Precision is 100 % and recall is not.** The detectors are deliberately conservative (4 σ for 3 s, or engineering limits): ATLAS prefers to miss a weak secondary effect over raising a false alarm. The missed signals in the pump scenario are downstream consequences such as power on other motors (peak effects of roughly 7–40 σ) and availability flags that no detector watches. Incident-level detection is unaffected.
- **Zero false positives in 8.5 simulated hours**, including planned rate changes and a changeover, which re-baseline rather than alarm.

### What the harness found and what changed

This evaluation was not run once at the end. Its first run found that **the pump-bearing and cooling-fan faults merged in 3 of 10 seeds** when injected together: pump vibration was linked to the cooling-water upset through the heat exchanger. A browser test then found that faults **injected one after another**, as an operator does in the UI, merged too. A fan trip was treated as a consequence of warm water returning to the tower, and an MCC sag 120 s after the pump fault was linked to a motor that had been abnormal for 30 s.

Four correlation rules were added, each based on physics rather than on a seed (ARCHITECTURE.md §8, rules 6–9): vibration travels only through a shaft; pressure, flow and level stay in their own fluid circuit; a trip is explained only by its supply or a coupled machine; a supply's own fault must precede the consumer abnormality it is said to cause. The sequential-fault runs were then added to the harness. With rules 6–8 in place but rule 9 still checking only the last step of a path, the pump → fan → MCC order scored 0/10 at the 60 and 90 s gaps, because the MCC sag linked to the agitator motor through two steps (supply, then shaft). Applying rule 9 to the whole path brought every cell above to 10/10, with single-fault and false-positive results unchanged.

**Caveat:** the fixes were evaluated on the same seeds that exposed the problems. The rules are not tuned to those seeds, and the one numeric parameter (5 s for supply lead) comes from measured detection latency. Even so, an independent check would use new seeds and new fault types.

---

## 2b. Cyber-physical evaluation — measured

Run on 2026-11-20 (`eval/results/cyber.md`, from `src/eval/cyber.eval.ts`). Ground truth is the scenario design: each case has the conclusions that are correct for it. The cyber scripts are deterministic, so seeds vary physical noise, flow volumes and detection timing, not the attack steps.

### Cyber detection

| Measure | Result |
|---|---|
| Notable cyber events in normal operation | 0 in 5.0 simulated hours (0 cases) |
| Scenario B: expected rules fired (AUTH-BURST, ENG-SESSION, FIRST-SEEN, CONTROLLER-READ, CONDUIT) | 50 / 50 |
| Scenario B: grouped into one case | 10 / 10 |
| Scenario B: physical incidents opened / physical effect claimed | 0 / 0 |
| Scenario B: first warning-level event after start (median) | 6.0 s |

### Conclusions of the cyber-physical assessment

| Case | Correct conclusion | Correct | Wrongly attributed to cyber | Cyber cause missed | Observed |
|---|---|---|---|---|---|
| A · pump bearing fault only | physical supported | 10/10 | 0 | 0 | physical_supported |
| A+B · same fault plus unrelated suspicious access | physical supported, or correlated without causality | 10/10 | 0 | 0 | correlated_not_causal |
| C · unapproved fan-speed change (flagship) | control change supported | 10/10 | 0 | 0 | control_change_supported |
| C′ · approved fan-drive tuning | approved change supported | 10/10 | 0 | 0 | authorized_change_supported |
| fan trip, then a change after onset | not a control-change conclusion | 10/10 | 0 | 0 | physical_supported |
| change, then an independent fan trip | multiple plausible | 10/10 | 0 | 0 | multiple_plausible |

**60 of 60** runs reached a correct conclusion. In the change scenarios the incident opened a median 4 s after the change. Unknowns were stated in every assessment, and no assessment changed an incident or a disposition.

**How to read this.** The five rules and the assessment criteria were written together with these scenarios, so a perfect score shows that the logic does what it specifies across seeds, including the cases where the correct answer is "not cyber". It does not show performance against unseen attack techniques, real OT traffic, noisy or missing security logs, or adversaries who avoid the rules. The most important result is the zero in the "wrongly attributed" column, together with the cases designed to tempt it (A+B; trip, then a late change).

## 2c. Independent evaluation — blind-authored scenarios

The suites above share a weakness: the scenarios and the rules were written together. This suite reduces that leakage.

### Method

1. **Separated information.** A separate agent wrote the scenarios and their ground truth. It worked only from [`eval/independent/AUTHORING_BRIEF.md`](eval/independent/AUTHORING_BRIEF.md), which defines the scenario language and the product's documented conclusions and flags, and [`eval/independent/catalog.json`](eval/independent/catalog.json), which holds facts about the plant and OT network. It was instructed not to read `src/`, `server/`, tests, results or architecture documents, and it ran no code.
2. **A scenario language, not scripts.** Scenarios compose timed physical faults, **instrument faults** (bias or drift on any signal; new for this suite), arbitrary security records, and engineering writes. The author therefore built situations the product's own scenarios never exercise.
3. **Ground truth stored apart from outputs.** Truth lives in [`eval/independent/scenarios.json`](eval/independent/scenarios.json). System outputs are recorded separately in `eval/results/independent.json`, and the harness (`src/eval/independent.eval.ts`) only compares them.
4. **Fresh seeds:** 20260112, 11, 23, 37, 41. Apart from the demo seed, none is used elsewhere.

18 scenarios × 5 seeds = **90 runs**, in eight categories: mechanical failure without cyber evidence (2), reconnaissance without impact (2), coupled cyber-physical (3), sensor fault (2), authorised maintenance (2), suspicious but insufficient (2), conflicting evidence (3), and sequential independent faults (2). Among the traps:
- a fan trip while an approved change window is open;
- an operator writing an in-range value from the wrong host;
- a vendor stepping the fan down in small in-range steps;
- an attacker failing logons as the engineer while the real engineer does approved work;
- a basin thermometer drifting low and hiding the effect of an unapproved change;
- an out-of-scope program download before an unrelated pump fault.

### Results

| Metric | First run | After the fix below |
|---|---|---|
| Scenario runs fully matching the ground truth | 80 / 90 | **90 / 90** |
| Expected physical incidents detected, correct origin | 90 / 90 | 90 / 90 |
| Acceptable cyber-physical conclusion | 85 / 90 | 90 / 90 |
| Forbidden conclusions reached | 5 (all IND-05) | 0 |
| False cyber attribution (truth: no cyber cause) | 0 in 40 | 0 in 40 |
| Missed cyber cause (truth: a change caused it) | 0 in 45 | 0 in 45 |
| Uncertainty respected (truth allows only uncertain conclusions) | 20 / 20 | 20 / 20 |
| Incident count within the truth's bounds | 90 / 90 | 90 / 90 |
| Expected cyber flags raised / forbidden flags raised | 135 / 135, 0 | 135 / 135, 0 |
| Ungrounded evidence IDs in assessments | 0 | 0 |
| Hypotheses confirmed without an operator | 0 | 0 |

**What the first run found.**

- **IND-05, a product defect, fixed.** An approved change to 60 % started the deviation; the same engineer then pushed the setpoint to 40 %, below the approved floor of 55 %. The assessment concluded "approved change supported", which hid the unapproved escalation. The assessment now recognises a later unapproved change to the same setting during the incident. The conclusion becomes "control-system change supported (contributing cause)", with both explanations shown. A regression test was added in `src/cyber/cyber.test.ts`.
- **IND-07, an error in the evaluation metric, corrected.** The product's conclusion was right. The harness's temporal check required *every* linked event to precede the onset, which failed a correct conclusion when the vendor's later step changes also linked to the incident. The metric now checks that the change the conclusion rests on preceded the first detection. The correction is commented in the harness.

### What this does and does not establish

- **It does establish** that, on situations written without knowledge of the rules, the system detected every expected incident with the correct origin. It never attributed a physical fault to cyber activity, never missed a real control change, and kept to uncertain conclusions whenever the truth required them.
- **The author was another instance of the same model family**, separated by information rather than organisation. A human OT investigator writing scenarios would be a stronger test.
- **The brief exposes the product's interface:** its seven conclusions and six flag names, which are documented features. It does not expose how they are computed.
- **After the fix, IND-05 is no longer a blind test** of that behaviour. Only new scenarios can test it independently again.
- **Sample size:** 18 scenarios × 5 seeds. The cyber records are deterministic, so seeds vary only physical noise and timing.
- **Everything is simulated.** These results say nothing about real plants, real OT traffic or real adversaries.

## 3. Agent layer — governance gate, measured offline

The schema gate and the grounding validator were given **99 corrupted answers**: 9 corruption types, applied to a valid answer from each of the 5 agents in each of the 3 scenarios, where the answer has the relevant field (`eval/results/agentic-offline.md`).

| Corruption | Trials | Reached an accepted output | Stopped by schema | Stopped by grounding |
|---|---|---|---|---|
| cites evidence that does not exist | 15 | 0 | 0 | 15 |
| names an asset that does not exist | 9 | 0 | 0 | 9 |
| refers to a hypothesis that does not exist | 9 | 0 | 0 | 9 |
| states a confirmed root cause | 9 | 0 | 0 | 9 |
| restates a score as a probability | 9 | 0 | 0 | 9 |
| adds a top-level disposition field | 15 | 0 | 15 | 0 |
| adds a confirmed flag inside a list item | 12 | 0 | 12 | 0 |
| returns the wrong type for a required list | 15 | 0 | 15 | 0 |
| makes an observation with no citation | 6 | 0 | 0 | 6 |

**0 of 99 reached an accepted output.** A fabricated figure ("4242 mm/s") was flagged as unverified in 9 of 9 answers. By design, flagged figures are shown with a marker rather than removed.

This measures the gates on known corruption patterns. It does not show that a real model's subtler errors would be caught: a claim that cites real evidence but draws a wrong conclusion passes both gates. That is why AI output stays advisory and a person confirms.

### Workflow mechanics (scripted test double — not a model)

| Scenario | Status | Model calls | Context sent | Detections / hypotheses / signals | Incident unchanged |
|---|---|---|---|---|---|
| pump-bearing | complete | 5 | 40.7 KB | 29 / 5 / 54 | yes |
| cooling-fan | complete | 5 | 35.2 KB | 29 / 5 / 42 | yes |
| mcc-sag | complete | 5 | 28.7 KB | 23 / 3 / 39 | yes |

These runs prove orchestration, call budget, bounded context and the no-mutation guarantee. The test double's answers are assembled mechanically from the context, so no quality metric is reported for them.

---

## 4. Live language model

**Local model: run.** `qwen3:4b` (Q4_K_M) through Ollama 0.40.16 on a CPU-only laptop (Intel i5-1135G7, 16 GB RAM, other applications open). Every number in this section comes from real model responses inside real Vanterra investigations, through the same provider, schema gate and grounding gate the app uses. **Claude: not run** (no API key); that provider is tested only against a local stub of the Messages API.

### Method

`npm run eval:live` builds each scenario's investigation context exactly as the app does (seed 20260112, investigated 150 s after injection), runs the five-agent workflow through the configured provider, and scores the report against the injected fault, the deterministic engine's result and the evidence catalogue (metrics below). It refuses to run on the test double. Results are written after every scenario to `eval/results/agentic-live.{json,md}`.

Because one investigation takes hours on this machine (docs/LOCAL_AI.md), live validation was deliberately small: one representative case per run, one run per case. These are observations, not statistics.

### Run 1: physical scenarios (stopped, partial)

Planned: pump-bearing, cooling-fan, mcc-sag. Stopped after 1 h 46 min, during the first scenario, for two reasons. The measured pace (19–45 min per call, with CPU at 100 % and heavy paging) projected 12–15 hours for the three scenarios. And the harness then saved results only at the very end, so any interruption would have lost everything. That second problem is fixed: results are now written after each scenario.

What it completed, from the run log and Ollama's timing log (answer contents were not retained):

| Agent (pump-bearing) | Calls | Outcome |
| --- | --- | --- |
| Evidence Analyst | 2 (40 min + 45 min) | The first answer was **rejected by Vanterra's validation**; the repaired answer was accepted as *degraded*: the grounding gate removed claims it could not support |
| Impact Analyst | 2 (19 min + stopped) | The first answer was rejected; the repair call was running when the run was stopped |

This establishes that real local inference runs end to end inside a real investigation, that real model answers were rejected by the gates and repaired, and the timing profile. It does not measure answer quality.

### Run 2: flagship cyber-physical scenario

*In progress at the time of writing; results are added here when the run finishes.*

### Earlier provider checks

- `server/atlasAi.test.ts` runs the Claude provider class and the official SDK against a local HTTP stub of the Messages API: request shape, authentication header, structured-output configuration, retries, error mapping, refusal, truncation, non-JSON output, timeout and abort.
- In the browser, with a placeholder key and an unreachable endpoint, the run failed after 2 calls in about 1.2 s with "network: Could not reach the model provider", and the deterministic assessment was unaffected.

### How to run it

Local (free): see [docs/LOCAL_AI.md](docs/LOCAL_AI.md), then `npm run eval:live -- --testTimeout=36000000`, optionally with `ATLAS_LIVE_SCENARIOS=cp-fan-setpoint`.

Claude: put `ANTHROPIC_API_KEY=<your key>` in `.env.local` and run `npm run eval:live`. Expect about 5–10 model calls per scenario; at list price ($4 / $20 per million input / output tokens for `claude-opus-5-5`) that is an estimated dollar or two for all four scenarios, not a measurement.

### What `eval:live` measures

| Group | Metrics |
| --- | --- |
| Outcome | run status, per-agent status and attempts, repairs, duration, input and output tokens, estimated cost |
| Grounding (every model answer, including ones later repaired) | citations accepted, invented evidence IDs, invented assets, invented hypotheses, uncited observations, certainty or probability wording, schema failures, claims checked, unsupported-claim rate (claims removed ÷ claims checked), figures flagged |
| Reasoning against ground truth | AI leading hypothesis vs injected mechanism; AI lead vs deterministic lead; standing; stance on the true hypothesis; alternatives given a contradiction; whether the leading hypothesis was challenged; coverage of the deterministic at-risk assets; whether the first check targets the true origin; checks linked to hypotheses; disagreements recorded |
| Governance | `confirmedByAi` is false; the incident is byte-identical before and after the run |

One run per scenario is an observation, not a statistic. A credible comparison of model quality would need many seeds, several fault types not seen during development, and repeated runs to measure variance.

---

## 5. Deterministic vs AI-assisted vs human

| Question | Rule-based engine | AI-assisted review | Human verdict |
| --- | --- | --- | --- |
| Correct leading explanation (3 scenarios × 10 seeds) | **30 / 30, measured** | not measured | not studied |
| Correct origin | **30 / 30, measured** | (reviews the engine's origin; does not rank its own) | not studied |
| Contradicting evidence shown for rejected alternatives | **100 %, measured** | not measured (schema requires a contradicting list and a challenge to the leading hypothesis) | — |
| Can confirm a cause | no (structurally impossible) | no (structurally impossible; 0 of 27 confirmation fields and 0 of 9 "confirmed root cause" statements accepted) | **yes — the only path** |
| Latency | ≈ 0.5 ms per telemetry batch in the browser (measured on the development machine) | not measured | — |
| Cost | none | not measured (estimated above) | — |

In the evaluation the injected fault stands in for a verified human verdict, since the simulator knows the cause. In the product, the interface keeps the three assessments side by side for each incident. When the incident changes after an AI review, the review is marked out of date.

---

## 6. Assumptions and limits

- **Simulated plant only.** The process model, noise and faults were written alongside the detectors. These results show internal consistency and robustness across seeds, not performance on real equipment.
- **Three fault types.** Generalisation to other mechanisms is untested.
- **No sensor faults, data gaps, late or out-of-order data** in the evaluation.
- **Fixes evaluated on the seeds that found the problems** (see §2).
- **The governance gate is tested against designed corruptions**, not against a real model's errors.
- **Live-model metrics: a small local sample only** (§4): one CPU-only machine, one 4B model, one run per case. Nothing here measures Claude, larger models, or variance between runs.

## 7. Reproducing

```
npm run eval        # offline, about a minute, never calls a model
npm run eval:live   # a real model: local Ollama (free, slow on CPU) or Claude (API key, costs money)
npm test            # 164 unit, scenario, cyber, briefing, ask, contrast, agent and provider tests
```
