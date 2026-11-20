/**
 * Cyber & OT view: the simulated OT network by zone, cyber cases, the event feed,
 * and a detail pane for whatever is selected (event, case or device).
 */
import { useState } from 'react';
import { formatClock } from '../core/format';
import type { Severity } from '../core/types';
import type { OtDevice, ZoneLevel } from '../cyber/types';
import { useRuntime, useUi } from './context';
import { CaseDetail, DeviceDetail, EvidenceId, EventDetail, SevChip } from './cyber';

const LEVEL_ORDER: ZoneLevel[] = ['L4', 'DMZ', 'L3', 'L2', 'L1'];
const BAND_H = 74;
const MAP_W = 640;

function ZoneMap({ selected }: { selected: string | null }) {
  const runtime = useRuntime();
  const cyber = runtime.core.cyber!;
  const model = cyber.model;
  const zones = [...model.zones].sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
  const pos = new Map<string, { x: number; y: number; w: number }>();
  zones.forEach((z, zi) => {
    const devs = model.devices.filter((d) => d.zoneId === z.id);
    const spacing = (MAP_W - 170) / devs.length;
    const w = Math.min(80, spacing - 8);
    devs.forEach((d, di) => pos.set(d.id, { x: 150 + (di + 0.5) * spacing, y: zi * BAND_H + BAND_H / 2 + 6, w }));
  });
  const sev = (d: OtDevice): Severity | null => runtime.otSeverity(d.id);
  return (
    <svg className="zone-map" viewBox={`0 0 ${MAP_W} ${zones.length * BAND_H + 12}`} role="img" aria-label="OT network by zone">
      {zones.map((z, zi) => (
        <g key={z.id}>
          <rect x={4} y={zi * BAND_H + 6} width={MAP_W - 8} height={BAND_H - 4} className={`zone-map__band zone-map__band--${z.level}`} rx={4} />
          <text x={14} y={zi * BAND_H + 28} className="zone-map__zone">
            {z.level === 'DMZ' ? 'DMZ' : `Level ${z.level.slice(1)}`}
          </text>
          <text x={14} y={zi * BAND_H + 44} className="zone-map__zname">
            {z.name}
          </text>
          <text x={14} y={zi * BAND_H + 58} className="zone-map__subnet">
            {z.subnet}
          </text>
        </g>
      ))}
      {model.links.map((l) => {
        const a = pos.get(l.from);
        const b = pos.get(l.to);
        if (!a || !b) return null;
        return <line key={`${l.from}-${l.to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="zone-map__link" />;
      })}
      {model.devices.map((d) => {
        const p = pos.get(d.id)!;
        const s = sev(d);
        return (
          <g
            key={d.id}
            className={`zone-map__dev${s ? ` is-${s}` : ''}${selected === d.id ? ' is-selected' : ''}`}
            transform={`translate(${p.x - p.w / 2}, ${p.y - 16})`}
            onClick={() => runtime.selectCyber(d.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && runtime.selectCyber(d.id)}
            aria-label={`${d.id} ${d.name}`}
          >
            <rect width={p.w} height={32} rx={3} />
            <text x={p.w / 2} y={14} className="zone-map__id">
              {d.id}
            </text>
            <text x={p.w / 2} y={26} className="zone-map__kind">
              {d.kind.replace('_', ' ')}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

type Filter = 'notable' | 'all';

export function CyberPage() {
  const runtime = useRuntime();
  useUi((s) => s.cyberKey);
  useUi((s) => s.clock);
  const selected = useUi((s) => s.selectedCyberId);
  const [filter, setFilter] = useState<Filter>('notable');
  const cyber = runtime.core.cyber;
  if (!cyber) {
    return (
      <main className="page">
        <p className="empty">This data source provides no OT security telemetry.</p>
      </main>
    );
  }
  const events = [...cyber.events].reverse().filter((e) => filter === 'all' || e.severity !== 'info');
  const cases = [...cyber.cases].reverse();
  const event = selected ? cyber.event(selected) : undefined;

  return (
    <main className="page page--cyber" aria-label="Cyber and OT">
      <header className="page__head">
        <div>
          <h1 className="page__title">Cyber &amp; OT</h1>
          <p className="page__sub">
            Simulated OT network of {runtime.facility.name}: {cyber.model.devices.length} devices in {cyber.model.zones.length} zones, {cyber.model.conduits.length} permitted conduits. Events come from simulated
            authentication, flow and controller-audit records, detected by five rules.
          </p>
        </div>
      </header>

      <div className="cyber-grid">
        <section className="pane pane--map">
          <h2 className="pane__title">Network zones</h2>
          <ZoneMap selected={selected} />
          <div className="conduits">
            <span className="muted">Permitted conduits:</span>
            {cyber.model.conduits.map((c) => (
              <span key={c.id} className="conduit" title={c.description}>
                {c.fromZone.replace('Z-', '')} → {c.toZone.replace('Z-', '')} · {c.protocols.join(', ')}
              </span>
            ))}
          </div>
        </section>

        <section className="pane pane--feed">
          <h2 className="pane__title">
            Cases <span className="count">{cases.length}</span>
          </h2>
          {cases.length === 0 ? (
            <p className="empty">No cyber cases. Related warning-level events would be grouped here.</p>
          ) : (
            <ul className="rows">
              {cases.map((c) => (
                <li key={c.id}>
                  <button type="button" className={`row${selected === c.id ? ' is-selected' : ''}`} onClick={() => runtime.selectCyber(c.id)}>
                    <SevChip severity={c.severity} />
                    <span className="row__id">{c.id}</span>
                    <span className="row__title">{c.title}</span>
                    <span className="row__meta">
                      {c.eventIds.length} events · {formatClock(c.openedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <h2 className="pane__title pane__title--split">
            <span>
              Events <span className="count">{events.length}</span>
            </span>
            <span className="seg">
              <button type="button" className={filter === 'notable' ? 'is-active' : ''} aria-pressed={filter === 'notable'} onClick={() => setFilter('notable')}>
                Notable
              </button>
              <button type="button" className={filter === 'all' ? 'is-active' : ''} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
                All
              </button>
            </span>
          </h2>
          {events.length === 0 ? (
            <p className="empty">{filter === 'notable' ? 'No notable cyber events. Normal polling, historian traffic and shift logons are baseline.' : 'No cyber events yet.'}</p>
          ) : (
            <ul className="rows">
              {events.map((e) => (
                <li key={e.id}>
                  <button type="button" className={`row${selected === e.id ? ' is-selected' : ''}`} onClick={() => runtime.selectCyber(e.id)}>
                    <SevChip severity={e.severity} />
                    <span className="row__id">{e.id}</span>
                    <span className="row__title">{e.title}</span>
                    <span className="row__meta">
                      {e.ruleId} · {formatClock(e.t)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="pane pane--detail" aria-label="Detail">
          {event ? (
            <EventDetail e={event} />
          ) : selected && cyber.caseOf(selected) ? (
            <CaseDetail id={selected} />
          ) : selected && cyber.device(selected) ? (
            <DeviceDetail id={selected} />
          ) : (
            <div className="detail detail--empty">
              <p className="empty">Select a device, case or event.</p>
              <p className="hint">
                Detection here is rule-based and every event lists what it does not show. Whether any of it affected the plant is decided in the incident&apos;s cyber-physical assessment, from
                declared relationships and timing, never from proximity alone.
              </p>
              {cases[0] ? (
                <p>
                  Latest case: <EvidenceId id={cases[0].id} />
                </p>
              ) : null}
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
