import { useState } from 'react';
import { formatClock } from '../core/format';
import type { TimelineEvent, TimelineKind } from '../core/types';
import { useRuntime, useUi } from './context';

type Filter = 'all' | 'anomaly' | 'incident' | 'cyber' | 'ai' | 'operation' | 'scan';

const FILTERS: Array<{ id: Filter; label: string; kinds: TimelineKind[] }> = [
  { id: 'all', label: 'All', kinds: ['simulation', 'operation', 'anomaly', 'incident', 'scan', 'operator', 'system', 'ai', 'cyber'] },
  { id: 'anomaly', label: 'Anomalies', kinds: ['anomaly'] },
  { id: 'incident', label: 'Incidents', kinds: ['incident'] },
  { id: 'cyber', label: 'Cyber', kinds: ['cyber'] },
  { id: 'ai', label: 'AI', kinds: ['ai'] },
  { id: 'operation', label: 'Operations', kinds: ['operation', 'operator', 'simulation', 'system'] },
  { id: 'scan', label: 'Scans', kinds: ['scan'] },
];

const KIND_LABEL: Record<TimelineKind, string> = {
  simulation: 'SIM',
  operation: 'OPS',
  anomaly: 'ANM',
  incident: 'INC',
  scan: 'SCAN',
  operator: 'USER',
  system: 'SYS',
  ai: 'AI',
  cyber: 'CYB',
};

const WINDOW_MS = 5 * 60 * 1000;

export function Timeline() {
  const runtime = useRuntime();
  const open = useUi((s) => s.timelineOpen);
  const clock = useUi((s) => s.clock);
  useUi((s) => s.timelineKey);
  const [filter, setFilter] = useState<Filter>('all');
  const kinds = FILTERS.find((f) => f.id === filter)!.kinds;
  const all = runtime.core.timeline;
  const events = all.filter((e) => kinds.includes(e.kind));
  const recent = events.slice(-80).reverse();
  const from = clock - WINDOW_MS;
  const inWindow = events.filter((e) => e.t >= from);

  const activate = (e: TimelineEvent) => {
    if (e.kind === 'cyber' && e.cyberId) runtime.selectCyber(e.cyberId);
    else if (e.kind === 'ai' && e.incidentId) {
      runtime.selectIncident(e.incidentId);
      runtime.setInvestigationTab('ai');
    } else if (e.kind === 'incident' && e.incidentId) runtime.selectIncident(e.incidentId);
    else if (e.assetId) runtime.selectAsset(e.assetId, e.signalId, { fly: true });
  };

  return (
    <footer className={`timeline${open ? ' is-open' : ''}`} aria-label="Event timeline">
      <div className="timeline__head">
        <button type="button" className="timeline__toggle" onClick={() => runtime.togglePanel('timelineOpen')} aria-expanded={open}>
          <span className="timeline__caret">{open ? '▾' : '▸'}</span>
          Event timeline
          <span className="count">{events.length}</span>
        </button>
        <div className="timeline__filters" role="group" aria-label="Filter events">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className={filter === f.id ? 'is-active' : ''} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="legend" aria-label="Colour legend">
          <span className="legend__item legend__item--nominal">Nominal</span>
          <span className="legend__item legend__item--standby">Standby</span>
          <span className="legend__item legend__item--advisory">Advisory</span>
          <span className="legend__item legend__item--warning">Warning</span>
          <span className="legend__item legend__item--critical">Critical</span>
        </div>
      </div>
      {open ? (
        <>
          <div className="timeline__track" aria-hidden="true">
            <span className="timeline__tick" style={{ left: '0%' }}>
              −5 min
            </span>
            <span className="timeline__tick" style={{ left: '20%' }} />
            <span className="timeline__tick" style={{ left: '40%' }} />
            <span className="timeline__tick" style={{ left: '60%' }} />
            <span className="timeline__tick" style={{ left: '80%' }} />
            <span className="timeline__tick timeline__tick--now" style={{ left: '100%' }}>
              {formatClock(clock)}
            </span>
            {inWindow.map((e) => (
              <button
                key={e.id}
                type="button"
                tabIndex={-1}
                className={`timeline__mark timeline__mark--${e.kind} timeline__mark--${e.severity}`}
                style={{ left: `${((e.t - from) / WINDOW_MS) * 100}%` }}
                title={`${formatClock(e.t)} · ${e.title}`}
                onClick={() => activate(e)}
              />
            ))}
          </div>
          <div className="timeline__list">
            {recent.length === 0 ? <div className="muted timeline__empty">No events of this kind yet.</div> : null}
            {recent.map((e) => (
              <button key={e.id} type="button" className={`event event--${e.severity}`} onClick={() => activate(e)} disabled={!e.assetId && !e.incidentId}>
                <span className="event__time">{formatClock(e.t)}</span>
                <span className={`event__kind event__kind--${e.kind}`}>{KIND_LABEL[e.kind]}</span>
                <span className="event__ref">{e.kind === 'cyber' ? (e.cyberId ?? '') : e.kind === 'incident' || e.kind === 'ai' ? (e.incidentId ?? '') : (e.signalId ?? e.assetId ?? '')}</span>
                <span className="event__title">{e.title}</span>
                <span className="event__detail">{e.detail}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </footer>
  );
}
