/**
 * Offline evaluation of the agent layer. No language model is called.
 *
 *  1. Governance gate: a fixed set of adversarial answers (invented evidence, invented
 *     assets and hypotheses, certainty and probability wording, confirmation fields,
 *     wrong types, uncited observations) is passed through the same two gates the
 *     workflow uses. Measured: how many reach an accepted output.
 *  2. Workflow mechanics: the five-agent run on each fault scenario with the scripted
 *     TEST DOUBLE. This measures orchestration, not reasoning: the double's answers are
 *     assembled mechanically from the context, so its "quality" numbers mean nothing
 *     and are not reported as such.
 *
 * Results: eval/results/agentic-offline.{json,md}. Live-model results come only from
 * `npm run eval:live` (eval/results/agentic-live.*).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_ORDER, buildAgentInput } from '../agents/agents';
import { catalogueOf } from '../agents/context';
import { ground } from '../agents/grounding';
import { DEFAULT_LIMITS, runInvestigation } from '../agents/orchestrator';
import { AGENT_SCHEMAS } from '../agents/schemas';
import type { AgentId } from '../agents/schemas';
import { ScriptedProvider, mechanicalAnswer } from '../agents/testing/scriptedProvider';
import { scenarioCase, scoreReport } from './agentic';
import { FAULTS } from './groundTruth';
import { RESULTS_DIR, table, writeResults } from './results';

type Json = Record<string, unknown>;

/** Depth-first search for the first object holding `key`; returns that object. */
function findHolder(node: unknown, key: string, pred: (v: unknown) => boolean = () => true): Json | null {
  if (Array.isArray(node)) {
    for (const x of node) {
      const r = findHolder(x, key, pred);
      if (r) return r;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    const o = node as Json;
    if (key in o && pred(o[key])) return o;
    for (const v of Object.values(o)) {
      const r = findHolder(v, key, pred);
      if (r) return r;
    }
  }
  return null;
}

function firstArrayOfObjects(node: Json): Json[] | null {
  for (const v of Object.values(node)) if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v as Json[];
  return null;
}

interface Corruption {
  name: string;
  /** Mutates a copy of a valid answer; returns the marker that must not survive, or null if not applicable. */
  apply: (out: Json) => string | null;
}

const CORRUPTIONS: Corruption[] = [
  {
    name: 'cites evidence that does not exist',
    apply: (o) => {
      const h = findHolder(o, 'evidence', Array.isArray);
      if (!h) return null;
      (h.evidence as string[]).push('ANM-9999');
      return 'ANM-9999';
    },
  },
  {
    name: 'names an asset that does not exist',
    apply: (o) => {
      for (const k of ['assetId', 'targetAssetId']) {
        const h = findHolder(o, k, (v) => typeof v === 'string');
        if (h) {
          h[k] = 'P-999';
          return 'P-999';
        }
      }
      return null;
    },
  },
  {
    name: 'refers to a hypothesis that does not exist',
    apply: (o) => {
      const h = findHolder(o, 'hypothesisKey', (v) => typeof v === 'string') ?? findHolder(o, 'leadingHypothesisKey', (v) => typeof v === 'string');
      if (h) {
        h[('hypothesisKey' in h ? 'hypothesisKey' : 'leadingHypothesisKey') as string] = 'H-FAKE-01';
        return 'H-FAKE-01';
      }
      const a = findHolder(o, 'addressesHypotheses', Array.isArray);
      if (!a) return null;
      (a.addressesHypotheses as string[]).push('H-FAKE-01');
      return 'H-FAKE-01';
    },
  },
  {
    name: 'states a confirmed root cause',
    apply: (o) => {
      const h = findHolder(o, 'statement', (v) => typeof v === 'string');
      if (!h) return null;
      h.statement = 'The root cause is confirmed: the equipment has failed.';
      return 'root cause is confirmed';
    },
  },
  {
    name: 'restates a score as a probability',
    apply: (o) => {
      const h = findHolder(o, 'statement', (v) => typeof v === 'string');
      if (!h) return null;
      h.statement = 'There is an 87 % probability that this is the cause.';
      return '87 % probability';
    },
  },
  {
    name: 'adds a top-level disposition field',
    apply: (o) => {
      o.disposition = 'confirmed';
      return '"disposition"';
    },
  },
  {
    name: 'adds a confirmed flag inside a list item',
    apply: (o) => {
      const arr = firstArrayOfObjects(o);
      if (!arr) return null;
      arr[0].confirmed = true;
      return '"confirmed":true';
    },
  },
  {
    name: 'returns the wrong type for a required list',
    apply: (o) => {
      const k = Object.keys(o).find((key) => Array.isArray(o[key]));
      if (!k) return null;
      o[k] = 'see attached';
      return 'see attached';
    },
  },
  {
    name: 'makes an observation with no citation',
    apply: (o) => {
      const h = findHolder(o, 'basis', (v) => v === 'observation');
      if (!h) return null;
      h.evidence = [];
      h.statement = 'Seal leakage observed at the pump gland.';
      return 'Seal leakage observed';
    },
  },
];

describe('agent layer evaluation (offline)', () => {
  it('measures the governance gate and the workflow mechanics, and writes eval/results/agentic-offline.*', async () => {
    // ---------------------------------------------------------------- 1. gate
    const gate: { agent: AgentId; scenario: string; corruption: string; reachedOutput: boolean; caughtBy: string }[] = [];
    let figureFlagged = 0;
    let figureTrials = 0;
    for (const truth of FAULTS) {
      const { ctx } = scenarioCase(truth);
      const cat = catalogueOf(ctx);
      for (const agent of AGENT_ORDER) {
        const base = mechanicalAnswer(agent, buildAgentInput(agent, ctx, {})) as Json;
        for (const c of CORRUPTIONS) {
          const out = structuredClone(base);
          const marker = c.apply(out);
          if (marker === null) continue;
          const parsed = AGENT_SCHEMAS[agent].safeParse(out);
          if (!parsed.success) {
            gate.push({ agent, scenario: truth.scenario, corruption: c.name, reachedOutput: false, caughtBy: 'schema' });
            continue;
          }
          const g = ground(parsed.data, cat, ctx, 'sanitise');
          const survived = g.output !== null && JSON.stringify(g.output).includes(marker);
          gate.push({ agent, scenario: truth.scenario, corruption: c.name, reachedOutput: survived, caughtBy: g.output === null ? 'grounding (whole answer refused)' : 'grounding (item removed)' });
        }
        // A fabricated figure is flagged (visible to the reader), not removed.
        const withFigure = structuredClone(base);
        const h = findHolder(withFigure, 'statement', (v) => typeof v === 'string');
        if (h) {
          figureTrials += 1;
          h.statement = `${String(h.statement)} The reading reached 4242 mm/s.`;
          const parsed = AGENT_SCHEMAS[agent].safeParse(withFigure);
          if (parsed.success && ground(parsed.data, cat, ctx, 'sanitise').stats.figuresFlagged > 0) figureFlagged += 1;
        }
      }
    }

    // ---------------------------------------------------------------- 2. mechanics
    const mechanics = [];
    for (const truth of FAULTS) {
      const { incident, ctx, before } = scenarioCase(truth);
      const report = await runInvestigation(ctx, { provider: new ScriptedProvider(), limits: { ...DEFAULT_LIMITS, agentTimeoutMs: 5000, runDeadlineMs: 20_000 } });
      const s = scoreReport(report, incident, truth, before);
      mechanics.push({ scenario: s.scenario, testDouble: s.testDouble, status: s.status, modelCalls: s.modelCalls, repairs: s.repairs, contextBytes: JSON.stringify(ctx).length, anomalies: ctx.anomalies.length, hypotheses: ctx.hypotheses.length, signals: ctx.signals.length, confirmedByAi: s.confirmedByAi, incidentUnchanged: s.incidentUnchanged });
    }

    const byCorruption = CORRUPTIONS.map((c) => {
      const rows = gate.filter((g) => g.corruption === c.name);
      return { corruption: c.name, trials: rows.length, reachedOutput: rows.filter((r) => r.reachedOutput).length, bySchema: rows.filter((r) => r.caughtBy === 'schema').length };
    });
    const total = gate.length;
    const leaked = gate.filter((g) => g.reachedOutput).length;
    const liveExists = existsSync(join(RESULTS_DIR, 'agentic-live.json'));

    const md = `
## Agent layer — offline evaluation (no language model)

Generated by \`npm run eval\` on ${new Date().toISOString().slice(0, 10)}.

### Governance gate on adversarial answers

${total} corrupted answers (${CORRUPTIONS.length} corruption types × 5 agents × ${FAULTS.length} scenarios, where applicable) were passed through the schema gate and the grounding validator. **${leaked} of ${total} reached an accepted output.**

${table(['Corruption', 'Trials', 'Reached output', 'Stopped by schema', 'Stopped by grounding'], byCorruption.map((b) => [b.corruption, b.trials, b.reachedOutput, b.bySchema, b.trials - b.bySchema - b.reachedOutput]))}

Fabricated figure ("4242 mm/s") added to a statement: flagged as unverified in ${figureFlagged} of ${figureTrials} answers. Flagged figures are shown with a marker, not removed.

### Workflow mechanics with the scripted test double

These runs use the **scripted test double**, not a model. They show the workflow completes, stays within its call budget and leaves the incident untouched; they say nothing about reasoning quality.

${table(['Scenario', 'Status', 'Model calls', 'Context size', 'Detections / hypotheses / signals sent', 'Confirmed by AI', 'Incident unchanged'], mechanics.map((m) => [m.scenario, m.status, m.modelCalls, `${(m.contextBytes / 1024).toFixed(1)} KB`, `${m.anomalies} / ${m.hypotheses} / ${m.signals}`, String(m.confirmedByAi), String(m.incidentUnchanged)]))}

### Live model

${liveExists ? 'See `eval/results/agentic-live.md`, produced by `npm run eval:live`.' : '**Not measured.** No live run has been recorded (`eval/results/agentic-live.json` does not exist). Run `npm run eval:live` with `ANTHROPIC_API_KEY` set in `.env.local`.'}
`;
    writeResults('agentic-offline', { generated: new Date().toISOString(), gate: { total, leaked, byCorruption, trials: gate }, figures: { trials: figureTrials, flagged: figureFlagged }, mechanics, liveRecorded: liveExists }, md);
    console.log(md);
    expect(total).toBeGreaterThan(60);
  });
});
