import { useState } from 'react';
import { formatClock, formatDuration, formatValue } from '../core/format';
import { ANOMALY_KIND_LABEL, CATEGORY_LABEL, RELATION_LABEL, SEVERITY_RANK } from '../core/types';
import type { Anomaly, AssetDefinition, Incident, SignalDefinition } from '../core/types';
import type { RightPanel as PanelId } from '../runtime/AtlasRuntime';
import { Sparkline, TrendChart } from './charts';
import { useRuntime, useUi } from './context';
import { Investigation } from './Investigation';
import { AssetLink, Dot, Section, SeverityTag, StateTag } from './primitives';

// ------------------------------------------------------------------ signals ---

function SignalRow({ signal, open, onToggle, anomalies }: { signal: SignalDefinition; open: boolean; onToggle: () => void; anomalies: Anomaly[] }) {
  const runtime = useRuntime();
  const core = runtime.core;
  const value = core.telemetry.latest(signal.id);
  const baseline = core.anomalies.baseline(signal.id);
  const level = runtime.signalHealth(signal.id);
  const z = core.anomalies.zScore(signal.id);
  let baselineText: string;
  if (signal.role === 'setpoint') baselineText = 'setpoint';
  else if (signal.type === 'status') baselineText = value === undefined ? '—' : value >= 1.5 ? 'TRIPPED' : value >= 0.5 ? 'RUN' : 'STOP';
  else if (!signal.detect.baseline) baselineText = 'limits only';
  else if (baseline?.ready) baselineText = `${z >= 0 ? '+' : '−'}${Math.abs(z).toFixed(1)}σ`;
  else if (baseline && core.now < baseline.holdoffUntil) baselineText = 're-learning';
  else baselineText = 'learning';

  return (
    <div className={`signal${open ? ' is-open' : ''}${level !== 'nominal' ? ` signal--${level}` : ''}`}>
      <button type="button" className="signal__row" onClick={onToggle} aria-expanded={open}>
        <Dot level={level} pulse={level !== 'nominal'} />
        <span className="signal__name">
          <span className="signal__key">{signal.key}</span>
          {signal.name}
        </span>
        <Sparkline signalId={signal.id} level={level} />
        <span className="signal__value">{signal.type === 'status' ? baselineText : formatValue(value, signal.unit)}</span>
        <span className="signal__z">{signal.type === 'status' ? '' : baselineText}</span>
      </button>
      {open ? (
        <div className="signal__detail">
          <TrendChart signalId={signal.id} />
          <dl className="kv kv--compact">
            <dt>Tag</dt>
            <dd>{signal.id}</dd>
            {baseline?.ready && signal.detect.baseline ? (
              <>
                <dt>Learned baseline</dt>
                <dd>
                  {formatValue(baseline.mean, signal.unit)} ± {formatValue(baseline.std)} (1σ, {baseline.samples} samples)
                </dd>
              </>
            ) : null}
            {signal.limits ? (
              <>
                <dt>Alarm limits</dt>
                <dd>
                  {[
                    signal.limits.lowAlarm !== undefined ? `LL ${signal.limits.lowAlarm}` : null,
                    signal.limits.lowWarn !== undefined ? `L ${signal.limits.lowWarn}` : null,
                    signal.limits.highWarn !== undefined ? `H ${signal.limits.highWarn}` : null,
                    signal.limits.highAlarm !== undefined ? `HH ${signal.limits.highAlarm}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}{' '}
                  {signal.unit}
                </dd>
              </>
            ) : null}
            {signal.rateLimit !== undefined ? (
              <>
                <dt>Rate limit</dt>
                <dd>
                  ±{signal.rateLimit} {signal.unit}/min
                </dd>
              </>
            ) : null}
            {signal.setpointSignalId ? (
              <>
                <dt>Controlled against</dt>
                <dd>
                  {signal.setpointSignalId} ({formatValue(core.telemetry.latest(signal.setpointSignalId), signal.unit)})
                </dd>
              </>
            ) : null}
          </dl>
          {anomalies.map((a) => (
            <div key={a.id} className={`rule rule--${a.severity}`}>
              <span className="rule__head">
                {ANOMALY_KIND_LABEL[a.kind]} · since {formatClock(a.startedAt)}
              </span>
              <span className="rule__text">{a.rule}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// -------------------------------------------------------------------- asset ---

function AssetInspector({ asset }: { asset: AssetDefinition }) {
  const runtime = useRuntime();
  const core = runtime.core;
  // Re-render at the publish rate so live values stay current.
  useUi((s) => s.clock);
  useUi((s) => s.anomaliesKey);
  const focusSignal = useUi((s) => s.selectedSignalId);
  const incidentId = useUi((s) => s.selectedIncidentId);
  const [openSignal, setOpenSignal] = useState<string | null>(null);
  const [lastFocus, setLastFocus] = useState<string | null>(null);
  if (focusSignal !== lastFocus) {
    // A signal marker was clicked in the scene: open that signal's trend.
    setLastFocus(focusSignal);
    if (focusSignal && focusSignal.startsWith(`${asset.id}.`)) setOpenSignal(focusSignal);
  }

  const health = core.healthOf(asset.id);
  const state = core.operatingState(asset.id);
  const anomalies = core.activeAnomaliesFor(asset.id).sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const incidents = core.intelligence.incidents().filter((i) => i.assets.some((a) => a.assetId === asset.id));
  const incoming = core.graph.incoming(asset.id);
  const outgoing = core.graph.outgoing(asset.id);
  const area = core.facility.areas.find((a) => a.id === asset.area);
  const contact = runtime.sonar.secondsSinceContact(asset.id);
  const select = (id: string) => runtime.selectAsset(id, null, { fly: true });

  return (
    <div className="inspector">
      {incidentId ? (
        <button type="button" className="link-button back-link" onClick={() => runtime.setRightPanel('investigation')}>
          ← Back to {incidentId} investigation
        </button>
      ) : null}
      <header className="inspector__head">
        <div className="inspector__title">
          <span className="inspector__tag">{asset.id}</span>
          <span className="inspector__name">{asset.name}</span>
        </div>
        <div className="inspector__meta">
          {CATEGORY_LABEL[asset.category]} · {area ? `${area.id} ${area.name}` : asset.area} · E{asset.position.x.toFixed(0)} N{(-asset.position.z).toFixed(0)}
        </div>
        <div className="inspector__chips">
          <StateTag state={state} />
          <SeverityTag level={health} />
          <span className="tag tag--muted" title="Time since a sonar wavefront last crossed this asset">
            {contact === null ? 'Not yet scanned' : `Scanned ${contact < 1 ? 'just now' : `${contact.toFixed(0)} s ago`}`}
          </span>
        </div>
        <div className="button-row">
          <button type="button" className="btn btn--ghost" onClick={() => runtime.focusAsset(asset.id)} title="Frame this asset (F)">
            Focus camera
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => runtime.pingFromSelection()}>
            Ping here
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => runtime.selectAsset(null)} title="Clear selection (Esc)">
            Clear
          </button>
        </div>
      </header>

      {anomalies.length > 0 ? (
        <Section title="Active anomalies" aside={<span className="count">{anomalies.length}</span>}>
          {anomalies.map((a) => {
            const inc = core.intelligence.incidentOfAnomaly(a.id);
            return (
              <div key={a.id} className={`rule rule--${a.severity}`}>
                <span className="rule__head">
                  {a.message}
                  <span className="rule__age">{formatDuration(core.now - a.startedAt)}</span>
                </span>
                <span className="rule__text">{a.rule}</span>
                <span className="rule__foot">
                  {a.detector}
                  {inc ? (
                    <button type="button" className="link-button" onClick={() => runtime.selectIncident(inc.id)}>
                      {inc.id} →
                    </button>
                  ) : (
                    <span className="muted">not yet correlated</span>
                  )}
                </span>
              </div>
            );
          })}
        </Section>
      ) : null}

      <Section title="Signals" aside={<span className="count">{asset.signals.length}</span>}>
        <div className="signals">
          {asset.signals.map((s) => (
            <SignalRow
              key={s.id}
              signal={s}
              open={openSignal === s.id}
              onToggle={() => setOpenSignal(openSignal === s.id ? null : s.id)}
              anomalies={anomalies.filter((a) => a.signalIds.includes(s.id))}
            />
          ))}
        </div>
      </Section>

      <Section title="Connected assets" aside={<span className="count">{incoming.length + outgoing.length}</span>}>
        {incoming.length > 0 ? <h4 className="subhead">Depends on</h4> : null}
        {incoming.map((r) => (
          <div key={r.id} className="relation">
            <span className={`relation__type relation__type--${r.type}`}>{RELATION_LABEL[r.type]}</span>
            <AssetLink id={r.from} name={core.graph.asset(r.from)?.name} onClick={() => select(r.from)} level={core.healthOf(r.from)} />
            <span className="relation__medium">{r.medium}</span>
          </div>
        ))}
        {outgoing.length > 0 ? <h4 className="subhead">Supplies</h4> : null}
        {outgoing.map((r) => (
          <div key={r.id} className="relation">
            <span className={`relation__type relation__type--${r.type}`}>{RELATION_LABEL[r.type]}</span>
            <AssetLink id={r.to} name={core.graph.asset(r.to)?.name} onClick={() => select(r.to)} level={core.healthOf(r.to)} />
            <span className="relation__medium">{r.medium}</span>
          </div>
        ))}
      </Section>

      {incidents.length > 0 ? (
        <Section title="Incidents involving this asset">
          {incidents.map((i) => (
            <IncidentRow key={i.id} incident={i} />
          ))}
        </Section>
      ) : null}

      <Section title="Asset data">
        <dl className="kv">
          {Object.entries(asset.metadata).map(([k, v]) => (
            <div key={k} className="kv__pair">
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </div>
  );
}

function AssetDirectory() {
  const runtime = useRuntime();
  useUi((s) => s.healthKey);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const core = runtime.core;
  return (
    <div className="directory">
      <p className="hint">Select equipment in the 3D scene, or choose it here.</p>
      <input className="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by tag or name" aria-label="Filter assets" />
      {core.facility.areas.map((area) => {
        const assets = core.facility.assets.filter((a) => a.area === area.id && (!q || a.id.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)));
        if (assets.length === 0) return null;
        return (
          <div key={area.id} className="directory__group">
            <h4 className="subhead">
              {area.id} · {area.name}
            </h4>
            {assets.map((a) => {
              const health = core.healthOf(a.id);
              const state = core.operatingState(a.id);
              return (
                <button key={a.id} type="button" className="directory__row" onClick={() => runtime.selectAsset(a.id, null, { fly: true })}>
                  <Dot level={health !== 'nominal' ? health : state === 'standby' ? 'standby' : 'nominal'} />
                  <span className="directory__id">{a.id}</span>
                  <span className="directory__name">{a.name}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- incidents ---

export function IncidentRow({ incident }: { incident: Incident }) {
  const runtime = useRuntime();
  const lead = incident.hypotheses[0];
  const confirmed = incident.hypotheses.find((h) => h.disposition === 'confirmed');
  return (
    <button type="button" className={`incident-row incident-row--${incident.severity} incident-row--${incident.status}`} onClick={() => runtime.selectIncident(incident.id)}>
      <span className="incident-row__head">
        <span className="incident-row__id">{incident.id}</span>
        <span className={`tag tag--status-${incident.status}`}>{incident.status}</span>
        <span className="incident-row__time">{formatClock(incident.openedAt)}</span>
      </span>
      <span className="incident-row__title">{incident.title}</span>
      <span className="incident-row__meta">
        {incident.assets.length} asset{incident.assets.length === 1 ? '' : 's'} · {incident.anomalyIds.length} anomal{incident.anomalyIds.length === 1 ? 'y' : 'ies'}
      </span>
      <span className="incident-row__lead">
        {confirmed ? (
          <>
            <span className="epi epi--confirmed">Confirmed</span> {confirmed.title}
          </>
        ) : lead ? (
          <>
            <span className="epi epi--hypothesis">Hypothesis</span> {lead.title} · {Math.round(lead.support * 100)} % support
          </>
        ) : (
          'No matching failure pattern'
        )}
      </span>
    </button>
  );
}

function IncidentList() {
  const runtime = useRuntime();
  useUi((s) => s.incidentsKey);
  const incidents = [...runtime.core.intelligence.incidents()].sort((a, b) => {
    const ra = a.status === 'resolved' ? 1 : 0;
    const rb = b.status === 'resolved' ? 1 : 0;
    return ra - rb || b.openedAt - a.openedAt;
  });
  if (incidents.length === 0) {
    return (
      <div className="empty">
        <p className="empty__title">No incidents</p>
        <p>
          Nothing abnormal has been detected. To see the full pipeline, inject an abnormal scenario from <strong>Scenarios</strong> in the controls panel, for
          example <em>Feed pump bearing degradation</em>.
        </p>
        <p className="hint">An incident opens when a warning-level anomaly appears, or when two or more anomalies are related through the dependency graph.</p>
      </div>
    );
  }
  return (
    <div className="list">
      {incidents.map((i) => (
        <IncidentRow key={i.id} incident={i} />
      ))}
    </div>
  );
}

function AnomalyList() {
  const runtime = useRuntime();
  const core = runtime.core;
  useUi((s) => s.anomaliesKey);
  useUi((s) => s.incidentsKey);
  const anomalies = core.anomalies.active().sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.startedAt - b.startedAt);
  if (anomalies.length === 0) {
    return (
      <div className="empty">
        <p className="empty__title">No active anomalies</p>
        <p>Every analysed signal is inside its limits and within its learned baseline.</p>
      </div>
    );
  }
  return (
    <div className="list">
      {anomalies.map((a) => {
        const inc = core.intelligence.incidentOfAnomaly(a.id);
        return (
          <button key={a.id} type="button" className={`anomaly-row anomaly-row--${a.severity}`} onClick={() => runtime.selectAsset(a.assetId, a.signalId, { fly: true })}>
            <span className="anomaly-row__head">
              <Dot level={a.severity} pulse />
              <span className="anomaly-row__signal">{a.signalIds.length > 1 ? a.assetId : a.signalId}</span>
              <span className="anomaly-row__time">{formatClock(a.startedAt)}</span>
            </span>
            <span className="anomaly-row__msg">{a.message}</span>
            <span className="anomaly-row__meta">
              {ANOMALY_KIND_LABEL[a.kind]} · {inc ? inc.id : 'not yet correlated'}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// -------------------------------------------------------------------- panel ---

function Tabs() {
  const runtime = useRuntime();
  const panel = useUi((s) => s.rightPanel);
  const counts = useUi((s) => s.counts);
  const selected = useUi((s) => s.selectedAssetId);
  const tabs: Array<{ id: PanelId; label: string; count?: number }> = [
    { id: 'asset', label: selected ?? 'Asset' },
    { id: 'incidents', label: 'Incidents', count: counts.incidentsOpen },
    { id: 'anomalies', label: 'Anomalies', count: counts.anomalies },
  ];
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={panel === t.id} className={`tab${panel === t.id ? ' is-active' : ''}`} onClick={() => runtime.setRightPanel(t.id)}>
          {t.label}
          {t.count ? <span className="tab__count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function InspectorPanel() {
  const runtime = useRuntime();
  const panel = useUi((s) => s.rightPanel);
  const open = useUi((s) => s.rightOpen);
  const selected = useUi((s) => s.selectedAssetId);
  const asset = selected ? runtime.core.graph.asset(selected) : undefined;
  return (
    <aside className={`rail rail--right${panel === 'investigation' ? ' rail--wide' : ''}${open ? ' is-open' : ''}`} aria-label="Inspector">
      {panel === 'investigation' ? (
        <Investigation />
      ) : (
        <>
          <Tabs />
          <div className="rail__scroll">
            {panel === 'asset' ? asset ? <AssetInspector key={asset.id} asset={asset} /> : <AssetDirectory /> : null}
            {panel === 'incidents' ? <IncidentList /> : null}
            {panel === 'anomalies' ? <AnomalyList /> : null}
          </div>
        </>
      )}
    </aside>
  );
}
