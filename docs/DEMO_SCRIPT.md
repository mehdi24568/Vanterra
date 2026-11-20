# Demo recording package

**No video has been recorded.** This is the complete package for a 2½–3 minute demonstration: settings, preparation, storyboard and narration. Record with the Xbox Game Bar (Win + Alt + R) or OBS Studio on Windows, or QuickTime on macOS.

## Settings

| Setting | Value |
| --- | --- |
| Viewport | 1440 × 900 browser window, zoom 100 % |
| Seed | default (20260112), so the run matches the screenshots and the evaluation |
| AI | Without a key the AI review shows "unavailable": say so. Never present the scripted test double as a model. |
| Length | about 2 min 45 s |

## Preparation

1. `npm run dev`, then open http://localhost:5173 in a private window so the welcome card appears.
2. Close other tabs and silence notifications. Do one dry run, then reload.

## Storyboard and narration

| # | Time | Screen | Action | Narration |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:12 | Welcome card | Hold | "Vanterra investigates industrial incidents across the process and the OT network together. The plant and network are simulated; the reasoning is real code." |
| 2 | 0:12–0:25 | Overview, all normal | *Explore on my own* | "The overview answers whether the facility is normal and what needs attention. Every figure here is computed; there are no made-up risk scores." |
| 3 | 0:25–0:45 | Overview | *Run scenario* on **C · Cyber-physical**; wait about 15 s | "Now a vendor account reaches the engineering workstation outside any approved window and changes a setting on the cooling-plant controller. Nothing is told to the detectors." |
| 4 | 0:45–1:00 | Overview: two cyber-physical items | Point at the list | "Two things need attention: a critical incident at the cooling tower, found from process measurements alone, and a cyber case. Both are tagged cyber-physical. Why?" |
| 5 | 1:00–1:25 | Cyber & OT → case → the unapproved change | Select CYB-0001, then CEV-0005 | "The OT view shows the zones and every step of the session. The fan speed setpoint went from 100 to 35 percent. A change record exists, for a different account and a range of 55 to 100, so the rule flags it. The ATT&CK reference is context, not a verdict." |
| 6 | 1:25–2:00 | *Open cyber-physical assessment* → workbench, OT layer on in 3D | Scroll the explanations | "Here is the core of the product. The change is linked to the incident only because PLC-500 is declared to control the cooling tower. It came first, the four signals that parameter should move all moved, and nothing suggests a mechanical fault. So: a control-system change is supported, and whether it was malicious is not established." |
| 7 | 2:00–2:20 | Overview → **A · Physical anomaly**, open the incident's Cyber-physical tab | Run, open | "Contrast: a pump bearing failure. No cyber evidence relates to it, and the assessment says so, adding that absence of evidence isn't evidence of absence." |
| 8 | 2:20–2:45 | Workbench overview → Hypotheses → *Mark confirmed* | Confirm | "Rule-based, AI-assisted, human and cyber-physical verdicts sit side by side. The automated parts recommend; only a person confirms." |

**Without an AI key** add one line at step 8: "With an API key, five agents also review the incident. Here AI isn't configured, and nothing else depends on it."

## Before publishing the video

- [ ] Nothing describes the plant or network as real.
- [ ] No support score is called a probability, and no event is called an attack.
- [ ] No terminal, `.env.local`, key or browser profile is on screen.
- [ ] If AI appears, its state is stated truthfully.

## Stills (real captures, `npm run capture`)

`docs/screenshots/`: 01 welcome · 02 overview normal · 03 overview during the flagship · 04 cyber case · 05 cyber event · 06 cyber-physical workbench · 07 spatial with the OT layer · 08 workbench overview · 09 AI review state · 10 human verification · 11 physical fault without cyber evidence · 12 overview at 820 px · 13 Cyber & OT at 700 px.
