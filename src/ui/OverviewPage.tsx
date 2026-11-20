/**
 * Overview: what is happening in the (simulated) facility right now, across the
 * physical and cyber domains. Every figure is computed from engine state; nothing
 * here is an illustrative or modelled "risk score".
 */
import { formatClock } from '../core/format';
import type { HealthState, Severity } from '../core/types';
import { SEVERITY_RANK } from '../core/types';
import { useRuntime, useUi } from './context';
import { DomainTag, EvidenceId, SevChip, STANDING_SHORT, domainOf } from './cyber';
import { Dot } from './primitives';

const sevRank = (s: Severity | HealthState) => (s === 'nominal' ? 0 : SEVERITY_RANK[s]);

function Kpi({ label, value, sub, tone = 'default', onClick }: { label: string; value: string | number; sub?: string; tone?: string; onClick?: () => void }) {
  const body = (
    <>
      <span className="kpi__label">{label}</span>
      <span className="kpi__value">{value}</span>
      {sub ? <span className="kpi__sub">{sub}</span> : null}
    </>
  );
  return onClick ? (
    <button type="button" className={`kpi kpi--${tone} kpi--button`} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={`kpi kpi--${tone}`}>{body}</div>
  );
}

const DEMOS: { id: string; label: string; tag: 'physical' | 'cyber' | 'cyber-physical'; look: string }[] = [
  { id: 'pump-bearing', label: 'A · Physical anomaly', tag: 'physical', look: 'A feed-pump bearing degrades. Detection, correlation and a physical explanation, with no cyber evidence involved.' },
  { id: 'ot-remote-access', label: 'B · Cyber investigation', tag: 'cyber', look: 'Failed vendor logons, an out-of-window engineering session and a zone violation. One cyber case, no physical effect.' },
  {
    id: 'cp-fan-setpoint',
    label: 'C · Cyber-physical investigation',
    tag: 'cyber-physical',
    look: 'An unapproved fan-speed change on PLC-500, then a thermal deviation. See what the evidence supports, and what it does not.',
  },
  { id: 'cp-approved-tuning', label: 'C′ · Approved change, real effect', tag: 'cyber-physical', look: 'The same setting changed under an approved change record. Authorised is not the same as harmless.' },
];

export function OverviewPage() {
  const runtime = useRuntime();
  const core = runtime.core;
  const counts = useUi((s) => s.counts);
  const ai = useUi((s) => s.ai);
  const health = useUi((s) => s.health);
  const active = useUi((s) => s.activeScenarios);
  useUi((s) => s.incidentsKey);
  useUi((s) => s.cyberKey);
  useUi((s) => s.timelineKey);
  const cyber = core.cyber;

  const incidents = core.intelligence.incidents().filter((i) => i.status !== 'resolved');
  const cases = cyber?.cases ?? [];
  const attention = [
    ...incidents.map((i) => {
      const a = core.assessIncident(i.id);
      return {
        key: i.id,
        rank: sevRank(i.severity) + 0.5,
        severity: i.severity as Severity,
        domain: domainOf(a?.standing ?? null) as 'physical' | 'cyber' | 'cyber-physical',
        id: i.id,
        title: i.title,
        detail: a ? STANDING_SHORT[a.standing] : (i.hypotheses[0]?.title ?? ''),
        since: i.openedAt,
        open: () => runtime.openIncident(i.id, a && domainOf(a.standing) === 'cyber-physical' ? 'cyber' : 'overview'),
      };
    }),
    ...cases.map((c) => {
      const a = core.assessCyberCase(c.id);
      return {
        key: c.id,
        rank: sevRank(c.severity),
        severity: c.severity,
        domain: (a?.physicalEffectObserved ? 'cyber-physical' : 'cyber') as 'physical' | 'cyber' | 'cyber-physical',
        id: c.id,
        title: c.title,
        detail: a?.summary ?? '',
        since: c.openedAt,
        open: () => runtime.selectCyber(c.id),
      };
    }),
  ].sort((x, y) => y.rank - x.rank || y.since - x.since);

  const changes = [
    ...(cyber?.events.filter((e) => e.category === 'configuration_change').map((e) => ({ t: e.t, id: e.id, text: e.title, kind: e.ruleId === 'APPROVED-CHANGE' ? 'approved' : 'unapproved' })) ?? []),
    ...core.timeline.filter((e) => e.kind === 'operation').map((e) => ({ t: e.t, id: null as string | null, text: e.title, kind: 'operation' })),
  ]
    .sort((a, b) => b.t - a.t)
    .slice(0, 6);

  const recent = core.timeline.filter((e) => e.kind !== 'scan' && e.kind !== 'simulation').slice(-9).reverse();

  const conditionTone = counts.plantCondition === 'nominal' ? 'ok' : counts.plantCondition;

  return (
    <main className="page page--overview" aria-label="Overview">
      <header className="page__head">
        <div>
          <h1 className="page__title">Overview</h1>
          <p className="page__sub">
            {runtime.facility.name} · simulated facility · plant time {formatClock(core.now)} UTC{active ? ` · running: ${active.split(',').join(', ')}` : ''}
          </p>
        </div>
      </header>

      <div className="kpis">
        <Kpi label="Plant condition" value={counts.plantCondition === 'nominal' ? 'Normal' : counts.plantCondition} sub={`${counts.assetsAbnormal} of ${counts.assets} assets abnormal`} tone={conditionTone} />
        <Kpi label="Open incidents" value={counts.incidentsOpen} sub="physical, correlated" tone={counts.incidentsOpen ? conditionTone : 'default'} onClick={incidents[0] ? () => runtime.openIncident(incidents[0].id) : undefined} />
        <Kpi label="Physical anomalies" value={counts.anomalies} sub={counts.anomalies ? `${counts.critical} crit · ${counts.warning} warn · ${counts.advisory} adv` : 'none active'} tone={counts.anomalies ? conditionTone : 'default'} />
        <Kpi
          label="Cyber events"
          value={counts.cyberNotable}
          sub={`${counts.cyberCases} case${counts.cyberCases === 1 ? '' : 's'} · last 10 min: ${counts.cyberRecent === 'nominal' ? 'quiet' : counts.cyberRecent}`}
          tone={counts.cyberRecent === 'nominal' ? 'default' : 'cyber'}
          onClick={() => runtime.setView('cyber')}
        />
        <Kpi label="Assets running" value={`${counts.assetsActive} / ${counts.assets}`} sub={`${counts.signalsActive} of ${counts.signals} signals fresh`} />
        <Kpi label="AI service" value={!ai.checked ? 'Checking' : ai.available ? (ai.testDouble ? 'Test double' : 'Ready') : 'Unavailable'} sub={ai.available ? (ai.model ?? ai.provider) : 'deterministic engine unaffected'} tone="muted" />
        <Kpi label="Pipeline health" value={health.state === 'nominal' ? 'OK' : health.state === 'degraded' ? 'Degraded' : 'Fault'} sub={`${health.batchMs.toFixed(2)} ms per batch`} tone="muted" />
      </div>

      <div className="overview-grid">
        <section className="pane pane--attention">
          <h2 className="pane__title">
            Requires attention <span className="count">{attention.length}</span>
          </h2>
          {attention.length === 0 ? (
            <div className="empty-state">
              <Dot level="nominal" />
              <div>
                <strong>Nothing requires attention.</strong>
                <p>No open incidents and no cyber cases. Run a demonstration scenario below to see an investigation.</p>
              </div>
            </div>
          ) : (
            <ul className="rows">
              {attention.map((x) => (
                <li key={x.key}>
                  <button type="button" className="row row--tall" onClick={x.open}>
                    <SevChip severity={x.severity} />
                    <DomainTag domain={x.domain} />
                    <span className="row__id">{x.id}</span>
                    <span className="row__title">{x.title}</span>
                    <span className="row__detail">{x.detail}</span>
                    <span className="row__meta">since {formatClock(x.since)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="pane pane--areas">
          <h2 className="pane__title">Facility areas</h2>
          <table className="areas">
            <thead>
              <tr>
                <th>Area</th>
                <th>Assets</th>
                <th>Condition</th>
                <th>Controller</th>
                <th>Cyber, 10 min</th>
              </tr>
            </thead>
            <tbody>
              {runtime.facility.areas.map((area) => {
                const assets = runtime.facility.assets.filter((a) => a.area === area.id);
                const worst = assets.map((a) => core.healthOf(a.id)).reduce<HealthState>((w, h) => (sevRank(h) > sevRank(w) ? h : w), 'nominal');
                const abnormal = assets.filter((a) => core.healthOf(a.id) !== 'nominal').length;
                const plcs = cyber?.model.devices.filter((d) => d.areaId === area.id && d.kind === 'plc') ?? [];
                const cyberSev = plcs.map((p) => runtime.otSeverity(p.id)).filter((s): s is Severity => !!s);
                return (
                  <tr key={area.id}>
                    <td>
                      <span className="areas__name">{area.name.toLowerCase()}</span>
                    </td>
                    <td>{assets.length}</td>
                    <td>
                      <Dot level={worst} /> {worst === 'nominal' ? 'normal' : `${abnormal} abnormal`}
                    </td>
                    <td>
                      {plcs.map((p) => (
                        <button key={p.id} type="button" className="device-link" onClick={() => runtime.selectCyber(p.id)}>
                          {p.id}
                        </button>
                      ))}
                    </td>
                    <td>{cyberSev.length ? <SevChip severity={cyberSev.reduce((w, s) => (sevRank(s) > sevRank(w) ? s : w))} /> : <span className="muted">quiet</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section className="pane pane--changes">
          <h2 className="pane__title">Recent changes</h2>
          {changes.length === 0 ? (
            <p className="empty">No configuration changes or operating-point changes since start.</p>
          ) : (
            <ul className="changes">
              {changes.map((c, i) => (
                <li key={i}>
                  <span className="changes__t">{formatClock(c.t)}</span>
                  <span className={`change-kind change-kind--${c.kind}`}>{c.kind}</span>
                  {c.id ? <EvidenceId id={c.id} /> : null}
                  <span className="changes__text">{c.text}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="pane pane--demos">
          <h2 className="pane__title">Demonstration scenarios</h2>
          <p className="hint">Each run resets the simulation to the same seed, so results are repeatable. Speed is set to ×4.</p>
          <ul className="demos">
            {DEMOS.map((d) => (
              <li key={d.id} className={`demo demo--${d.tag}`}>
                <div className="demo__head">
                  <DomainTag domain={d.tag} />
                  <span className="demo__label">{d.label}</span>
                </div>
                <p className="demo__look">{d.look}</p>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => runtime.runScenario(d.id)}>
                  Run scenario
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="pane pane--activity">
          <h2 className="pane__title">Recent activity</h2>
          {recent.length === 0 ? (
            <p className="empty">Nothing yet.</p>
          ) : (
            <ul className="activity">
              {recent.map((e) => (
                <li key={e.id}>
                  <span className="activity__t">{formatClock(e.t)}</span>
                  <span className={`event__kind event__kind--${e.kind}`}>{e.kind}</span>
                  <SevChip severity={e.severity} />
                  <span className="activity__title">{e.title}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
