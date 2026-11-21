# Portfolio material

Everything below describes implemented and tested work. The one unvalidated capability, a live LLM run, is described as "integrated", not "evaluated". Keep it that way until `npm run eval:live` has produced results.

## Two-line description

Vanterra is a cyber-physical intelligence platform that investigates industrial incidents across process telemetry and the OT network. It links events only through declared control relationships and states what the evidence does and does not support. A bounded five-agent LLM review sits on top, and only a human can confirm a cause.

## Positioning for consulting and finance

What Vanterra shows, in the terms those roles use:

| Consulting / finance skill | Where it is in Vanterra |
| --- | --- |
| Hypothesis-driven problem solving | Every incident gets competing explanations, each *supported*, *possible* or *not supported*, with the criteria met and not met |
| Separating fact from assumption | "What we know for certain" versus "what the evidence suggests", in the product and in every AI answer |
| Executive communication (answer first) | The plain-language briefing leads with the answer to "should this become a cyber investigation?", then the support |
| Risk and controls | Approved versus unapproved changes against change records: the same control that SOX IT general controls test for change management |
| Model risk management | The AI cannot confirm anything; every answer is checked against the evidence, rejected answers are kept for review, and its performance was measured on real runs, including where it failed |
| Quantitative rigour | Counterfactual twin simulations for ground truth; 10-seed and blind-authored evaluations with honest error reporting (80/90 before a fix, 90/90 after) |

**CV bullet for a consulting or finance application:** Built Vanterra, an evidence-based incident investigation platform (TypeScript, React, local LLMs). It separates facts from interpretations, tests competing explanations against explicit criteria, and gives non-specialists a direct answer with the evidence behind it. Designed its AI controls like a model-risk framework: grounded citations, rejection of overconfident or unsupported answers, human-only sign-off, and measured live performance.

**Interview line:** "The hard part was not the AI; it was deciding what the evidence allows you to say. Vanterra never says 'attack'. The strongest thing it can say is 'an unapproved change is supported; intent is not established'. That discipline is what I'd bring to a client's risk or incident review."

## CV bullets

- Designed and built Vanterra, a cyber-physical incident investigation platform (TypeScript, React, Three.js): six statistical detectors and graph correlation under physical propagation rules over an 84-signal plant simulation. It adds a simulated Purdue-model OT network with five detection rules, verified MITRE ATT&CK for ICS context, and a 3D digital twin with an OT layer.
- Built a deterministic cyber-physical assessment that links cyber events to physical incidents only through declared controller relationships, temporal precedence and expected physical signatures. Across 10 seeds it reached the correct conclusion in 60/60 runs, with 0 physical faults wrongly attributed to cyber activity, including deliberately misleading cases.
- Validated it against 18 blind-authored scenarios in 8 categories (90 runs). The first run scored 80/90 and exposed a real defect: an approved change could mask a later unapproved change to the same setting. After the fix and a regression test, it scored 90/90.
- Integrated a bounded five-agent investigation workflow that runs on the Claude API or on a local model through Ollama (no key, no cost): zod-validated outputs, a grounding validator that rejects invented evidence IDs and causal overreach ("the attacker caused…"), deterministic fallback, audit trail and server-side key isolation. 0 of 99 adversarial outputs passed validation; 164 automated tests in total. Ran it for real on a local 4B model on a CPU-only laptop, which exposed and led me to fix three reliability defects the stub tests could not reveal.

*(After a live run, add measured citation validity and the unsupported-claim rate to the third bullet.)*

## GitHub / LinkedIn

**Repository description:** Cyber-physical intelligence platform: process anomaly detection, a simulated OT network with rule-based detection, evidence-bound cyber-physical assessment, a 3D digital twin, and a bounded five-agent LLM review with human-only confirmation. Simulated environment.

**Topics:** `cyber-physical-systems` `ot-security` `ics-security` `industrial-ai` `anomaly-detection` `root-cause-analysis` `digital-twin` `llm-agents` `explainable-ai` `human-in-the-loop` `typescript` `threejs`

**LinkedIn entry:** Vanterra asks a question most tools split in two: when a plant misbehaves, is it the equipment, a configuration change, or something on the network, and what does the evidence actually support? It detects anomalies in process telemetry, detects suspicious activity on a simulated OT network, and links the two only through declared controller relationships, timing and physical signatures. It answers in explicit terms ("control-system change supported; intent not established", "correlated, causality not established") and lists what remains unknown. An optional multi-agent LLM review is grounded in evidence IDs and cannot confirm anything; that is the operator's job. A counterfactual evaluation harness measures it, including cases built to tempt it into blaming cyber. Everything is simulated; nothing touches real equipment.

## Interview explanation (about 2 minutes)

**Problem.** In OT incidents, process engineers and security analysts look at different screens. A temperature excursion gets blamed on hardware when someone changed a setpoint; a suspicious logon gets treated as the cause of an unrelated pump failure because it happened the same afternoon.

**What I built.** The deterministic core detects process anomalies and correlates them through a dependency graph with physical rules. A simulated OT network (zones, PLCs, engineering workstation, jump host, conduits, change records) feeds five detection rules. The key piece is the cyber-physical assessment. A cyber event is linked to an incident only if the controller it touched is declared to control the equipment where the incident started. A change explains the incident only if it came first and the measurements moved the way that parameter is declared to move them. A trip or high vibration keeps the hardware explanation open. It never says "attack": the strongest conclusion is "a control-system change is supported; intent is not established".

**AI.** Five agents review the investigation in a code-controlled workflow. Every output passes a schema and a grounding check, which rejects invented IDs and unhedged attribution to an attacker. The AI is advisory: reports sit beside incidents and cannot confirm anything.

**Evidence it works.** Counterfactual twin simulations give physical ground truth. The cyber-physical cases include deliberately misleading ones: unrelated suspicious access during a pump fault, and a setting change made after a fan had already tripped. 60 of 60 runs reached the right conclusion with zero false attributions. Because the rules and those scenarios were designed together, I also ran 18 scenarios written blind from a brief. That run found one real defect, which I fixed. The caveats: the environment is simulated, the blind scenarios were written by an AI author rather than a domain expert, and the LLM layer has not been run against a live model (Claude or local).

## 60-second pitch

Vanterra is an investigation platform for industrial incidents where physical and cyber events meet. It detects anomalies in process telemetry and suspicious activity on the OT network, and connects them only through declared relationships: this controller drives that machine, this parameter moves these signals. When a fan slows after an unapproved setpoint change, it says a control-system change is supported and that intent is not established. When a pump bearing fails during unrelated suspicious access, it says correlated, not causal. A 3D digital twin shows the plant with its control layer, and an optional evidence-grounded multi-agent LLM review sits on top. Only a person confirms a cause. Evaluated over ten seeds: every physical fault found with the right explanation, and every cyber-physical case concluded correctly, with no false blame. It runs entirely on simulated data, by design.

## The engineering contribution

| Area | What was done |
| --- | --- |
| Architecture | Headless core shared by browser, tests and evaluation; data and security sources behind adapter interfaces; render loop outside React |
| Physical intelligence | Six detectors; graph correlation with nine physically justified rules; evidence-scored hypotheses |
| Cyber layer | Purdue-style OT model as data; simulated security telemetry; five rules; cases; verified ATT&CK for ICS context |
| Cyber-physical reasoning | Declared-relationship linking, precedence and signature tests, fault discriminator, seven explicit conclusions, stated unknowns |
| AI | Five agents, code orchestration, schema and grounding gates including causal overreach, audit, key isolation |
| Evaluation | Counterfactual ground truth, multi-seed physical and cyber-physical suites, adversarial governance check, live-model harness |
| Product | Overview, Spatial with OT layer, investigation workbench, Cyber & OT view, guided demo, scenario launcher, restrained design system |
