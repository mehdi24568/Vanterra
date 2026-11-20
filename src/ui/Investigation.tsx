/**
 * Incident investigation.
 *
 * The page is organised by how certain each kind of statement is, and labels it:
 *   OBSERVED    raw measurements            (trend charts)
 *   DETECTED    anomalies, with their rule  (evidence chain)
 *   CORRELATED  why assets are linked       (dependency paths)
 *   HYPOTHESIS  possible explanations       (evidence-scored, never confirmed by the engine)
 *   CONFIRMED   only ever set by a person
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { formatClock, formatDuration, formatOffset, formatValue } from '../core/format';
import { ANOMALY_KIND_LABEL, RELATION_LABEL } from '../core/types';
import type { Anomaly, CriterionResult, HypothesisAssessment, Incident, PathStep } from '../core/types';
import type { InvestigationTab } from '../runtime/AtlasRuntime';
import { AiPanel } from './AiPanel';
import { AskPanel } from './AskPanel';
import { CyberPhysicalPanel, STANDING_SHORT as CP_STANDING } from './cyber';
import { Sparkline, TrendChart } from './charts';
import { useRuntime, useUi } from './context';
import { AssetLink, Dot, Section, SeverityTag } from './primitives';

type Epistemic = 'observed' | 'detected' | 'correlated' | 'hypothesis' | 'confirmed';

const EPI_LABEL: Record<Epistemic, string> = {
  observed: 'Observed',
  detected: 'Detected',
  correlated: 'Correlated',
  hypothesis: 'Hypothesis',
  confirmed: 'Confirmed',
};

const EPI_HELP: Record<Epistemic, string> = {
  observed: 'A measurement as received from the source.',
  detected: 'A measurement that satisfied a detection rule. The rule and its numbers are shown.',
  correlated: 'Two detections that are linked through the dependency graph. Linked is not the same as caused.',
  hypothesis: 'A possible explanation scored against the evidence. Not a diagnosis.',
  confirmed: 'Verified by a person. The engine never sets this.',
};

function Epi({ kind }: { kind: Epistemic }) {
  return (
    <span className={`epi epi--${kind}`} title={EPI_HELP[kind]}>
      {EPI_LABEL[kind]}
    </span>
  );
}

function useSelectAsset() {
  const runtime = useRuntime();
  return (assetId: string, signalId: string | null = null) => runtime.selectAsset(assetId, signalId, { fly: true, panel: false });
}

/** "A → B ← C" with arrows in the true dependency direction and each asset clickable. */
function PathChain({ path }: { path: PathStep[] }) {
  const runtime = useRuntime();
  const select = useSelectAsset();
  if (path.length === 0) return null;
  const nodes: ReactNode[] = [];
  const link = (id: string, key: string) => <AssetLink key={key} id={id} onClick={() => select(id)} level={runtime.core.healthOf(id)} />;
  nodes.push(link(path[0].from, 'start'));
  path.forEach((s, i) => {
    nodes.push(
      <span key={`a${i}`} className={`path__arrow path__arrow--${s.relation}`} title={`${RELATION_LABEL[s.relation]}: ${s.medium}`}>
        {s.direction === 'downstream' ? '→' : '←'}
      </span>,
    );
    nodes.push(link(s.to, `n${i}`));
  });
  return <span className="path">{nodes}</span>;
}

// ----------------------------------------------------------------- evidence ---

function AnomalyRow({ anomaly, t0, open, onToggle }: { anomaly: Anomaly; t0: number; open: boolean; onToggle: () => void }) {
  const select = useSelectAsset();
  const o = anomaly.observed;
  const composite = anomaly.kind === 'composite';
  return (
    <div className={`evidence${open ? ' is-open' : ''} evidence--${anomaly.status}`}>
      <button type="button" className="evidence__row" onClick={onToggle} aria-expanded={open}>
        <span className="evidence__time">{formatOffset(anomaly.startedAt - t0)}</span>
        <Dot level={anomaly.severity} pulse={anomaly.status === 'active'} />
        <span className="evidence__signal">{composite ? 'RATIO' : anomaly.signalId.slice(anomaly.signalId.indexOf('.') + 1)}</span>
        <span className="evidence__msg">{anomaly.message}</span>
        <span className="evidence__value">{composite ? `+${o.value.toFixed(0)} %` : formatValue(o.value, anomaly.unit)}</span>
        <span className={`evidence__status evidence__status--${anomaly.status}`}>{anomaly.status}</span>
      </button>
      {open ? (
        <div className="evidence__detail">
          <div className="evidence__layer">
            <Epi kind="detected" />
            <span className="evidence__detector">
              {ANOMALY_KIND_LABEL[anomaly.kind]} · {anomaly.detector}
            </span>
          </div>
          <p className="rule__text">{anomaly.rule}</p>
          <dl className="kv kv--compact">
            <dt>Onset</dt>
            <dd>
              {formatClock(anomaly.startedAt)}
              {anomaly.clearedAt ? ` · cleared ${formatClock(anomaly.clearedAt)} (${anomaly.clearReason ?? ''})` : ''}
            </dd>
            {o.baselineMean !== undefined ? (
              <>
                <dt>Baseline at detection</dt>
                <dd>
                  {formatValue(o.baselineMean, anomaly.unit)} ± {formatValue(o.baselineStd)}
                </dd>
              </>
            ) : null}
            <dt>At detection → peak</dt>
            <dd>
              {composite ? `+${o.valueAtOpen.toFixed(0)} % → +${o.peak.toFixed(0)} %` : `${formatValue(o.valueAtOpen, anomaly.unit)} → ${formatValue(o.peak, anomaly.unit)}`}
            </dd>
          </dl>
          {anomaly.signalIds.map((id) => (
            <div key={id} className="evidence__chart">
              <div className="evidence__layer">
                <Epi kind="observed" />
                <button type="button" className="link-button" onClick={() => select(id.slice(0, id.indexOf('.')), id)}>
                  {id}
                </button>
              </div>
              <TrendChart signalId={id} height={128} windowS={300} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EvidenceChain({ incident, anomalies, openId, setOpenId }: { incident: Incident; anomalies: Anomaly[]; openId: string | null; setOpenId: (id: string | null) => void }) {
  const runtime = useRuntime();
  const select = useSelectAsset();
  const [activeOnly, setActiveOnly] = useState(false);
  const t0 = anomalies.length ? Math.min(...anomalies.map((a) => a.startedAt)) : incident.openedAt;
  return (
    <Section
      id="inv-evidence"
      title={
        <>
          Evidence chain <Epi kind="detected" />
        </>
      }
      aside={
        <button type="button" className="link-button" onClick={() => setActiveOnly(!activeOnly)}>
          {activeOnly ? 'Show all' : 'Active only'}
        </button>
      }
    >
      <p className="hint">Every detection in onset order, grouped by asset. Open a row to see the rule that fired and the underlying measurement.</p>
      {incident.assets.map((ia) => {
        const rows = anomalies.filter((a) => a.assetId === ia.assetId && (!activeOnly || a.status === 'active')).sort((a, b) => a.startedAt - b.startedAt);
        if (rows.length === 0) return null;
        const asset = runtime.core.graph.asset(ia.assetId);
        return (
          <div key={ia.assetId} className="evidence-group">
            <div className="evidence-group__head">
              <AssetLink id={ia.assetId} name={asset?.name} onClick={() => select(ia.assetId)} level={ia.activeAnomalies > 0 ? ia.severity : 'nominal'} />
              <span className="evidence-group__onset">first at {formatOffset(ia.firstOnset - t0)}</span>
              {ia.assetId === incident.origin?.assetId ? <span className="tag tag--origin">origin candidate</span> : null}
              <Sparkline signalId={rows[0].signalId} level={ia.activeAnomalies > 0 ? ia.severity : 'nominal'} windowS={240} />
            </div>
            {rows.map((a) => (
              <AnomalyRow key={a.id} anomaly={a} t0={t0} open={openId === a.id} onToggle={() => setOpenId(openId === a.id ? null : a.id)} />
            ))}
          </div>
        );
      })}
    </Section>
  );
}

// -------------------------------------------------------------- correlation ---

function Correlation({ incident }: { incident: Incident }) {
  const runtime = useRuntime();
  const select = useSelectAsset();
  // One explanation per asset: the link recorded when that asset first joined.
  const firstLinks = incident.assets
    .map((ia) => incident.correlations.find((c) => c.assetId === ia.assetId && c.basis !== 'same_asset') ?? incident.correlations.find((c) => c.assetId === ia.assetId))
    .filter((c): c is NonNullable<typeof c> => !!c);
  return (
    <Section
      id="inv-correlation"
      title={
        <>
          Why these are related <Epi kind="correlated" />
        </>
      }
    >
      <p className="hint">
        An anomaly joins an incident only if its asset is within three dependency steps of an asset already involved. A shared supply links its consumers only when the supply itself is
        abnormal. Arrows show the direction of dependency.
      </p>
      {firstLinks.map((c) => (
        <div key={c.anomalyId} className="correlation">
          <div className="correlation__head">
            <AssetLink id={c.assetId} name={runtime.core.graph.asset(c.assetId)?.name} onClick={() => select(c.assetId)} level={runtime.core.healthOf(c.assetId)} />
            <span className="correlation__basis">
              {c.basis === 'initial' ? 'first detection' : c.basis === 'dependency_path' ? `${c.hops} step${c.hops === 1 ? '' : 's'} · +${c.lagS} s` : c.basis === 'temporal_only' ? 'timing only' : `+${c.lagS} s`}
            </span>
          </div>
          {c.path.length > 0 ? <PathChain path={c.path} /> : null}
          <p className="correlation__why">{c.rationale}</p>
        </div>
      ))}
    </Section>
  );
}

// --------------------------------------------------------------- hypotheses ---

function CriterionRow({ criterion }: { criterion: CriterionResult }) {
  const select = useSelectAsset();
  const observed = criterion.state === 'observed';
  const supports = criterion.role === 'supports';
  const cls = supports ? (observed ? 'for' : 'missing') : observed ? 'against' : 'clear';
  const symbol = supports ? (observed ? '✓' : '○') : observed ? '✕' : '–';
  const label = supports ? (observed ? 'Supporting evidence observed' : 'Expected but not observed') : observed ? 'Contradicting evidence observed' : 'Possible contradiction, not observed';
  return (
    <li className={`criterion criterion--${cls}`}>
      <span className="criterion__mark" title={label} aria-label={label}>
        {symbol}
      </span>
      <div className="criterion__body">
        <span className="criterion__text">
          {criterion.description}
          <span className="criterion__weight" title="Weight of this criterion in the support score">
            w{criterion.weight}
          </span>
        </span>
        <span className="criterion__detail">{criterion.detail}</span>
        {criterion.signalIds.length > 0 ? (
          <span className="criterion__signals">
            {criterion.signalIds.slice(0, 6).map((id) => (
              <button key={id} type="button" className="signal-chip" onClick={() => select(id.slice(0, id.indexOf('.')), id)} title="Select this measurement">
                {id}
              </button>
            ))}
          </span>
        ) : null}
      </div>
    </li>
  );
}

function HypothesisCard({ incident, hypothesis, rank, defaultOpen }: { incident: Incident; hypothesis: HypothesisAssessment; rank: number; defaultOpen: boolean }) {
  const runtime = useRuntime();
  const [open, setOpen] = useState(defaultOpen);
  const pct = Math.round(hypothesis.support * 100);
  const supports = hypothesis.criteria.filter((c) => c.role === 'supports');
  const contradicts = hypothesis.criteria.filter((c) => c.role === 'contradicts');
  const observedFor = supports.filter((c) => c.state === 'observed').length;
  const observedAgainst = contradicts.filter((c) => c.state === 'observed').length;
  const d = hypothesis.disposition;
  return (
    <div className={`hypothesis hypothesis--${hypothesis.band} hypothesis--${d}${open ? ' is-open' : ''}`}>
      <button type="button" className="hypothesis__head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="hypothesis__rank">{String(rank).padStart(2, '0')}</span>
        <span className="hypothesis__title">{hypothesis.title}</span>
        <span className="hypothesis__score">
          <span className="hypothesis__pct">{pct} %</span>
          <span className="hypothesis__band">{hypothesis.band}</span>
        </span>
      </button>
      <div className="hypothesis__bar" role="img" aria-label={`Evidence support ${pct} percent`}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="hypothesis__sub">
        {d === 'confirmed' ? <Epi kind="confirmed" /> : <Epi kind="hypothesis" />}
        <span>
          {d === 'confirmed'
            ? `Confirmed by operator at ${formatClock(hypothesis.dispositionAt ?? 0)}`
            : d === 'ruled_out'
              ? `Ruled out by operator at ${formatClock(hypothesis.dispositionAt ?? 0)}`
              : `Unverified · ${observedFor}/${supports.length} supporting · ${observedAgainst} contradicting`}
        </span>
      </div>
      {open ? (
        <div className="hypothesis__body">
          <p className="hypothesis__mechanism">{hypothesis.mechanism}</p>
          <h5 className="subhead">Evidence for</h5>
          <ul className="criteria">
            {supports.map((c) => (
              <CriterionRow key={c.id} criterion={c} />
            ))}
          </ul>
          {contradicts.length > 0 ? (
            <>
              <h5 className="subhead">Evidence against</h5>
              <ul className="criteria">
                {contradicts.map((c) => (
                  <CriterionRow key={c.id} criterion={c} />
                ))}
              </ul>
            </>
          ) : null}
          <p className="hint">
            Support score = weighted supporting evidence observed, minus weighted contradicting evidence observed, as a share of all supporting evidence this mechanism would be expected to
            produce. It is not a probability.
          </p>
          {hypothesis.unknowns.length > 0 ? (
            <>
              <h5 className="subhead">What the instrumentation cannot tell us</h5>
              <ul className="plain">
                {hypothesis.unknowns.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            </>
          ) : null}
          <h5 className="subhead">What would confirm it</h5>
          <p>{hypothesis.verification}</p>
          {hypothesis.alsoEvaluatedFor.length > 0 ? <p className="hint">Same pattern also evaluated, with weaker support, for: {hypothesis.alsoEvaluatedFor.join(', ')}.</p> : null}
          <div className="hypothesis__actions">
            <span className="hint">Operator verdict after physical verification:</span>
            <button type="button" className={`btn btn--ghost${d === 'confirmed' ? ' is-active' : ''}`} onClick={() => runtime.setDisposition(incident.id, hypothesis.key, d === 'confirmed' ? 'unverified' : 'confirmed')}>
              {d === 'confirmed' ? 'Undo confirmation' : 'Mark confirmed'}
            </button>
            <button type="button" className={`btn btn--ghost${d === 'ruled_out' ? ' is-active' : ''}`} onClick={() => runtime.setDisposition(incident.id, hypothesis.key, d === 'ruled_out' ? 'unverified' : 'ruled_out')}>
              {d === 'ruled_out' ? 'Undo rule-out' : 'Rule out'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------- impact ---

function Impact({ incident }: { incident: Incident }) {
  const runtime = useRuntime();
  const select = useSelectAsset();
  const atRisk = incident.impact.filter((i) => i.state === 'at_risk');
  const affected = incident.impact.filter((i) => i.state === 'affected');
  return (
    <Section id="inv-impact" title="What else could be affected">
      <p className="hint">
        Projected by following dependencies downstream from the origin candidate. Exposure falls with each step and when the carrying medium changes. These are exposures, not predictions.
      </p>
      {atRisk.length === 0 ? <p className="muted">No further downstream assets within the exposure threshold.</p> : null}
      {atRisk.map((i) => (
        <div key={i.assetId} className="impact">
          <div className="impact__head">
            <AssetLink id={i.assetId} name={runtime.core.graph.asset(i.assetId)?.name} onClick={() => select(i.assetId)} />
            <span className="impact__bar" title={`Relative exposure ${Math.round(i.exposure * 100)} %`}>
              <span style={{ width: `${Math.round(i.exposure * 100)}%` }} />
            </span>
            <span className="impact__pct">{Math.round(i.exposure * 100)} %</span>
          </div>
          <PathChain path={i.path} />
          <p className="impact__note">{i.note}</p>
        </div>
      ))}
      {affected.length > 0 ? (
        <>
          <h4 className="subhead">Already affected</h4>
          <div className="asset-chips">
            {affected.map((i) => (
              <AssetLink key={i.assetId} id={i.assetId} name={runtime.core.graph.asset(i.assetId)?.name} onClick={() => select(i.assetId)} level={runtime.core.healthOf(i.assetId)} />
            ))}
          </div>
        </>
      ) : null}
    </Section>
  );
}

// --------------------------------------------------------------- assessment ---

const STANDING_SHORT = {
  evidence_consistent: 'Consistent with one explanation',
  competing_explanations: 'Competing explanations remain',
  insufficient_evidence: 'Evidence insufficient',
} as const;

/** The three assessments side by side: what the rules say, what the agents say, what a person has decided. */
function Assessment({ incident }: { incident: Incident }) {
  const runtime = useRuntime();
  const ai = useUi((s) => s.ai);
  useUi((s) => s.aiKey);
  const lead = incident.hypotheses[0];
  const run = runtime.aiRun(incident.id);
  const orch = run?.report?.agents.orchestrator.output ?? null;
  const confirmed = incident.hypotheses.find((h) => h.disposition === 'confirmed');
  const ruledOut = incident.hypotheses.filter((h) => h.disposition === 'ruled_out').length;
  const title = (key: string | null) => incident.hypotheses.find((h) => h.key === key)?.title ?? 'No leading explanation';

  return (
    <div className="assessment" aria-label="Assessment comparison">
      <button type="button" className="assessment__cell" onClick={() => runtime.setInvestigationTab('hypotheses')}>
        <span className="assessment__who">Rule-based engine</span>
        <span className="assessment__what">{lead ? lead.title : 'No matching failure pattern'}</span>
        <span className="assessment__how">{lead ? `${Math.round(lead.support * 100)} % evidence support · ${lead.band} · deterministic` : 'deterministic'}</span>
      </button>
      <button type="button" className={`assessment__cell assessment__cell--ai${!ai.available ? ' is-off' : ''}`} onClick={() => runtime.setInvestigationTab('ai')}>
        <span className="assessment__who">
          AI-assisted review{run?.testDouble ? ' (test double)' : ''}
        </span>
        <span className="assessment__what">
          {!ai.available ? 'Unavailable' : run?.state === 'running' ? 'Investigating…' : orch ? title(orch.leadingHypothesisKey) : run?.error ? 'Did not complete' : 'Not run yet'}
        </span>
        <span className="assessment__how">
          {!ai.available
            ? 'No model provider configured'
            : orch
              ? `${STANDING_SHORT[orch.standing]}${runtime.aiStale(incident.id) ? ' · out of date' : ''}`
              : run?.state === 'running'
                ? 'five agents, evidence-checked'
                : 'advisory only'}
        </span>
      </button>
      <button type="button" className={`assessment__cell assessment__cell--human${confirmed ? ' is-confirmed' : ''}`} onClick={() => runtime.setInvestigationTab('hypotheses')}>
        <span className="assessment__who">Human verdict</span>
        <span className="assessment__what">{confirmed ? confirmed.title : 'Not verified'}</span>
        <span className="assessment__how">
          {confirmed ? `confirmed at ${formatClock(confirmed.dispositionAt ?? 0)}` : `only an operator can confirm${ruledOut ? ` · ${ruledOut} ruled out` : ''}`}
        </span>
      </button>
    </div>
  );
}

// --------------------------------------------------------------------- main ---

const TABS: Array<{ id: InvestigationTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'ask', label: 'Ask' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'hypotheses', label: 'Hypotheses' },
  { id: 'cyber', label: 'Cyber-physical' },
  { id: 'ai', label: 'AI review' },
  { id: 'impact', label: 'Impact' },
  { id: 'checks', label: 'Checks' },
];

export function Investigation() {
  const runtime = useRuntime();
  const core = runtime.core;
  const id = useUi((s) => s.selectedIncidentId);
  const tab = useUi((s) => s.investigationTab);
  const selectedAsset = useUi((s) => s.selectedAssetId);
  const aiAvailable = useUi((s) => s.ai.available);
  useUi((s) => s.incidentsKey);
  useUi((s) => s.anomaliesKey);
  useUi((s) => s.aiKey);
  const clock = useUi((s) => s.clock);
  const [openEvidence, setOpenEvidence] = useState<string | null>(null);
  const select = useSelectAsset();
  const incident = id ? core.intelligence.get(id) : undefined;

  if (!incident) {
    return (
      <div className="rail__scroll">
        <div className="empty">
          <p className="empty__title">Incident not available</p>
          <button type="button" className="btn" onClick={() => runtime.setRightPanel('incidents')}>
            Back to incidents
          </button>
        </div>
      </div>
    );
  }

  const anomalies = incident.anomalyIds.map((a) => core.intelligence.anomaly(a)).filter((a): a is Anomaly => !!a);
  const active = anomalies.filter((a) => a.status === 'active').length;
  const origin = incident.origin;
  const originAsset = origin ? core.graph.asset(origin.assetId) : undefined;
  const selected = selectedAsset ? core.graph.asset(selectedAsset) : undefined;
  const aiRun = runtime.aiRun(incident.id);
  const cp = core.assessIncident(incident.id);
  const cpBadge = !cp ? '' : cp.links.length > 0 ? String(cp.links.length) : '–';
  const counts: Partial<Record<InvestigationTab, string>> = {
    evidence: String(anomalies.length),
    hypotheses: String(incident.hypotheses.length),
    cyber: cpBadge,
    ask: runtime.askHistory(incident.id).length ? String(runtime.askHistory(incident.id).length) : '',
    ai: !aiAvailable ? 'off' : aiRun?.state === 'running' ? '…' : aiRun?.report ? '✓' : '',
    impact: String(incident.impact.filter((i) => i.state === 'at_risk').length),
    checks: String(incident.recommendations.length),
  };

  return (
    <div className="investigation">
      <header className="investigation__head">
        <div className="investigation__top">
          <button type="button" className="link-button" onClick={() => runtime.selectIncident(null)}>
            ← Incidents
          </button>
          <span className="investigation__id">{incident.id}</span>
          <SeverityTag level={incident.severity} />
          <span className={`tag tag--status-${incident.status}`}>{incident.status}</span>
          <span className="investigation__spacer" />
          {aiAvailable ? (
            aiRun?.state === 'running' ? (
              <button type="button" className="btn btn--ghost" onClick={() => runtime.cancelAiInvestigation(incident.id)}>
                Stop AI agents
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--agents"
                title="Run the five AI agents on this incident now"
                onClick={() => {
                  runtime.runAiInvestigation(incident.id);
                  runtime.setInvestigationTab('ai');
                }}
              >
                {aiRun?.report ? 'Re-run AI agents' : 'Run AI agents'}
              </button>
            )
          ) : null}
          <button type="button" className={`btn btn--ghost${incident.acknowledged ? ' is-active' : ''}`} onClick={() => runtime.acknowledge(incident.id)} disabled={incident.acknowledged}>
            {incident.acknowledged ? 'Acknowledged' : 'Acknowledge'}
          </button>
        </div>
        <h2 className="investigation__title">{incident.title}</h2>
        <div className="investigation__meta">
          Opened {formatClock(incident.openedAt)} · {incident.resolvedAt ? `resolved after ${formatDuration(incident.resolvedAt - incident.openedAt)}` : `open for ${formatDuration(clock - incident.openedAt)}`} ·{' '}
          {active} active / {anomalies.length} detections · {incident.assets.length} assets
        </div>
        <nav className="investigation__nav" role="tablist" aria-label="Investigation sections">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`${tab === t.id ? 'is-active' : ''}${t.id === 'ai' ? ' is-ai' : ''}`} onClick={() => runtime.setInvestigationTab(t.id)}>
              {t.label}
              {counts[t.id] ? <span className="investigation__count">{counts[t.id]}</span> : null}
            </button>
          ))}
        </nav>
        {selected ? (
          <div className="investigation__selected">
            <span className="muted">Selected</span>
            <AssetLink id={selected.id} name={selected.name} onClick={() => runtime.focusAsset(selected.id)} level={core.healthOf(selected.id)} />
            <button type="button" className="link-button" onClick={() => runtime.setRightPanel('asset')}>
              Open in inspector →
            </button>
          </div>
        ) : null}
      </header>

      <div className="rail__scroll" key={tab}>
        {tab === 'overview' ? (
          <>
            <Section title="Summary">
              <p className="investigation__summary">{incident.summary}</p>
              <Assessment incident={incident} />
              {cp ? (
                <button type="button" className={`cp-strip cp-strip--${cp.standing}`} onClick={() => runtime.setInvestigationTab('cyber')}>
                  <span className="cp-strip__who">Cyber-physical</span>
                  <span className="cp-strip__what">{CP_STANDING[cp.standing]}</span>
                  <span className="cp-strip__how">{cp.links.length ? `${cp.links.length} linked cyber event${cp.links.length === 1 ? '' : 's'}` : `${cp.consideredEventIds.length} cyber events in window, none linked`} →</span>
                </button>
              ) : null}
              <div className="epi-legend">
                {(Object.keys(EPI_LABEL) as Epistemic[]).map((k) => (
                  <Epi key={k} kind={k} />
                ))}
                <span className="epi epi--ai" title="Produced by the AI agents. Advisory, evidence-checked, never a confirmation.">
                  AI
                </span>
                <span className="hint">Every statement is labelled with how certain it is. Hover a label for its meaning.</span>
              </div>
            </Section>
            <Section
              title={
                <>
                  Origin candidate <Epi kind="correlated" />
                </>
              }
            >
              {origin && originAsset ? (
                <div className="origin">
                  <div className="origin__head">
                    <AssetLink id={origin.assetId} name={originAsset.name} onClick={() => select(origin.assetId)} level={core.healthOf(origin.assetId)} />
                    <span className="origin__score" title="0.5 x earliness + 0.5 x share of other affected assets reachable from it">
                      score {origin.score.toFixed(2)}
                    </span>
                  </div>
                  <ul className="plain">
                    {origin.rationale.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                  <p className="hint">
                    {incident.originAlternatives.length > 0 ? `Next candidates: ${incident.originAlternatives.map((o) => `${o.assetId} (${o.score.toFixed(2)})`).join(', ')}. ` : ''}
                    Ranking reflects timing and graph position only: where to look first, not a finding.
                  </p>
                </div>
              ) : (
                <p className="muted">No origin candidate yet.</p>
              )}
            </Section>
            <Section title="Affected assets, in order of onset" aside={<span className="count">{incident.assets.length}</span>}>
              <div className="asset-chips">
                {incident.assets.map((a) => (
                  <AssetLink key={a.assetId} id={a.assetId} name={core.graph.asset(a.assetId)?.name} onClick={() => select(a.assetId)} level={a.activeAnomalies > 0 ? a.severity : 'nominal'} />
                ))}
              </div>
            </Section>
          </>
        ) : null}

        {tab === 'evidence' ? (
          <>
            <EvidenceChain incident={incident} anomalies={anomalies} openId={openEvidence} setOpenId={setOpenEvidence} />
            <Correlation incident={incident} />
          </>
        ) : null}

        {tab === 'hypotheses' ? (
          <Section
            id="inv-hypotheses"
            title={
              <>
                Rule-based explanations <Epi kind="hypothesis" />
              </>
            }
            aside={<span className="muted">deterministic · {incident.reasoner}</span>}
          >
            {incident.assessmentFrozen ? (
              <p className="notice">
                Assessed on evidence up to {formatClock(incident.assessmentFrozen.at)}. A commanded change followed ({incident.assessmentFrozen.reason}), so later readings show the plant&apos;s response rather than more evidence about the cause.
              </p>
            ) : null}
            {incident.hypotheses.length === 0 ? (
              <p className="muted">No failure pattern in the knowledge base matches this evidence. The reasoner does not guess beyond its rules.</p>
            ) : (
              incident.hypotheses.map((h, i) => <HypothesisCard key={h.key} incident={incident} hypothesis={h} rank={i + 1} defaultOpen={i === 0} />)
            )}
          </Section>
        ) : null}

        {tab === 'cyber' ? <CyberPhysicalPanel incident={incident} /> : null}

        {tab === 'ai' ? <AiPanel incident={incident} /> : null}
        {tab === 'ask' ? <AskPanel incident={incident} /> : null}

        {tab === 'impact' ? <Impact incident={incident} /> : null}

        {tab === 'checks' ? (
          <Section id="inv-actions" title="Recommended physical checks" aside={<span className="muted">rule-based</span>}>
            <p className="hint">Checks that would confirm or rule out the leading explanations. Vanterra recommends; it does not operate equipment.</p>
            <ol className="actions">
              {incident.recommendations.map((r) => (
                <li key={r.id} className={`action${r.done ? ' is-done' : ''}`}>
                  <label>
                    <input type="checkbox" checked={r.done} onChange={() => runtime.toggleRecommendation(incident.id, r.id)} />
                    <span className="action__text">{r.text}</span>
                  </label>
                  <span className="action__basis">{r.basis}</span>
                </li>
              ))}
            </ol>
            <p className="hint">
              {aiRun?.report?.agents.investigation_planner.output ? (
                <button type="button" className="link-button" onClick={() => runtime.setInvestigationTab('ai')}>
                  The AI planner prioritised {aiRun.report.agents.investigation_planner.output.checks.length} checks: see AI review →
                </button>
              ) : (
                'Human verification: once a check has been carried out, record the verdict on the hypothesis in the Hypotheses tab.'
              )}
            </p>
          </Section>
        ) : null}
      </div>
    </div>
  );
}
