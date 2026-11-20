# Product discovery: where Vanterra's foundation is most useful

**Date:** 2026-11-20. **Status:** findings, a selected direction and one implemented proof. Everything marked *hypothesis* is unvalidated. No user research was conducted; the market evidence is a small number of web sources, listed at the end.

## 1. What the foundation actually is

Inspected in the code, not assumed:

| Capability | Where | Domain-specific or reusable |
| --- | --- | --- |
| Declared relationships (assets, process links, which controller controls what, which setting affects what) | `src/graph`, `src/simulation/otModel` | The structure is generic; the content is one plant |
| Deterministic detection on time series (six detectors) and on security records (five rules) | `src/anomaly`, `src/cyber/CyberEngine.ts` | Detectors are generic; rules are OT-specific |
| Evidence with stable IDs (`ANM-…`, `CEV-…`) and a grounding gate that rejects anything citing evidence that does not exist | `src/agents/grounding.ts` | Generic |
| **Explicit standings**: every explanation is *supported*, *possible* or *not supported*, with the criteria that were and were not met, what is not known, and what would settle it | `src/cyber/assess.ts` | The pattern is generic; the criteria are cyber-physical |
| Counterfactual twin runs and a scenario language: ground truth for evaluation, and scenarios written blind by a separate author | `src/eval` | Generic method; needs a simulator per domain |
| Optional AI review that cannot confirm anything, with schema and grounding gates | `src/agents`, `server` | Generic |

The differentiating asset is not the 3D view or the AI. It is the **discipline**: links only through declared relationships, explanations with explicit criteria, unknowns stated, and a person confirms. Most of the rest can be copied; that discipline, with tests and evaluations that enforce it, is harder to fake.

## 2. Evidence about the problem

Verified in sources (paraphrased; see §9):

- When a plant behaves abnormally, teams have to establish whether the cause is cyber, mechanical, process-related or a mix, and the data needed is often not collected in time (Dragos, OT incident response material).
- A 2026 conference presentation reports that 82 % of surveyed organisations had **no criteria for when an operational anomaly should trigger a cyber investigation** (OTCEP 2026 deck, Robert M. Lee). One source; survey method not checked.
- SANS argues that ICS incident response should be engineering-led, and that IT-style response can do harm in plants. It recommends regular scenario-driven exercises that include engineers and operators; CISA publishes free ICS tabletop packages; vendors such as Dragos run facilitated tabletops; academic work combines cyber ranges with process simulation (MIT CR-ICS).
- Process-analytics products (Seeq, TrendMiner) are sold to engineers for self-service root-cause analysis on process data. The sources found describe process data analysis; they were not checked for OT-security correlation, so **no claim is made about what they lack**.

Hypotheses (not verified): plant engineers and security analysts often investigate the same event separately; a shared, plain-language triage would shorten the "is this cyber?" decision; a simulated plant with known answers would be valued for training.

## 3. Opportunities evaluated

| | A. Cyber-or-equipment triage | B. Investigation drills | C. Plain-language investigation | D. Post-incident evidence record | E. General "investigate any system" engine |
| --- | --- | --- | --- | --- | --- |
| Problem | "Should this anomaly become a cyber investigation?" | Teams need practice with a known right answer | Specialist output is unreadable to operators and managers | Reviews need a defensible trail | Fragmented evidence in many domains |
| User | Plant engineer, OT security analyst, shift lead | Engineers, operators, analysts, students | Operators, managers, students | Engineering and security leads | Unclear |
| Evidence of need | 82 % statistic (one source); Dragos | SANS, CISA, vendor tabletops exist | Inferred from the above | Hypothesis | Hypothesis |
| Existing capability | Standings, criteria, declared links: **complete** | Scenarios, ground truth, scoring harness: **complete**, no UI | Assessment structure: **complete** | Audit trail exists; no persistence | Partial; rules are domain code |
| New work | Small | Medium (challenge UI, scoring view) | Small | Medium (persistence, export) | Large refactor |
| Differentiation | Explicit, testable trigger criteria | Simulated plant with causal ground truth, between paper tabletops and full cyber ranges | Every plain sentence carries evidence; no model | Moderate | Unproven |
| Risk | Simulated plant only; real use needs integration | Realism of one plant | Oversimplifying | Low | Dilutes the core |
| Strengthens the core | Yes | Yes | Yes | Yes | No, not now |

Answers to the five questions asked:

1. **Expansion of the current product:** A, cyber-or-equipment triage.
2. **New application of the architecture:** B, investigation drills. The simulator's limitation, that it is not a real plant, becomes the point: the right answer is known, so performance can be scored.
3. **Accessibility for ordinary users:** C, plain-language investigation.
4. **Professional users:** A, then D once persistence exists.
5. **Category-defining:** the combination of A, B and C, *evidence-bound cyber-physical triage that a non-specialist can follow and a team can practise on*, is the strongest differentiation hypothesis. It is a hypothesis; nothing here proves demand.

**Rejected or deferred:** E (generalising before a second domain is chosen would add abstraction without a user). Healthcare and finance operations (high stakes, regulated, no domain expertise or data model here). IT operations and AIOps (a large existing vendor category, not researched here; Vanterra's physical-process strengths would not transfer). D waits for persistence (desktop phase 3).

## 4. Selection

**Selected: A + C now, B next.** One coherent direction: help the people who run plants answer *"is this the equipment, a change, or something on the network, and what do we actually know?"* in words they understand, and give teams a way to practise it.

Why: a documented gap (the trigger-criteria finding), capability that already exists and is tested, the smallest new work, and it deepens the core rather than diluting it. B is the most plausible adoption path because it needs no integration with a real plant, but it needs more UI work than this phase justifies.

## 5. Proof implemented: "In plain words"

**What:** `src/cyber/briefing.ts`, shown at the top of the workbench's Cyber-physical tab. It restates the deterministic assessment as:

- **In short:** one or two sentences, no jargon.
- **Should this become a cyber investigation?** One of *yes*, *check*, *separately*, *no*, *not yet*, with the reason. This is the explicit trigger criterion the 82 % finding says most organisations lack.
- **What we know for certain:** observations and records only (unusual readings, change records, who made a change and whether it was approved), each with its evidence one click away.
- **What the evidence suggests:** interpretation, labelled as such, including what it does *not* support.

**Properties:** no model involved, so it is instant, works offline and cannot invent anything. It adds no reasoning of its own: every sentence is derived from the assessment, incident and records, and carries evidence IDs. It leaves the expert view unchanged below it.

**Tests** (`src/cyber/briefing.test.ts`, 6): flagship → *yes*, names the account and the missing approval, does not claim intent; pump fault → *no*, with "absence of evidence, not proof"; unrelated suspicious access → never treated as the cause; approved change → not a security matter, cites the change record; change plus independent fault → both checks; read-only. Every case checks that cited evidence exists, that the headline answers contain no jargon, and that no statement claims certainty, probability or an attacker.

**What it demonstrates:** the engine's epistemic structure can be presented to a non-specialist without a language model and without losing the evidence trail. **What it does not demonstrate:** that non-specialists understand it or act better with it. That needs a small user test (§8).

## 6. Accessibility direction

**Deterministic first.** Measured local AI on a 16 GB laptop takes 19–45 minutes per agent call (docs/LOCAL_AI.md), so a conversational assistant answered by a local model is not usable interactively on ordinary hardware. The questions people actually ask map onto structure the engine already computes, instantly:

| Question | Answered from |
| --- | --- |
| Why did this happen? | Standing and the supported explanation |
| What changed? | Change records linked through declared relationships |
| What evidence supports this? | Observed criteria and their evidence IDs |
| Could these two events be connected? | Declared relationship + order in time + expected signature |
| What do we know for certain? What are we guessing? | *Known* versus *suggests* in the briefing |
| What should I investigate next? | Next steps |
| Show me what is unusual | Detections, already ranked |

The AI review remains an optional second opinion, never the interface.

**Three levels, mapped to what exists:** *Everyday*: the briefing (implemented on the Cyber-physical tab). *Advanced*: the current workbench tabs. *Expert*: evidence IDs, criteria, the agent audit trail. The levels are layers on the same data rather than separate modes, so nothing is hidden from experts and nothing is duplicated.

**Done:** native `<details>` disclosure (keyboard-operable), visible focus, a test that headline answers contain no jargon. **Not done:** screen-reader audit, colour-contrast audit, translations, onboarding, user testing.

## 7. A universal investigation engine?

Partly present: generic evidence IDs, grounding, standings, the agent workflow and the evaluation method; a data-source adapter interface (`src/adapters`). Domain-bound: the correlation rules, the cyber rules, the assessment criteria, the scenarios and the 3D scene.

**Recommendation:** do not generalise now. Keep the existing seams clean (adapter, declared-relationship data, evidence IDs) and define a "domain pack" only when a second domain has a real user and data. Generalising the assessment criteria without that would produce an abstraction with no test case.

## 8. Next steps, in order

1. **Validate C with people:** 3–5 non-specialists (operators or students) read the flagship and the pump-fault briefings and answer "what happened, and should security be involved?". Success: correct answers without help.
2. **Prototype B:** a "What caused this?" drill on the existing scenarios. The trainee picks an explanation and the evidence for it, then sees the ground truth and the deterministic assessment. The scoring logic exists in `src/eval`.
3. Extend the briefing to the incident overview, not only the Cyber-physical tab.

## 8b. Beyond plants: finance and consulting (exploration, nothing implemented)

The core question, *"was it a system fault, an unapproved change, or a security event, and what does the evidence allow us to say?"*, is not specific to plants. The closest fit outside industry is **operational incidents in financial services**:

| Vanterra concept | Financial-services equivalent |
| --- | --- |
| Equipment and process links | Services and their dependencies (payments, trading, core banking) |
| Controller writes and change records | Production deployments and configuration changes against change tickets |
| Security telemetry | Identity and access logs, privileged sessions |
| "Should this become a cyber investigation?" | "Is this a major ICT incident, and does security need to be involved?" |
| Standings with explicit criteria | An auditable root-cause record |

Why this domain: EU financial entities must manage, classify and report ICT-related incidents and analyse their root causes under the Digital Operational Resilience Act (Regulation (EU) 2022/2554, applicable since January 2025), and change-management controls are a standard part of IT general controls in financial audits. Both reward an investigation that separates evidence from interpretation and leaves a defensible trail. That is a reasoned hypothesis, not validated demand.

What it would take: a domain pack (service graph, change-ticket and access-log adapters, detection rules), new evidence types, and validation with practitioners. It is a consulting-style use as much as a product: an *evidence standard* for post-incident reviews. **Not started**; the industrial product stays the focus.

## 9. Sources

- Dragos, *OT Cybersecurity Lessons Learned from the Frontlines*: https://www.dragos.com/blog/ot-cybersecurity-lessons-learned-frontlines
- OTCEP 2026, R. M. Lee, threat landscape presentation (82 % finding): https://isomer-user-content.by.gov.sg/274/de794ba9-7470-4f41-a893-3ff75d48bf01/D1%201350%20Robert%20M%20Lee%20v2%20-%20OTCEP%202026_Robert_Lee_Threat_Landscape_v3.pdf
- SANS, *ICS/OT incident response and living-off-the-land attacks*: https://www.sans.org/blog/ics-ot-incident-response-living-off-land-attacks
- SANS, *Top 5 ICS incident response tabletops*: https://www.sans.org/blog/top-5-ics-incident-response-tabletops-and-how-to-run-them
- CISA, ICS tabletop exercise package (situation manual): https://www.cisa.gov/sites/default/files/2025-01/Industrial-Control-Systems-CTEP-Situation-Manual-082024-508.docx
- Dragos, OT tabletop exercises datasheet: https://dragos.brightspotcdn.com/78/a1/39a55e0f4a8caab00488d9cf4ce5/dragos-datasheet-ot-tabletop-exercises.pdf
- MIT CAMS, cyber range for ICS with process simulation: https://cams.mit.edu/wp-content/uploads/CAMS_Cyber_Range_paper.pdf
- Seeq, root cause analysis: https://www.seeq.com/resources/blog/what-is-a-root-cause-analysis/
- Siemens Xcelerator, TrendMiner: https://xcelerator.siemens.com/global/en/all-offerings/products/trendminer.html
