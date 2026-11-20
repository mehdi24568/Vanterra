/**
 * "Ask Vanterra": one question about one investigation, answered by the configured model
 * and checked before anyone sees it.
 *
 * The model receives a compact version of the investigation context (detections,
 * hypotheses, impact, checks and the cyber-physical assessment), never tools or the
 * ability to change anything. Its answer must cite evidence IDs from that context. Vanterra
 * then removes citations that do not exist, and rejects answers that claim certainty,
 * probabilities, intent or an attacker, or that make claims without citing anything.
 * A rejected answer gets one repair attempt; if that also fails, nothing from the model
 * is shown.
 */
import { z } from 'zod';
import { catalogueOf } from './context';
import type { InvestigationContext } from './context';
import { LlmError } from './provider';
import type { LlmProvider } from './provider';

export const ASK_MAX_QUESTION = 500;

export const AskAnswerSchema = z.strictObject({
  answer: z.string().min(1).max(1500),
  /** Evidence IDs from the context that the answer rests on. */
  evidence: z.array(z.string()).max(15),
  /** observed: what was measured or recorded; inferred: interpretation; not_in_evidence: the context cannot answer it. */
  basis: z.enum(['observed', 'inferred', 'not_in_evidence']),
});
export type AskAnswer = z.infer<typeof AskAnswerSchema>;

export interface AskResult {
  status: 'answered' | 'rejected' | 'failed';
  answer: string | null;
  evidence: string[];
  basis: AskAnswer['basis'] | null;
  /** Why an answer was trimmed or rejected, in plain words. */
  notes: string[];
  /** The last draft that failed the checks, kept for expert review only; never presented as an answer. */
  rejectedDraft: string | null;
  model: string;
  calls: number;
  latencyMs: number;
}

export const ASK_SYSTEM = `You answer one question about one industrial incident investigation for Vanterra.
Rules:
- Use only the investigation data in the user message. If it does not contain the answer, say so and set basis to "not_in_evidence".
- Cite the evidence IDs you rely on (for example ANM-0003, CEV-0005, asset IDs, hypothesis keys) in "evidence", exactly as written in the data.
- Separate what was observed (measured or recorded) from interpretation. Set basis to "observed" or "inferred".
- Never state that a cause is confirmed, certain or proven. Never give probabilities or percentages. Never claim intent, an attacker or a hacker: the data cannot establish who acted or why. Only a person can confirm a cause.
- Write for a non-specialist: plain words, short sentences, at most 120 words. Explain any technical term you use.
Reply with JSON only: {"answer": string, "evidence": string[], "basis": "observed" | "inferred" | "not_in_evidence"}.`;

const CERTAINTY = /\b(confirmed|definitely|certainly|undoubtedly|proven|proves|without (a )?doubt|root cause is)\b/i;
/** Odds, not measurements: "80% chance", "probability", "likelihood of". A recorded "35%" setpoint is fine. */
const PROBABILITY = /\b\d{1,3}(\.\d+)?\s?%\s*(chance|probabilit|likel|confiden|sure|certain)|\b(probability|likelihood|chance of|odds)\b/i;
const INTENT = /\b(attacker|attackers|hacker|hackers|malicious actor|threat actor|sabotage[ds]?|deliberately|intentionally)\b/i;

/** Words just before a match that turn it into a hedge: "not confirmed", "whether an attacker…". */
const HEDGE = /\b(not|no|never|cannot|can't|isn't|wasn't|hasn't|haven't|doesn't|don't|unless|whether|without)\b[^.]{0,30}$/i;

/** True when the pattern occurs as an assertion, not inside a negation or open question. */
function asserts(pattern: RegExp, text: string): boolean {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  for (const m of text.matchAll(global)) {
    if (!HEDGE.test(text.slice(Math.max(0, (m.index ?? 0) - 40), m.index))) return true;
  }
  return false;
}

function pick<T extends object>(o: T, keys: string[]): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([k]) => keys.includes(k))) as Partial<T>;
}

/**
 * What a question can be answered from, about a third of the full context: identities and
 * key values, not detector internals. Ordered from stable to changing, so a local model's
 * prompt cache can reuse most of it for follow-up questions.
 */
export function compactContext(ctx: InvestigationContext) {
  return {
    cyber: ctx.cyber
      ? {
          standing: ctx.cyber.standing,
          headline: ctx.cyber.headline,
          links: ctx.cyber.links,
          explanations: ctx.cyber.explanations,
          unknowns: ctx.cyber.unknowns,
          events: ctx.cyber.events.map((e) => pick(e, ['id', 'ruleId', 'title', 'severity', 'identity', 'source', 'destination', 'parameterId', 'changeRecordId'])),
        }
      : null,
    hypotheses: ctx.hypotheses.map((h) => pick(h, ['key', 'templateId', 'title', 'assetId', 'score', 'band', 'scoreBand', 'disposition', 'summary', 'mechanism'])),
    origin: ctx.origin,
    impact: ctx.impact,
    deterministicChecks: ctx.deterministicChecks,
    anomalies: ctx.anomalies.map((a) => pick(a, ['id', 'assetId', 'signalId', 'direction', 'status', 'onsetS', 'unit', 'latest', 'baselineMean'])),
    incident: ctx.incident,
  };
}

/** "ANM-0001 (fan current low)" → "ANM-0001": small models often decorate the IDs they cite. */
function citedId(raw: string): string {
  return raw.trim().split(/[\s(,;]/)[0];
}

/** Checks one answer; returns the cleaned answer and the problems found. */
export function checkAnswer(raw: unknown, ctx: InvestigationContext): { cleaned: AskAnswer | null; problems: string[]; notes: string[] } {
  const parsed = AskAnswerSchema.safeParse(raw);
  if (!parsed.success) return { cleaned: null, problems: ['The answer was not in the required format.'], notes: [] };
  const a = parsed.data;
  const catalogue = catalogueOf(ctx);
  const ids = a.evidence.map(citedId);
  const known = ids.filter((id) => catalogue.all.has(id));
  const unknown = ids.filter((id) => !catalogue.all.has(id));
  const problems: string[] = [];
  const notes: string[] = [];
  if (unknown.length) notes.push(`Removed ${unknown.length} citation${unknown.length === 1 ? '' : 's'} to evidence that does not exist: ${unknown.join(', ')}.`);
  if (asserts(CERTAINTY, a.answer)) problems.push('It stated a cause as confirmed or certain; only a person can confirm a cause.');
  if (asserts(PROBABILITY, a.answer)) problems.push('It gave a probability; the evidence does not support numeric likelihoods.');
  if (asserts(INTENT, a.answer)) problems.push('It claimed intent or an attacker; the evidence cannot establish who acted or why.');
  if (a.basis !== 'not_in_evidence' && known.length === 0) problems.push('It made claims without citing any evidence that exists in this investigation.');
  return { cleaned: { ...a, evidence: [...new Set(known)] }, problems, notes };
}

export async function answerQuestion(
  ctx: InvestigationContext,
  question: string,
  provider: LlmProvider,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<AskResult> {
  const started = Date.now();
  const data = JSON.stringify(compactContext(ctx));
  let feedback = '';
  let calls = 0;
  let notes: string[];
  for (let attempt = 1; attempt <= 2; attempt++) {
    calls += 1;
    let raw: unknown;
    try {
      const res = await provider.complete({
        name: 'ask',
        system: ASK_SYSTEM,
        user: `Investigation data:\n${data}\n\nQuestion: ${question}${feedback}`,
        schema: AskAnswerSchema,
        maxOutputTokens: 700,
        timeoutMs: opts.timeoutMs,
        deadlineAt: started + opts.timeoutMs * 2,
        signal: opts.signal,
      });
      raw = res.output;
    } catch (err) {
      const message = err instanceof LlmError ? `${err.kind}: ${err.message}` : 'The model could not be reached.';
      return { status: 'failed', answer: null, evidence: [], basis: null, notes: [message], rejectedDraft: null, model: provider.model, calls, latencyMs: Date.now() - started };
    }
    const { cleaned, problems, notes: n } = checkAnswer(raw, ctx);
    notes = n;
    if (cleaned && problems.length === 0) {
      return { status: 'answered', answer: cleaned.answer, evidence: cleaned.evidence, basis: cleaned.basis, notes, rejectedDraft: null, model: provider.model, calls, latencyMs: Date.now() - started };
    }
    feedback = `\n\nYour previous answer was not accepted: ${problems.join(' ')} Answer again following the rules.`;
    if (attempt === 2) {
      const draft = cleaned ? cleaned.answer : typeof raw === 'string' ? raw.slice(0, 1500) : null;
      return { status: 'rejected', answer: null, evidence: [], basis: null, notes: [...notes, ...problems], rejectedDraft: draft, model: provider.model, calls, latencyMs: Date.now() - started };
    }
  }
  /* unreachable */
  return { status: 'failed', answer: null, evidence: [], basis: null, notes: [], rejectedDraft: null, model: provider.model, calls, latencyMs: Date.now() - started };
}
