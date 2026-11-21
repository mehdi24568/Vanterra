/**
 * Finance: earnings movement investigation ("Is this result real?").
 *
 * Applies Vanterra's investigation discipline to a company's monthly results: declared
 * structure (the driver tree and which line each entry posts to), unusual drivers against
 * their own history, competing explanations with explicit criteria, evidence IDs, a
 * normalised result, and a plain-language answer. Fictional company, synthetic data.
 */
import { useMemo, useState } from 'react';
import { assessFinance, briefFinance } from '../finance/assess';
import type { BridgeStep, FinAssessment, FinStanding } from '../finance/assess';
import { buildDataset, LINE_LABEL, SCENARIOS } from '../finance/data';
import type { PnlLine } from '../finance/data';

const LINES: PnlLine[] = ['ebitda', 'gross_profit', 'revenue'];

const STANDING_LABEL: Record<FinStanding, string> = {
  operating_supported: 'Operating performance supported',
  accounting_entry_supported: 'Accounting entry supported',
  approved_adjustment_supported: 'Approved adjustment supported',
  masked_by_entry: 'Masked by an accounting entry',
  multiple_plausible: 'Multiple explanations plausible',
  no_material_movement: 'No material movement',
  insufficient_evidence: 'Insufficient evidence',
};

const eur = (x: number) => `${x < 0 ? '−' : ''}€${(Math.abs(x) / 1_000_000).toFixed(2)}m`;
const k = (x: number) => `${x < 0 ? '−' : x > 0 ? '+' : ''}€${Math.round(Math.abs(x) / 1000)}k`;

/** Budget → each driver and entry → reported, as a horizontal waterfall. */
function Bridge({ a }: { a: FinAssessment }) {
  const shown = a.bridge.filter((s) => Math.abs(s.amount) >= 1000 || s.kind !== 'operating');
  const small = a.bridge.filter((s) => !shown.includes(s)).reduce((sum, s) => sum + s.amount, 0);
  const steps: BridgeStep[] = Math.abs(small) >= 1 ? [...shown, { key: 'other', label: 'Other drivers (small)', amount: small, kind: 'operating', evidence: [] }] : shown;
  const rows: { label: string; from: number; to: number; tone: string; total?: boolean }[] = [{ label: 'Budget', from: 0, to: a.budget, tone: 'total', total: true }];
  let run = a.budget;
  for (const s of steps) {
    rows.push({ label: s.label, from: run, to: run + s.amount, tone: s.kind === 'unapproved_entry' ? 'flag' : s.kind === 'approved_entry' ? 'approved' : s.amount >= 0 ? 'up' : 'down' });
    run += s.amount;
  }
  rows.push({ label: 'Reported', from: 0, to: a.reported, tone: 'total', total: true });
  const values = rows.flatMap((r) => [r.from, r.to]).concat(a.normalised);
  const lo = Math.min(...values.filter((v, i) => i % 2 === 1 || v !== 0)) * 0.96;
  const hi = Math.max(...values) * 1.02;
  const W = 640;
  const L = 230;
  const rowH = 26;
  const x = (v: number) => L + ((v - lo) / (hi - lo)) * (W - L - 70);
  const H = rows.length * rowH + 30;
  return (
    <svg className="fin-bridge" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Bridge from budget ${eur(a.budget)} to reported ${eur(a.reported)}; normalised ${eur(a.normalised)}`}>
      {rows.map((r, i) => {
        const y = 10 + i * rowH;
        const x0 = r.total ? x(lo) : x(Math.min(r.from, r.to));
        const x1 = r.total ? x(r.to) : x(Math.max(r.from, r.to));
        return (
          <g key={`${r.label}-${i}`}>
            <text x={L - 8} y={y + 15} textAnchor="end" className="fin-bridge__label">
              {r.label}
            </text>
            <rect x={x0} y={y + 3} width={Math.max(2, x1 - x0)} height={rowH - 8} className={`fin-bridge__bar fin-bridge__bar--${r.tone}`} />
            <text x={x1 + 6} y={y + 15} className="fin-bridge__value">
              {r.total ? eur(r.to) : k(r.to - r.from)}
            </text>
          </g>
        );
      })}
      <line x1={x(a.normalised)} x2={x(a.normalised)} y1={4} y2={H - 18} className="fin-bridge__normalised" />
      <text x={x(a.normalised)} y={H - 4} textAnchor="middle" className="fin-bridge__note">
        normalised {eur(a.normalised)}
      </text>
    </svg>
  );
}

function Ids({ ids }: { ids: string[] }) {
  if (!ids.length) return null;
  return (
    <span className="fin-ids">
      {ids.map((id) => (
        <span key={id} className="evid evid--other">
          {id}
        </span>
      ))}
    </span>
  );
}

export function FinancePage() {
  const [scenarioId, setScenarioId] = useState('masked-decline');
  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!;
  const [line, setLine] = useState<PnlLine>(scenario.line);
  const ds = useMemo(() => buildDataset(scenarioId), [scenarioId]);
  const a = useMemo(() => assessFinance(ds, line), [ds, line]);
  const brief = briefFinance(a);

  return (
    <main className="page page--finance" aria-label="Finance">
      <header className="page__head">
        <div>
          <h1 className="page__title">Finance · Is this result real?</h1>
          <p className="page__sub">
            {ds.company} · month {ds.monthLabel(ds.focusMonth)} close · synthetic data with a known cause in each scenario. The same investigation discipline as the plant: declared structure, explicit criteria, evidence IDs, and a person decides.
          </p>
        </div>
      </header>

      <section className="fin-controls" aria-label="Scenario and line">
        <div className="fin-chips" role="group" aria-label="Scenario">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`chip${s.id === scenarioId ? ' is-on' : ''}`}
              aria-pressed={s.id === scenarioId}
              onClick={() => {
                setScenarioId(s.id);
                setLine(s.line);
              }}
            >
              {s.title}
            </button>
          ))}
        </div>
        <div className="fin-chips" role="group" aria-label="Line investigated">
          {LINES.map((l) => (
            <button key={l} type="button" className={`chip${l === line ? ' is-on' : ''}`} aria-pressed={l === line} onClick={() => setLine(l)}>
              {LINE_LABEL[l]}
            </button>
          ))}
        </div>
      </section>

      <section className="fin-kpis" aria-label="Key figures">
        <div className="fin-kpi">
          <span className="fin-kpi__label">Budget</span>
          <span className="fin-kpi__value">{eur(a.budget)}</span>
        </div>
        <div className="fin-kpi">
          <span className="fin-kpi__label">Reported</span>
          <span className="fin-kpi__value">{eur(a.reported)}</span>
          <span className="fin-kpi__delta">{k(a.reported - a.budget)} vs budget</span>
        </div>
        <div className={`fin-kpi${Math.abs(a.normalised - a.reported) >= 1000 ? ' fin-kpi--flag' : ''}`}>
          <span className="fin-kpi__label">Normalised (without unapproved manual entries)</span>
          <span className="fin-kpi__value">{eur(a.normalised)}</span>
          <span className="fin-kpi__delta">{k(a.normalised - a.budget)} vs budget</span>
        </div>
        <div className="fin-kpi">
          <span className="fin-kpi__label">Materiality (1.5% of budget revenue)</span>
          <span className="fin-kpi__value">{k(a.materiality).replace('+', '')}</span>
        </div>
      </section>

      <section className={`fin-verdict fin-verdict--${a.standing}`} aria-label="Answer">
        <span className="fin-verdict__label">{STANDING_LABEL[a.standing]}</span>
        <p className="fin-verdict__answer">{brief.answer}</p>
        <p className="fin-verdict__detail">{brief.detail}</p>
        <span className="fin-verdict__meta">Deterministic assessment · {LINE_LABEL[a.line]} · no model involved</span>
      </section>

      <div className="fin-grid">
        <section className="fin-card" aria-label="Bridge">
          <h2 className="fin-card__title">From budget to reported</h2>
          <Bridge a={a} />
          <p className="fin-card__note">Each operating step is exact (price × volume, volume × margin, unit cost, freight, operating expenses). Unapproved manual entries are shown in orange.</p>
        </section>

        <section className="fin-card" aria-label="Explanations considered">
          <h2 className="fin-card__title">Explanations considered</h2>
          <ul className="fin-expl">
            {a.explanations.map((x) => (
              <li key={x.key} className={`fin-expl__item fin-expl__item--${x.status}`}>
                <div className="fin-expl__head">
                  <span>{x.title}</span>
                  <span className="fin-expl__status">{x.status.replace('_', ' ')}</span>
                </div>
                <ul className="fin-criteria">
                  {x.criteria.map((c) => (
                    <li key={c.description} className={c.observed ? 'is-met' : 'is-unmet'}>
                      <span aria-hidden="true">{c.observed ? '✓' : '✗'}</span> <span className="sr-only">{c.observed ? 'Observed:' : 'Not observed:'}</span> {c.description} <Ids ids={c.evidence} />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="fin-grid">
        <section className="fin-card" aria-label="Evidence">
          <h2 className="fin-card__title">Evidence</h2>
          <h3 className="fin-card__sub">Unusual drivers this month</h3>
          {a.anomalies.length ? (
            <ul className="fin-list">
              {a.anomalies.map((x) => (
                <li key={x.id}>
                  <span className="evid evid--other">{x.id}</span> {x.label}: {(x.change * 100).toFixed(1)}% against its 12-month median (robust z {x.z.toFixed(0)})
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">No driver moved unusually against its own history.</p>
          )}
          <h3 className="fin-card__sub">Journal entries posted this month</h3>
          <table className="fin-table">
            <thead>
              <tr>
                <th scope="col">Entry</th>
                <th scope="col">Line</th>
                <th scope="col">Amount</th>
                <th scope="col">Approval</th>
                <th scope="col">Description</th>
              </tr>
            </thead>
            <tbody>
              {a.entries.map((j) => (
                <tr key={j.id} className={!j.approvalRef ? 'is-flag' : ''}>
                  <td>
                    <span className="evid evid--other">{j.id}</span>
                  </td>
                  <td>{LINE_LABEL[j.line]}</td>
                  <td>{k(j.amount)}</td>
                  <td>{j.approvalRef ?? 'none recorded'}</td>
                  <td>{j.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {a.events.length ? (
            <>
              <h3 className="fin-card__sub">Business events</h3>
              <ul className="fin-list">
                {a.events.map((e) => (
                  <li key={e.id}>
                    <span className="evid evid--other">{e.id}</span> {ds.monthLabel(e.month)}: {e.title}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>

        <section className="fin-card" aria-label="Next steps and limits">
          <h2 className="fin-card__title">What would settle it</h2>
          <ol className="next-steps">
            {a.nextSteps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <h2 className="fin-card__title">What is not known</h2>
          <ul className="unknowns">
            {a.unknowns.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
