/**
 * Shared views for the cyber layer: the cyber-physical assessment shown in the
 * investigation workbench, and the event / case / device detail used by the
 * Cyber & OT view. Everything here is read-only; the operator acts elsewhere.
 */
import type { ReactNode } from 'react';
import { formatClock } from '../core/format';
import type { Incident, Severity } from '../core/types';
import { ATTACK_SOURCE } from '../cyber/attack';
import type { CpExplanation, CpStanding } from '../cyber/assess';
import type { BriefingStatement } from '../cyber/briefing';
import type { CyberEvent } from '../cyber/types';
import { useRuntime, useUi } from './context';
import { AssetLink, Section } from './primitives';

export const STANDING_SHORT: Record<CpStanding, string> = {
  physical_supported: 'Physical explanation supported',
  control_change_supported: 'Control-system change supported',
  authorized_change_supported: 'Approved change supported',
  possible_relationship: 'Possible relationship · insufficient evidence',
  correlated_not_causal: 'Correlated · causality not established',
  multiple_plausible: 'Multiple explanations plausible',
  insufficient_evidence: 'Insufficient evidence',
};

/** Physical, cyber or cyber-physical, from the deterministic assessment only. */
export function domainOf(standing: CpStanding | null): 'physical' | 'cyber-physical' {
  return standing === 'control_change_supported' || standing === 'authorized_change_supported' || standing === 'multiple_plausible' || standing === 'possible_relationship'
    ? 'cyber-physical'
    : 'physical';
}

export function DomainTag({ domain }: { domain: 'physical' | 'cyber' | 'cyber-physical' }) {
  const label = domain === 'physical' ? 'Physical' : domain === 'cyber' ? 'Cyber' : 'Cyber-physical';
  return <span className={`domain domain--${domain}`}>{label}</span>;
}

export function SevChip({ severity }: { severity: Severity | 'info' }) {
  return <span className={`sev sev--${severity}`}>{severity === 'info' ? 'Info' : severity[0].toUpperCase() + severity.slice(1)}</span>;
}

/** Evidence identifier that navigates to what it names. */
export function EvidenceId({ id }: { id: string }) {
  const runtime = useRuntime();
  const anomaly = id.startsWith('ANM-') ? runtime.core.intelligence.anomaly(id) : undefined;
  const isCyber = id.startsWith('CEV-') || id.startsWith('CYB-');
  const onClick = () => {
    if (anomaly) runtime.selectAsset(anomaly.assetId, anomaly.signalId, { fly: true, panel: false });
    else if (isCyber) runtime.selectCyber(id);
  };
  return (
    <button type="button" className={`evid evid--${anomaly ? 'physical' : isCyber ? 'cyber' : 'other'}`} onClick={onClick} title={anomaly ? `${anomaly.signalId}: ${anomaly.message}` : isCyber ? runtime.core.cyber?.event(id)?.title ?? id : id}>
      {id}
    </button>
  );
}

function Explanation({ x }: { x: CpExplanation }) {
  return (
    <li className={`cpx cpx--${x.status}`}>
      <div className="cpx__head">
        <span className="cpx__title">{x.title}</span>
        <span className={`cpx__status cpx__status--${x.status}`}>{x.status === 'supported' ? 'Supported' : x.status === 'possible' ? 'Possible' : 'Not supported'}</span>
      </div>
      <ul className="cpx__criteria">
        {x.criteria.map((c, i) => (
          <li key={i} className={c.observed ? 'is-met' : 'is-unmet'}>
            <span className="cpx__mark" aria-label={c.observed ? 'observed' : 'not observed'}>
              {c.observed ? '✓' : '✕'}
            </span>
            <span className="cpx__desc">{c.description}</span>
            <span className="cpx__ev">
              {c.evidence.slice(0, 5).map((id) => (
                <EvidenceId key={id} id={id} />
              ))}
            </span>
          </li>
        ))}
      </ul>
    </li>
  );
}

/** The workbench tab: what the cyber evidence supports about this physical incident. */
export function CyberPhysicalPanel({ incident }: { incident: Incident }) {
  const runtime = useRuntime();
  useUi((s) => s.cyberKey);
  useUi((s) => s.incidentsKey);
  const otOn = useUi((s) => s.layers.ot);
  const a = runtime.core.assessIncident(incident.id);
  if (!a) {
    return (
      <Section title="Cyber-physical assessment">
        <p className="empty">This data source provides no OT security telemetry, so no cyber-physical assessment is possible.</p>
      </Section>
    );
  }
  const cyber = runtime.core.cyber!;
  return (
    <div className="cp-panel">
      <div className={`standing standing--${a.standing}`}>
        <span className="standing__label">{STANDING_SHORT[a.standing]}</span>
        <p className="standing__text">{a.headline}</p>
        <span className="standing__meta">Deterministic assessment · declared relationships only · no model involved</span>
      </div>

      <PlainBriefing incident={incident} />

      <Section
        title="Relationship to the OT layer"
        aside={
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => runtime.setLayer('ot', !otOn)} aria-pressed={otOn}>
            {otOn ? 'Hide OT layer' : 'Show OT layer in 3D'}
          </button>
        }
      >
        {a.links.length === 0 ? (
          <p className="empty">No cyber event touched a controller of the origin equipment ({cyber.controllersOf(incident.origin?.assetId ?? '').join(', ') || 'none declared'}).</p>
        ) : (
          <ul className="cp-links">
            {a.links.map((l) => {
              const e = cyber.event(l.eventId)!;
              return (
                <li key={l.eventId}>
                  <EvidenceId id={l.eventId} />
                  <span className="cp-links__title">{e.title}</span>
                  <span className="cp-links__rel">{l.relation}</span>
                  <span className="cp-links__lag">{l.leadS >= 0 ? `${l.leadS} s before onset` : `${-l.leadS} s after onset`}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Explanations considered" aside={<span className="muted">{a.consideredEventIds.length} cyber events in window</span>}>
        <ul className="cpx-list">
          {a.explanations.map((x) => (
            <Explanation key={x.key} x={x} />
          ))}
        </ul>
      </Section>

      <Section title="What is not known">
        <ul className="unknowns">
          {a.unknowns.map((u) => (
            <li key={u}>{u}</li>
          ))}
        </ul>
      </Section>

      <Section title="What to investigate next" aside={<span className="muted">recommendations, not actions</span>}>
        <ol className="next-steps">
          {a.nextSteps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </Section>
    </div>
  );
}

/**
 * The assessment above, restated in everyday words for non-specialists. Each statement
 * keeps its evidence one click away; the expert sections below stay unchanged.
 */
function PlainBriefing({ incident }: { incident: Incident }) {
  const runtime = useRuntime();
  const b = runtime.core.briefIncident(incident.id);
  if (!b) return null;
  return (
    <Section title="In plain words" aside={<span className="muted">restates the assessment · no model involved</span>}>
      <div className="brief">
        <p className="brief__short">{b.inShort}</p>
        <div className={`brief__ask brief__ask--${b.cyberInvestigation.answer}`}>
          <span className="brief__q">Should this become a cyber investigation?</span>
          <strong className="brief__a">{b.cyberInvestigation.label}</strong>
          <span className="brief__why">{b.cyberInvestigation.reason}</span>
        </div>
        <BriefList title="What we know for certain" items={b.known} />
        <BriefList title="What the evidence suggests (interpretation, not fact)" items={b.suggests} />
      </div>
    </Section>
  );
}

function BriefList({ title, items }: { title: string; items: BriefingStatement[] }) {
  return (
    <div className="brief__group">
      <h4 className="brief__h">{title}</h4>
      <ul className="brief__list">
        {items.map((s) => (
          <li key={s.text}>
            <span>{s.text}</span>
            {s.evidence.length > 0 && (
              <details className="brief__evidence">
                <summary>Evidence ({s.evidence.length})</summary>
                <span className="brief__ids">
                  {s.evidence.map((id) => (
                    <EvidenceId key={id} id={id} />
                  ))}
                </span>
              </details>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------- detail views

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <span className="field__value">{children}</span>
    </div>
  );
}

function DeviceLink({ id }: { id: string | null }) {
  const runtime = useRuntime();
  if (!id) return <>—</>;
  return (
    <button type="button" className="device-link" onClick={() => runtime.selectCyber(id)}>
      {id}
    </button>
  );
}

/** Incidents whose origin equipment is controlled by one of these controllers. */
function relatedIncidents(runtime: ReturnType<typeof useRuntime>, deviceIds: string[]): Incident[] {
  const cyber = runtime.core.cyber;
  if (!cyber) return [];
  const assets = new Set(deviceIds.flatMap((d) => cyber.controlledBy(d, 'controls')));
  return runtime.core.intelligence.incidents().filter((i) => i.origin && assets.has(i.origin.assetId));
}

export function EventDetail({ e }: { e: CyberEvent }) {
  const runtime = useRuntime();
  const related = relatedIncidents(runtime, e.deviceIds);
  return (
    <div className="detail">
      <header className="detail__head">
        <span className="detail__id">{e.id}</span>
        <SevChip severity={e.severity} />
        <span className="detail__rule">{e.ruleId}</span>
      </header>
      <h2 className="detail__title">{e.title}</h2>
      <p className="detail__text">{e.description}</p>
      <div className="fields">
        <Field label="Time">{formatClock(e.t)}</Field>
        <Field label="Category">{e.category.replace('_', ' ')}</Field>
        <Field label="Source">
          <DeviceLink id={e.source} />
        </Field>
        <Field label="Destination">
          <DeviceLink id={e.destination} />
        </Field>
        <Field label="Account">{e.identity ?? '—'}</Field>
        <Field label="Case">{e.caseId ? <EvidenceId id={e.caseId} /> : 'none'}</Field>
      </div>
      <Section title="Evidence" aside={<span className="muted">record fields that satisfied the rule</span>}>
        <table className="kv">
          <tbody>
            {Object.entries(e.evidence).map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>{v === null ? '—' : String(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="Why this was flagged">
        <p className="detail__text">{e.rationale}</p>
      </Section>
      <Section title="Limitations">
        <ul className="unknowns">
          {e.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </Section>
      {e.attack.length > 0 ? (
        <Section title="Defensive context" aside={<span className="muted">{ATTACK_SOURCE}</span>}>
          <ul className="attack">
            {e.attack.map((t) => (
              <li key={t.techniqueId}>
                <span className="attack__id">{t.techniqueId}</span>
                <span className="attack__name">{t.name}</span>
                <span className="attack__tactic">{t.tactic}</span>
              </li>
            ))}
          </ul>
          <p className="hint">A technique describes what this kind of activity can represent. It is not a finding that an adversary performed it.</p>
        </Section>
      ) : null}
      {related.length > 0 ? (
        <Section title="Physical incidents on equipment this device controls">
          <ul className="plain">
            {related.map((i) => (
              <li key={i.id}>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => runtime.openIncident(i.id, 'cyber')}>
                  {i.id} · open cyber-physical assessment
                </button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

export function CaseDetail({ id }: { id: string }) {
  const runtime = useRuntime();
  const cyber = runtime.core.cyber!;
  const c = cyber.caseOf(id);
  const a = runtime.core.assessCyberCase(id);
  if (!c || !a) return null;
  return (
    <div className="detail">
      <header className="detail__head">
        <span className="detail__id">{c.id}</span>
        <SevChip severity={c.severity} />
        <span className="detail__rule">cyber case</span>
      </header>
      <h2 className="detail__title">{c.title}</h2>
      <div className="fields">
        <Field label="Opened">{formatClock(c.openedAt)}</Field>
        <Field label="Last event">{formatClock(c.lastEventAt)}</Field>
        <Field label="Accounts">{c.identities.join(', ') || '—'}</Field>
        <Field label="Devices">
          {c.deviceIds.map((d) => (
            <DeviceLink key={d} id={d} />
          ))}
        </Field>
      </div>
      <div className={`standing standing--${a.physicalEffectObserved ? 'possible_relationship' : 'insufficient_evidence'}`}>
        <span className="standing__label">{a.physicalEffectObserved ? 'Physical incident followed' : 'No physical effect detected'}</span>
        <p className="standing__text">{a.summary}</p>
        {a.relatedIncidents.map((iid) => (
          <button key={iid} type="button" className="btn btn--ghost btn--sm" onClick={() => runtime.openIncident(iid, 'cyber')}>
            Open {iid} · cyber-physical assessment
          </button>
        ))}
      </div>
      <Section title="Events in this case">
        <ol className="case-events">
          {c.eventIds.map((eid) => {
            const e = cyber.event(eid)!;
            return (
              <li key={eid}>
                <span className="case-events__t">{formatClock(e.t)}</span>
                <EvidenceId id={eid} />
                <SevChip severity={e.severity} />
                <span className="case-events__title">{e.title}</span>
              </li>
            );
          })}
        </ol>
      </Section>
      <Section title="Potential physical impact" aside={<span className="muted">declared control relationships, not observed effects</span>}>
        {a.potentialImpact.length === 0 ? (
          <p className="empty">No controller was touched.</p>
        ) : (
          a.potentialImpact.map((p) => (
            <div key={p.plcId} className="impact-row">
              <DeviceLink id={p.plcId} />
              <span className="muted">controls</span>
              {p.assets.map((asset) => (
                <AssetLink key={asset} id={asset} level={runtime.core.healthOf(asset)} onClick={() => runtime.showInSpace(asset, true)} />
              ))}
            </div>
          ))
        )}
      </Section>
      <Section title="What is not known">
        <ul className="unknowns">
          {a.unknowns.map((u) => (
            <li key={u}>{u}</li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

export function DeviceDetail({ id }: { id: string }) {
  const runtime = useRuntime();
  const cyber = runtime.core.cyber!;
  const d = cyber.device(id);
  if (!d) return null;
  const zone = cyber.model.zones.find((z) => z.id === d.zoneId);
  const controls = cyber.controlledBy(id, 'controls');
  const monitors = cyber.controlledBy(id, 'monitors');
  const params = cyber.model.parameters.filter((p) => p.plcId === id);
  const events = cyber.events.filter((e) => e.deviceIds.includes(id)).slice(-8).reverse();
  return (
    <div className="detail">
      <header className="detail__head">
        <span className="detail__id">{d.id}</span>
        <span className="detail__rule">{d.kind.replace('_', ' ')}</span>
      </header>
      <h2 className="detail__title">{d.name}</h2>
      <p className="detail__text">{d.description}</p>
      <div className="fields">
        <Field label="Zone">
          {zone?.name} ({zone?.level})
        </Field>
        <Field label="Address">{d.address}</Field>
        <Field label="Model">{d.vendorModel}</Field>
      </div>
      {controls.length + monitors.length > 0 ? (
        <Section title="Physical equipment" aside={<span className="muted">declared relationships</span>}>
          {controls.length ? (
            <div className="impact-row">
              <span className="muted">controls</span>
              {controls.map((a) => (
                <AssetLink key={a} id={a} level={runtime.core.healthOf(a)} onClick={() => runtime.showInSpace(a, true)} />
              ))}
            </div>
          ) : null}
          {monitors.length ? (
            <div className="impact-row">
              <span className="muted">monitors</span>
              {monitors.map((a) => (
                <AssetLink key={a} id={a} level={runtime.core.healthOf(a)} onClick={() => runtime.showInSpace(a, true)} />
              ))}
            </div>
          ) : null}
        </Section>
      ) : null}
      {params.length > 0 ? (
        <Section title="Writable parameters">
          <ul className="plain">
            {params.map((p) => (
              <li key={p.id}>
                <strong>{p.name}</strong> <span className="muted">· nominal {p.nominal} {p.unit}</span>
                <div className="hint">{p.description}</div>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section title="Recent events on this device">
        {events.length === 0 ? (
          <p className="empty">None.</p>
        ) : (
          <ol className="case-events">
            {events.map((e) => (
              <li key={e.id}>
                <span className="case-events__t">{formatClock(e.t)}</span>
                <EvidenceId id={e.id} />
                <SevChip severity={e.severity} />
                <span className="case-events__title">{e.title}</span>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </div>
  );
}
