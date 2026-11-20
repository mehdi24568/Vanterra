/**
 * "Ask Vanterra": questions about the open incident.
 *
 * Common questions are answered instantly by the deterministic engine (the plain-language
 * briefing), with no model. Free-form questions go to the configured AI model; the server
 * checks every answer (real evidence only, no certainty, probability or intent claims)
 * before it reaches this panel. Nothing here can change the incident.
 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Briefing } from '../cyber/briefing';
import type { Incident } from '../core/types';
import type { AskMessage } from '../runtime/AiService';
import { EvidenceId } from './cyber';
import { useRuntime, useUi } from './context';

type Quick = { q: string; answer: (b: Briefing) => { answer: string | null; items?: AskMessage['items'] } };

const QUICK: Quick[] = [
  { q: 'What is going on?', answer: (b) => ({ answer: b.inShort }) },
  { q: 'Should security be involved?', answer: (b) => ({ answer: `${b.cyberInvestigation.label}. ${b.cyberInvestigation.reason}` }) },
  { q: 'What do we know for certain?', answer: (b) => ({ answer: null, items: b.known }) },
  { q: 'What are we guessing?', answer: (b) => ({ answer: 'This is interpretation, not fact:', items: b.suggests }) },
  { q: 'What don’t we know?', answer: (b) => ({ answer: null, items: b.notKnown.map((text) => ({ text, evidence: [] })) }) },
  { q: 'What should we check next?', answer: (b) => ({ answer: null, items: b.toSettle.map((text) => ({ text, evidence: [] })) }) },
];

const BASIS: Record<NonNullable<AskMessage['basis']>, string> = {
  observed: 'based on observations',
  inferred: 'interpretation, not fact',
  not_in_evidence: 'not answerable from the evidence',
};

function Evidence({ ids }: { ids: string[] }) {
  if (ids.length === 0) return null;
  return (
    <span className="ask__evidence" aria-label="Evidence">
      {ids.map((id) => (
        <EvidenceId key={id} id={id} />
      ))}
    </span>
  );
}

function Message({ m }: { m: AskMessage }) {
  const seconds = (m.latencyMs / 1000).toFixed(m.latencyMs < 10_000 ? 1 : 0);
  const source =
    m.source === 'engine'
      ? 'Vanterra engine · instant · no AI'
      : m.state === 'pending'
        ? `AI · ${m.model ?? 'model'} · thinking…`
        : `AI · ${m.model ?? 'model'} · ${seconds} s${m.basis ? ` · ${BASIS[m.basis]}` : ''}`;
  return (
    <li className={`ask__msg ask__msg--${m.source} ask__msg--${m.state}`}>
      <p className="ask__q">{m.question}</p>
      <div className="ask__a">
        <span className="ask__source">{source}</span>
        {m.state === 'pending' ? <p className="ask__pending">The local model is reading the investigation. On a laptop CPU this can take a minute or more.</p> : null}
        {m.state === 'rejected' ? <p className="ask__rejected">The AI’s answer did not pass Vanterra’s checks, so it is not shown.</p> : null}
        {m.state === 'failed' ? <p className="ask__rejected">No answer: the AI could not respond.</p> : null}
        {m.answer ? <p className="ask__text">{m.answer}</p> : null}
        {m.items.length > 0 ? (
          <ul className="ask__items">
            {m.items.map((it) => (
              <li key={it.text}>
                {it.text} <Evidence ids={it.evidence} />
              </li>
            ))}
          </ul>
        ) : null}
        <Evidence ids={m.evidence} />
        {m.notes.length > 0 ? (
          <ul className="ask__notes">
            {m.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
        {m.rejectedDraft ? (
          <details className="ask__draft">
            <summary>Show the rejected draft (for review, not an answer)</summary>
            <p>{m.rejectedDraft}</p>
          </details>
        ) : null}
        {m.source === 'model' && m.state === 'answered' ? <p className="ask__caveat">AI answers are advisory. Check the evidence; only a person confirms a cause.</p> : null}
      </div>
    </li>
  );
}

export function AskPanel({ incident }: { incident: Incident }) {
  const runtime = useRuntime();
  const ai = useUi((s) => s.ai);
  useUi((s) => s.aiKey);
  useUi((s) => s.incidentsKey);
  const [draft, setDraft] = useState('');
  const history = runtime.askHistory(incident.id);
  const briefing = runtime.core.briefIncident(incident.id);
  const pending = history.some((m) => m.state === 'pending');

  const quick = (item: Quick) => {
    if (!briefing) return;
    const { answer, items } = item.answer(briefing);
    runtime.answerFromEngine(incident.id, item.q, answer, items ?? []);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || !ai.available || pending) return;
    runtime.askAi(incident.id, draft);
    setDraft('');
  };

  return (
    <div className="ask">
      <p className="ask__intro">
        Ask about this incident. The buttons are answered instantly by Vanterra’s engine. Your own questions go to the AI, which must cite real evidence; answers that claim certainty, odds or intent are rejected.
      </p>
      {briefing ? (
        <div className="ask__quick" role="group" aria-label="Quick questions">
          {QUICK.map((item) => (
            <button key={item.q} type="button" className="chip" onClick={() => quick(item)}>
              {item.q}
            </button>
          ))}
        </div>
      ) : null}

      <ol className="ask__log" aria-live="polite">
        {history.map((m) => (
          <Message key={m.id} m={m} />
        ))}
      </ol>

      <form className="ask__form" onSubmit={submit}>
        <label className="sr-only" htmlFor="ask-input">
          Your question
        </label>
        <input
          id="ask-input"
          className="ask__input"
          value={draft}
          maxLength={500}
          placeholder={ai.available ? 'Ask anything about this incident…' : 'AI is off. The quick questions above still work.'}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!ai.available}
        />
        <button type="submit" className="btn" disabled={!ai.available || !draft.trim() || pending}>
          {pending ? 'Thinking…' : 'Ask AI'}
        </button>
      </form>
      {!ai.available ? <p className="ask__off">{ai.reason ?? 'AI is not configured.'}</p> : null}
    </div>
  );
}
