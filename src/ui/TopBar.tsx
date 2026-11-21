import type { ReactNode } from 'react';
import { formatClock, formatDate } from '../core/format';
import type { AppView } from '../runtime/AtlasRuntime';
import { useRuntime, useUi } from './context';

type Tone = 'default' | 'advisory' | 'warning' | 'critical' | 'ok' | 'muted' | 'cyber';

function Metric({ label, value, sub, tone = 'default', onClick, title, group }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone; onClick?: () => void; title?: string; group?: 'plant' | 'cyber' | 'platform' }) {
  const body = (
    <>
      <span className="metric__label">{label}</span>
      <span className="metric__value">
        {value}
        {sub ? <span className="metric__sub">{sub}</span> : null}
      </span>
    </>
  );
  const cls = `metric metric--${tone}${group ? ` metric--${group}` : ''}`;
  return onClick ? (
    <button type="button" className={`${cls} metric--button`} onClick={onClick} title={title}>
      {body}
    </button>
  ) : (
    <div className={cls} title={title}>
      {body}
    </div>
  );
}

const CONDITION_LABEL = { nominal: 'Normal', advisory: 'Advisory', warning: 'Warning', critical: 'Critical' } as const;

/** The Vanterra mark: a horizon line seen from a raised vantage point, two layers (physical and cyber) in one view. */
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg className="brand__mark" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <path d="M3 22 L16 6 L29 22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M8.5 22 L16 13 L23.5 22" fill="none" stroke="var(--cyber)" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M2 26.5 H30" stroke="currentColor" strokeWidth="1.4" opacity="0.55" />
    </svg>
  );
}

const VIEWS: { id: AppView; label: string; key: string }[] = [
  { id: 'overview', label: 'Overview', key: '1' },
  { id: 'spatial', label: 'Spatial', key: '2' },
  { id: 'cyber', label: 'Cyber & OT', key: '3' },
  { id: 'finance', label: 'Finance', key: '4' },
];

/**
 * Navigation and status. Three things are kept visibly apart:
 *   the PLANT (is the simulated facility behaving normally?),
 *   CYBER activity on its OT network, and
 *   the PLATFORM (is Vanterra itself - its pipeline and AI service - working?).
 */
export function TopBar() {
  const runtime = useRuntime();
  const view = useUi((s) => s.view);
  const counts = useUi((s) => s.counts);
  const health = useUi((s) => s.health);
  const clock = useUi((s) => s.clock);
  const running = useUi((s) => s.running);
  const speed = useUi((s) => s.speed);
  const ai = useUi((s) => s.ai);
  const facility = runtime.facility;

  const conditionTone: Tone = counts.plantCondition === 'nominal' ? 'ok' : counts.plantCondition;

  return (
    <header className="topbar">
      <div className="brand">
        {view === 'spatial' ? (
          <button type="button" className="icon-button brand__menu" onClick={() => runtime.togglePanel('leftOpen')} aria-label="Toggle controls panel" title="Controls">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.3" fill="none" />
            </svg>
          </button>
        ) : null}
        <BrandMark />
        <span className="brand__name">Vanterra</span>
        <span className="brand__facility">
          <span className="brand__site">{facility.name}</span>
          <span className="brand__source" title={runtime.core.adapter.health().detail}>
            Simulated source
          </span>
        </span>
      </div>

      <nav className="views" aria-label="Product areas">
        {VIEWS.map((v) => (
          <button key={v.id} type="button" className={`views__tab${view === v.id ? ' is-active' : ''}`} aria-current={view === v.id ? 'page' : undefined} onClick={() => runtime.setView(v.id)} title={`${v.label} (${v.key})`}>
            {v.label}
            {v.id === 'cyber' && counts.cyberRecent !== 'nominal' ? <span className={`views__dot views__dot--${counts.cyberRecent}`} aria-label="recent cyber events" /> : null}
            {v.id === 'spatial' && counts.incidentsOpen > 0 ? <span className={`views__dot views__dot--${counts.plantCondition}`} aria-label="open incidents" /> : null}
          </button>
        ))}
      </nav>

      <div className="metrics" role="status" aria-label="Operational status">
        <Metric
          group="plant"
          label="Plant"
          value={CONDITION_LABEL[counts.plantCondition]}
          sub={`${counts.assetsAbnormal} abn`}
          tone={conditionTone}
          onClick={() => runtime.setView('overview')}
          title="Worst condition of any asset in the simulated plant, from active anomalies."
        />
        <Metric group="plant" label="Incidents" value={counts.incidentsOpen} sub="open" tone={counts.incidentsOpen > 0 ? conditionTone : 'default'} onClick={() => runtime.setView('overview')} title="Open physical incidents" />
        <Metric
          group="cyber"
          label="Cyber"
          value={counts.cyberNotable}
          sub={`${counts.cyberCases} case${counts.cyberCases === 1 ? '' : 's'}`}
          tone={counts.cyberRecent === 'nominal' ? 'default' : 'cyber'}
          onClick={() => runtime.setView('cyber')}
          title="Cyber events above informational level since start, and cyber cases."
        />
        <Metric group="platform" label="Simulation" value={running ? `×${speed}` : 'Paused'} tone={running ? 'muted' : 'advisory'} title="Simulation speed" />
        <Metric
          group="platform"
          label="Pipeline"
          value={health.state === 'nominal' ? 'OK' : health.state === 'degraded' ? 'Degraded' : 'Fault'}
          tone={health.state === 'nominal' ? 'muted' : health.state === 'degraded' ? 'warning' : 'critical'}
          title={`Vanterra software only: ${health.fps} fps rendering, ${health.batchMs.toFixed(2)} ms per telemetry batch. ${health.notes}. This says nothing about the plant.`}
        />
        <Metric
          group="platform"
          label="AI"
          value={!ai.checked ? 'Checking' : ai.available ? (ai.testDouble ? 'Test double' : 'Ready') : 'Off'}
          tone={ai.available && ai.testDouble ? 'advisory' : 'muted'}
          title={ai.available ? `AI investigation through ${ai.provider}${ai.testDouble ? ' (scripted test double, not a model)' : ''}.` : `${ai.reason ?? ''} Detection, correlation and the deterministic investigation do not depend on it.`}
        />
      </div>

      <button type="button" className="btn btn--ghost topbar__demo" onClick={() => runtime.showWelcome()} title="Guided demonstration">
        Demo
      </button>
      <div className="clock" title="Simulated plant time (UTC)">
        <span className="clock__time">{formatClock(clock)}</span>
        <span className="clock__date">{formatDate(clock)} UTC</span>
      </div>
      {view === 'spatial' ? (
        <button type="button" className="icon-button topbar__inspector" onClick={() => runtime.togglePanel('rightOpen')} aria-label="Toggle inspector panel" title="Inspector">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M2.5 2.5h11v11h-11zM9.5 2.5v11" stroke="currentColor" strokeWidth="1.3" fill="none" />
          </svg>
        </button>
      ) : null}
    </header>
  );
}
