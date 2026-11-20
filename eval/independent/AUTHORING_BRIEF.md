# Independent scenario authoring brief

You are writing **evaluation scenarios** for Vanterra, a cyber-physical incident investigation product, and the **ground truth** for each one. Your scenarios will be run against the product, and its conclusions compared with your ground truth.

## Independence rules

- Use only this brief and `eval/independent/catalog.json`. **Do not read** anything under `src/`, `server/`, `eval/results/`, any test file, `ARCHITECTURE.md` or `EVALUATION.md`. The point is that your scenarios and truth are not shaped by how the product works inside.
- Write the truth as an expert investigator would state it, given the evidence the scenario creates. Ask what is actually established, not what a rule might output.
- Make the scenarios hard. Include cases designed to tempt a system into the wrong answer, such as blaming cyber activity for a mechanical fault, missing a real cause, being overconfident on weak evidence, or merging unrelated problems. Do not make them unfair: the truth must be knowable from evidence a careful investigator would have.

## The world

A simulated process and packaging plant with an OT network. The catalog lists:
- every **asset** (with its **signals**, units and nominal readings) and physical **relations**;
- the **OT network**: zones, devices, the permitted zone-to-zone conduits, which controller **controls** which assets, writable **parameters**, role **identities** and approved **change records** (with windows and allowed value ranges);
- the **built-in scenarios** and what they do physically.

Only one parameter, `PLC-500:CT401_FAN_SPEED_SP` (cooling-tower fan speed, %), has a modelled physical effect: lowering it reduces airflow, so the fan draws less current, the tower basin warms and the trim chiller loads up. Writes to other parameters are recorded but change nothing physical.

The plant always runs normally for 120 s first; your `atS` times are relative to the end of that period. Normal background activity, which you do not need to add, includes operator polling of all controllers, historian traffic, and the shift operator's logon to HMI-01.

## Scenario format

Write one JSON file, `eval/independent/scenarios.json`:

```json
{
  "author": "independent author (no access to detection code)",
  "scenarios": [
    {
      "id": "IND-01",
      "category": "mechanical_no_cyber",
      "title": "short title",
      "narrative": "What really happens in the world, step by step (this is the hidden truth).",
      "durationS": 240,
      "actions": [
        { "atS": 0, "type": "builtin", "id": "pump-bearing" },
        { "atS": 20, "type": "sensorFault", "signalId": "TK-101.LEVEL", "bias": 0, "driftPerMin": -2.0 },
        { "atS": 30, "type": "security", "records": [
          { "kind": "auth", "host": "JMP-01", "identity": "vendor.remote", "result": "failure", "method": "remote", "srcHost": "ENT-01" },
          { "kind": "flow", "src": "EWS-01", "dst": "PLC-300", "protocol": "Engineering", "bytes": 50000 },
          { "kind": "logoff", "host": "EWS-01", "identity": "vendor.remote" },
          { "kind": "controllerAudit", "plcId": "PLC-300", "action": "program_upload", "identity": "vendor.remote", "srcHost": "EWS-01" }
        ] },
        { "atS": 60, "type": "engineeringWrite", "plcId": "PLC-500", "parameterId": "PLC-500:CT401_FAN_SPEED_SP", "oldValue": 100, "newValue": 40, "identity": "vendor.remote", "srcHost": "EWS-01" }
      ],
      "truth": {
        "physicalIncidents": [
          { "originAnyOf": ["P-101", "M-101"], "acceptableConclusions": ["physical_supported"], "forbiddenConclusions": ["control_change_supported", "authorized_change_supported"], "note": "why" }
        ],
        "maxPhysicalIncidents": 1,
        "cyber": { "expectNotableActivity": false, "expectedFlags": [], "forbiddenFlags": [] },
        "rationale": "Why this truth follows from the evidence."
      }
    }
  ]
}
```

### Action types

| `type` | Fields | Effect |
| --- | --- | --- |
| `builtin` | `id` (from `builtInScenarios`) | Starts a built-in scenario. Physical faults: `pump-bearing`, `cooling-fan`, `mcc-sag`; normal operations: `reduced-rate`, `full-rate`, `pump-changeover`, `clear-faults`. The three cyber scripts may also be used. |
| `sensorFault` | `signalId`, `bias` (signal units, optional), `driftPerMin` (signal units per minute, optional) | An **instrument** fault: the reading is wrong, the process is not affected. |
| `security` | `records`: list of `auth` / `flow` / `logoff` / `controllerAudit` | Security observations, as a sensor and the controllers' audit logs would record them. A `controllerAudit` with `"action": "parameter_write"` records a change (with `parameterId`, `oldValue`, `newValue`) but has **no** physical effect. Valid `action` values: `parameter_write`, `program_upload` (a read), `program_download`, `mode_change`. |
| `engineeringWrite` | `plcId`, `parameterId`, `oldValue`, `newValue`, `identity`, `srcHost` | A real setting change: it is recorded in the controller audit **and** applied to the process (only the fan speed setpoint has an effect). |

Use only device IDs, identities, signal IDs and parameter IDs that appear in the catalog. For `auth`, `method` is `local` or `remote`, `result` is `success` or `failure`, and `srcHost` is a device ID or `null`. For `flow`, `protocol` is free text (the catalog's conduits list protocols such as `RDP`, `HTTPS`, `EtherNet/IP`, `Engineering`, `OPC UA`).

### Truth vocabulary

For each physical incident you expect, give `originAnyOf` (the acceptable origin assets). The product reports one of these **conclusions** about what the cyber evidence means for that incident:

| Conclusion | Meaning |
| --- | --- |
| `physical_supported` | A physical explanation is supported; no cyber evidence relates to the affected equipment. |
| `control_change_supported` | An unapproved controller change explains the deviation (intent not established). |
| `authorized_change_supported` | An approved change explains the deviation. |
| `possible_relationship` | Cyber activity reached a controller of the affected equipment, but no change is recorded: a relationship is possible, the evidence is insufficient. |
| `correlated_not_causal` | Cyber events occurred near in time but have no established relationship to the affected equipment. |
| `multiple_plausible` | A configuration change and an independent equipment fault both fit. |
| `insufficient_evidence` | Not enough evidence for a meaningful conclusion. |

List every conclusion you would accept as defensible in `acceptableConclusions`, and the conclusions that would be **wrong** in `forbiddenConclusions`. Anything in neither list is treated as wrong.

`maxPhysicalIncidents` (and optionally `minPhysicalIncidents`) bound how many separate physical incidents should exist at the end. If nothing physical should be detected, set `"physicalIncidents": []` and `"maxPhysicalIncidents": 0`. If you cannot say for sure whether a weak effect is detectable, prefer bounds over exact counts.

`cyber.expectedFlags` / `forbiddenFlags` use this vocabulary of notable observations:

| Flag | Meaning |
| --- | --- |
| `failed_logons` | Repeated failed logons for one account on one host. |
| `out_of_window_session` | A logon to the engineering workstation not covered by an approved change record. |
| `segmentation_violation` | Traffic between zones with no permitted conduit for it. |
| `new_communication` | A permitted connection never seen during normal operation. |
| `unapproved_change` | A controller change not matching an approved change record. |
| `approved_change` | A controller change matching an approved change record (should *not* be treated as suspicious). |

`expectNotableActivity: false` means no warning-level cyber activity should be reported.

## What to write

Write **14 to 18 scenarios** covering every category below at least once, with variations:

1. `mechanical_no_cyber`: a mechanical or electrical failure with no cyber involvement.
2. `cyber_recon_no_impact`: reconnaissance or suspicious access with no physical effect.
3. `coupled_cyber_physical`: a setting change that causes the physical deviation.
4. `sensor_fault`: drift or misleading telemetry from one instrument.
5. `authorized_maintenance`: legitimate, approved work.
6. `suspicious_insufficient`: suspicious activity near a physical problem, without enough to attribute causality.
7. `conflicting_evidence`: physical and cyber explanations pull in different directions.
8. `sequential_independent`: a later, unrelated fault that must not be absorbed into an earlier investigation.

Keep each `durationS` between 150 and 600. When you are done, reply with the number of scenarios per category and any assumptions you made.
