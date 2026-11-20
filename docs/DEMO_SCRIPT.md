# Demo: script, shot list and recording

**A video exists:** [`docs/demo/vanterra-demo.webm`](demo/vanterra-demo.webm), 82 s, 1280 × 800, VP9, 7.7 MB, with burned-in captions and no audio. It is a real capture: `scripts/record-demo.mjs` drives the running app in Edge, streams genuine frames through the DevTools screencast, and encodes them in the same browser. Regenerate it with:

```
npm run dev
```

```
npm run record-demo
```

The run is repeatable: it uses the default seed (20260112), and the scenario launcher resets the simulation before starting the flagship scenario at ×4 speed.

## 90-second script and shot list

| # | Time | Shot (what is on screen) | Caption / narration |
| --- | --- | --- | --- |
| 0 | 0:00–0:03 | Title card | "VANTERRA. Cyber-physical intelligence, simulated environment." |
| 1 | 0:03–0:09 | **Overview**, all normal: plant condition, incidents, cyber events, facility areas, scenario launcher | "Vanterra: a simulated plant and its OT network, investigated together." |
| 2 | 0:09–0:13 | *Run scenario* on **C · Cyber-physical** | "A vendor account reaches the engineering workstation outside any approved change window…" |
| 3 | 0:13–0:18 | **Cyber & OT**: zone map, the case appears | "…and lowers the cooling-tower fan speed on controller PLC-500 from 100 % to 35 %." |
| 4 | 0:18–0:26 | The **unapproved change** event: evidence fields, rationale, limitations, ATT&CK context | "No approved change record matches: different account, value outside the approved range." |
| 5 | 0:26–0:33 | **Overview**: a critical cyber-physical incident and the case in *Requires attention* | "Seconds later the process deviates. A critical incident opens at the cooling tower, from sensor data alone." |
| 6 | 0:33–0:44 | **Workbench, Cyber-physical tab**, with the OT layer in 3D | "The link is declared, not guessed: PLC-500 controls CT-401. The change came first, and the expected signals moved." |
| 7 | 0:44–0:53 | The explanations, scrolled | "Competing explanations are tested. An equipment fault is not supported: no trip, no high vibration." |
| 8 | 0:53–1:01 | *What is not known* and *next steps* | "What remains unknown is stated: who used the account, and whether the change was malicious." |
| 9 | 1:01–1:07 | Workbench **Overview**: rule-based, AI-assisted, human and cyber-physical verdicts | "Rule-based, AI-assisted, human and cyber-physical verdicts side by side." |
| 10 | 1:07–1:12 | **Hypotheses** → *Mark confirmed* | "Vanterra recommends. Only a person confirms." |
| 11 | 1:12–1:19 | Workbench **Overview** with the human verdict | "Conclusion: a control-system change is supported. Intent is not established." |
| 12 | 1:19–1:22 | End card | "Investigate the physical and the digital together." |

## Recording a narrated version yourself (optional)

1. `npm run dev`, then open http://localhost:5173 at 1440 × 900 in a private window.
2. Start a screen recorder: Win + Alt + R (Xbox Game Bar), or OBS.
3. Follow the shot list. On the Overview, *Run scenario* on **C · Cyber-physical**, wait for the incident, then open it from *Requires attention*.
4. Read the captions as narration. Without an API key or local model, say that AI review is not configured; never present the scripted test double as a model.

## Stills for the README and portfolio

All are real captures (`npm run capture`), 1440 × 900 unless noted, in `docs/screenshots/`:

| File | Use |
| --- | --- |
| `06-workbench-cyber-physical.png` | Hero image: the cyber-physical assessment |
| `03-overview-cyber-physical.png` | Overview during the flagship scenario |
| `05-cyber-event.png` | Evidence-level detail of the unapproved change |
| `04-cyber-case.png` | Zone map and cyber case |
| `07-spatial-ot-layer.png` | 3D twin with the OT layer |
| `11-physical-no-cyber.png` | Contrast: a physical fault, no cyber attribution |
| `08-workbench-overview.png`, `10-human-verification.png` | Verdicts side by side; human confirmation |
| `02-overview-normal.png`, `01-welcome.png` | Normal state; first-run welcome |
| `12-narrow-overview.png` (820 px), `13-narrow-cyber.png` (700 px) | Responsiveness |
| `../architecture.svg` | Architecture diagram |
