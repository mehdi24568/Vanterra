/**
 * "Ask Vanterra" against a fake model: grounding of citations, rejection of overreach,
 * one repair, and failures surfaced. These are not model runs.
 */
import { describe, expect, it } from 'vitest';
import { boot } from '../runtime/testHarness';
import { answerQuestion, checkAnswer, compactContext } from './ask';
import { buildInvestigationContext } from './buildContext';
import { LlmError } from './provider';
import type { LlmProvider, LlmRequest } from './provider';

function flagshipContext() {
  const rig = boot();
  rig.adapter.trigger('cp-fan-setpoint');
  rig.run(180);
  const inc = rig.core.intelligence.incidents().find((i) => i.origin?.assetId === 'CT-401')!;
  return buildInvestigationContext(rig.core, inc);
}

/** A fake model that returns the given answers in order and records what it was asked. */
function fake(...answers: unknown[]): LlmProvider & { seen: LlmRequest<unknown>[] } {
  const seen: LlmRequest<unknown>[] = [];
  return {
    id: 'fake',
    model: 'fake-model',
    testDouble: true,
    seen,
    async complete(r) {
      seen.push(r as LlmRequest<unknown>);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return { output: next, usage: { inputTokens: 0, outputTokens: 0 }, model: 'fake-model', latencyMs: 1 };
    },
  };
}

describe('Ask Vanterra', () => {
  const ctx = flagshipContext();
  const change = ctx.cyber!.events.find((e) => e.ruleId === 'UNAPPROVED-CHANGE')!.id;

  it('accepts a cited, hedged answer and sends the question with a compact context', async () => {
    const p = fake({ answer: 'The fan speed setting was lowered before the readings changed, which fits the slower fan.', evidence: [change, 'CT-401'], basis: 'inferred' });
    const r = await answerQuestion(ctx, 'What changed?', p, { timeoutMs: 1000 });
    expect(r.status).toBe('answered');
    expect(r.evidence).toEqual([change, 'CT-401']);
    expect(r.calls).toBe(1);
    expect(p.seen[0].user).toContain('Question: What changed?');
    expect(p.seen[0].user).not.toContain('"signals"');
    expect(JSON.stringify(compactContext(ctx)).length).toBeLessThan(JSON.stringify(ctx).length);
  });

  it('removes citations to evidence that does not exist, and says so', () => {
    const { cleaned, problems, notes } = checkAnswer({ answer: 'The fan setting changed.', evidence: [change, 'CEV-9999'], basis: 'observed' }, ctx);
    expect(cleaned!.evidence).toEqual([change]);
    expect(problems).toHaveLength(0);
    expect(notes.join(' ')).toMatch(/CEV-9999/);
  });

  // Regressions from the first real run (qwen3:1.7b): real IDs decorated with descriptions
  // were discarded, and a recorded setpoint "35%" was mistaken for a probability.
  it('accepts real IDs that the model decorated, and recorded percentages', () => {
    const anomaly = ctx.anomalies[0].id;
    const { cleaned, problems } = checkAnswer(
      { answer: 'The fan speed setpoint was lowered from 100 to 35%, and the fan current dropped.', evidence: [`${anomaly} (CT-401.FAN_CURRENT low, baseline 38.0 A)`, `${change} (unapproved setpoint 100 → 35%)`, 'ANM-9999 (invented)'], basis: 'observed' },
      ctx,
    );
    expect(problems).toEqual([]);
    expect(cleaned!.evidence).toEqual([anomaly, change]);
    expect(checkAnswer({ answer: 'There is an 80% chance the change caused it.', evidence: [change], basis: 'inferred' }, ctx).problems.join(' ')).toMatch(/probability/);
  });

  it('accepts hedged wording: negations and open questions are not overclaiming', () => {
    for (const answer of [
      'The cause is not confirmed; a person has to check the fan.',
      'It cannot be proven from this data who made the change.',
      'Whether an attacker was involved is not known.',
      'There is no evidence of sabotage in the records.',
    ]) {
      expect(checkAnswer({ answer, evidence: [change], basis: 'inferred' }, ctx).problems, answer).toEqual([]);
    }
  });

  it('rejects certainty, probabilities, intent and uncited claims, after one repair attempt', async () => {
    for (const bad of [
      { answer: 'The root cause is confirmed: the setpoint change.', evidence: [change], basis: 'inferred' },
      { answer: 'There is a 90% chance the change caused it.', evidence: [change], basis: 'inferred' },
      { answer: 'An attacker changed the fan speed.', evidence: [change], basis: 'inferred' },
      { answer: 'The fan slowed down.', evidence: ['ANM-9999'], basis: 'observed' },
    ]) {
      const p = fake(bad, bad);
      const r = await answerQuestion(ctx, 'Why did this happen?', p, { timeoutMs: 1000 });
      expect(r.status, bad.answer).toBe('rejected');
      expect(r.answer).toBeNull();
      expect(r.rejectedDraft).toBe(bad.answer); // kept for expert review, not shown as an answer
      expect(r.calls).toBe(2);
      expect(p.seen[1].user).toMatch(/not accepted/);
    }
  });

  it('accepts a repaired answer, and an honest "not in the evidence" without citations', async () => {
    const repaired = await answerQuestion(ctx, 'Why?', fake({ answer: 'An attacker did it.', evidence: [change], basis: 'inferred' }, { answer: 'An unapproved change came first and fits the readings; who made it and why is not known.', evidence: [change], basis: 'inferred' }), { timeoutMs: 1000 });
    expect(repaired.status).toBe('answered');
    expect(repaired.calls).toBe(2);
    const honest = await answerQuestion(ctx, 'What is the operator’s name?', fake({ answer: 'The investigation data does not say.', evidence: [], basis: 'not_in_evidence' }), { timeoutMs: 1000 });
    expect(honest.status).toBe('answered');
  });

  it('reports model failures and malformed output without showing anything from the model', async () => {
    const down = await answerQuestion(ctx, 'What changed?', fake(new LlmError('network', 'Ollama is not reachable')), { timeoutMs: 1000 });
    expect(down.status).toBe('failed');
    expect(down.notes[0]).toMatch(/network/);
    const garbage = await answerQuestion(ctx, 'What changed?', fake('not json', { nope: true }), { timeoutMs: 1000 });
    expect(garbage.status).toBe('rejected');
    expect(garbage.answer).toBeNull();
  });
});
