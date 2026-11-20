/**
 * Builds the investigation context for one incident from the live engines.
 * Runs in the browser (where the engines live); the result is plain JSON.
 */
import { formatClock } from '../core/format';
import type { Anomaly, Incident, SignalDefinition } from '../core/types';
import { describePath } from '../intelligence/IntelligenceEngine';
import type { AtlasCore } from '../runtime/AtlasCore';
import type { InvestigationContext } from './context';

const round = (x: number, digits = 3) => {
  const k = 10 ** digits;
  return Math.round(x * k) / k;
};

function limitsText(def: SignalDefinition): string {
  const l = def.limits;
  if (!l) return '';
  return [
    l.lowAlarm !== undefined ? `LL ${l.lowAlarm}` : null,
    l.lowWarn !== undefined ? `L ${l.lowWarn}` : null,
    l.highWarn !== undefined ? `H ${l.highWarn}` : null,
    l.highAlarm !== undefined ? `HH ${l.highAlarm}` : null,
  ]
    .filter(Boolean)
    .join(' / ');
}

export function buildInvestigationContext(core: AtlasCore, incident: Incident): InvestigationContext {
  const anomalies = incident.anomalyIds
    .map((id) => core.intelligence.anomaly(id))
    .filter((a): a is Anomaly => !!a)
    .sort((a, b) => a.startedAt - b.startedAt);
  const t0 = anomalies.length ? anomalies[0].startedAt : incident.openedAt;
  const onset = (t: number) => Math.round((t - t0) / 1000);

  // --- assets: affected, exposed, and anything the hypotheses or paths refer to
  const role = new Map<string, 'affected' | 'at_risk' | 'context'>();
  for (const a of incident.assets) role.set(a.assetId, 'affected');
  for (const i of incident.impact) if (i.state === 'at_risk' && !role.has(i.assetId)) role.set(i.assetId, 'at_risk');
  const referencedSignals = new Set<string>();
  for (const h of incident.hypotheses) for (const c of h.criteria) for (const s of c.signalIds) referencedSignals.add(s);
  const touch = (assetId: string) => {
    if (core.graph.asset(assetId) && !role.has(assetId)) role.set(assetId, 'context');
  };
  for (const s of referencedSignals) touch(s.slice(0, s.indexOf('.')));
  for (const step of [...incident.correlations.flatMap((c) => c.path), ...incident.impact.flatMap((i) => i.path)]) {
    touch(step.from);
    touch(step.to);
  }
  if (incident.origin) touch(incident.origin.assetId);

  const firstOnset = new Map(incident.assets.map((a) => [a.assetId, a.firstOnset]));
  const assets = [...role.entries()].slice(0, 64).map(([id, r]) => {
    const def = core.graph.asset(id)!;
    return {
      id,
      name: def.name,
      category: def.category,
      area: def.area,
      role: r,
      operatingState: core.operatingState(id),
      health: core.healthOf(id),
      firstOnsetS: firstOnset.has(id) ? onset(firstOnset.get(id)!) : null,
    };
  });
  const assetIds = new Set(assets.map((a) => a.id));

  // --- signals: affected assets first, then what the hypotheses cite, then exposed assets
  const activeSignals = new Set<string>();
  for (const a of core.anomalies.active()) for (const s of a.signalIds) activeSignals.add(s);
  const ordered: SignalDefinition[] = [];
  const push = (def: SignalDefinition | undefined) => {
    if (def && def.role === 'measurement' && !ordered.includes(def)) ordered.push(def);
  };
  for (const a of assets.filter((x) => x.role === 'affected')) core.graph.asset(a.id)!.signals.forEach(push);
  for (const id of referencedSignals) push(core.telemetry.signal(id));
  for (const a of assets.filter((x) => x.role !== 'affected')) core.graph.asset(a.id)!.signals.forEach(push);
  const signals = ordered.slice(0, 120).map((def) => {
    const b = core.anomalies.baseline(def.id);
    const latest = core.telemetry.latest(def.id);
    const analysed = def.detect.baseline || !!def.limits;
    const ready = !!b?.ready && def.detect.baseline;
    return {
      id: def.id,
      assetId: def.assetId,
      name: def.name,
      unit: def.unit,
      latest: latest === undefined ? null : round(latest),
      baselineMean: ready ? round(b!.mean) : null,
      baselineStd: ready ? round(b!.std) : null,
      zScore: ready ? round(core.anomalies.zScore(def.id), 1) : null,
      state: activeSignals.has(def.id)
        ? ('abnormal' as const)
        : !analysed
          ? ('not_analysed' as const)
          : def.detect.baseline && !ready
            ? ('learning' as const)
            : ('normal' as const),
      limits: limitsText(def),
    };
  });

  // One correlation explanation per asset: the link recorded when it first joined.
  const correlations = incident.assets
    .map((ia) => incident.correlations.find((c) => c.assetId === ia.assetId && c.basis !== 'same_asset') ?? incident.correlations.find((c) => c.assetId === ia.assetId))
    .filter((c): c is NonNullable<typeof c> => !!c)
    .map((c) => ({
      assetId: c.assetId,
      linkedAssetId: c.linkedAssetId,
      basis: c.basis,
      hops: c.hops,
      lagS: c.lagS,
      path: describePath(c.path),
    }));

  return {
    schemaVersion: 1,
    generatedAt: `${formatClock(core.now)} plant time`,
    facility: { name: core.facility.name, dataSource: core.adapter.label },
    incident: {
      id: incident.id,
      revision: incident.revision,
      status: incident.status,
      severity: incident.severity,
      title: incident.title,
      openedAt: formatClock(incident.openedAt),
      ageS: Math.round((core.now - incident.openedAt) / 1000),
      activeAnomalies: anomalies.filter((a) => a.status === 'active').length,
      assessmentFrozen: incident.assessmentFrozen ? incident.assessmentFrozen.reason : null,
    },
    assets,
    anomalies: anomalies.slice(0, 80).map((a) => ({
      id: a.id,
      assetId: a.assetId,
      signalId: a.signalId,
      kind: a.kind,
      direction: a.direction,
      severity: a.severity,
      status: a.status,
      onsetS: onset(a.startedAt),
      detector: a.detector,
      rule: a.rule,
      unit: a.unit,
      valueAtDetection: round(a.observed.valueAtOpen),
      latest: round(a.observed.value),
      peak: round(a.observed.peak),
      baselineMean: a.observed.baselineMean === undefined ? null : round(a.observed.baselineMean),
      baselineStd: a.observed.baselineStd === undefined ? null : round(a.observed.baselineStd),
    })),
    signals,
    relations: core.graph.relations
      .filter((r) => assetIds.has(r.from) && assetIds.has(r.to))
      .slice(0, 80)
      .map((r) => ({ id: r.id, from: r.from, to: r.to, type: r.type, medium: r.medium })),
    correlations,
    origin: incident.origin
      ? {
          assetId: incident.origin.assetId,
          score: round(incident.origin.score, 2),
          rationale: incident.origin.rationale,
          alternatives: incident.originAlternatives.map((o) => ({ assetId: o.assetId, score: round(o.score, 2) })),
        }
      : null,
    hypotheses: incident.hypotheses.slice(0, 12).map((h) => ({
      key: h.key,
      title: h.title,
      focalAssetId: h.focalAssetId,
      mechanism: h.mechanism,
      supportPct: Math.round(h.support * 100),
      band: h.band,
      criteria: h.criteria.map((c) => ({
        id: c.id,
        role: c.role,
        description: c.description,
        weight: c.weight,
        observed: c.state === 'observed',
        detail: c.detail,
        anomalyIds: c.anomalyIds,
        signalIds: c.signalIds,
      })),
      unknowns: h.unknowns,
      verification: h.verification,
    })),
    impact: incident.impact.slice(0, 64).map((i) => ({
      assetId: i.assetId,
      state: i.state,
      exposurePct: Math.round(i.exposure * 100),
      hops: i.hops,
      path: describePath(i.path),
    })),
    deterministicChecks: incident.recommendations.slice(0, 16).map((r) => r.text),
    cyber: cyberContext(core, incident, t0),
  };
}

function cyberContext(core: AtlasCore, incident: Incident, t0: number): InvestigationContext['cyber'] {
  const cyber = core.cyber;
  const a = core.assessIncident(incident.id);
  if (!cyber || !a) return null;
  // Linked events first, then the rest of the window, bounded.
  const linked = new Set(a.links.map((l) => l.eventId));
  const ids = [...a.consideredEventIds].sort((x, y) => Number(linked.has(y)) - Number(linked.has(x))).slice(0, 40);
  const events = ids.map((id) => cyber.event(id)!).filter(Boolean);
  const deviceIds = new Set(events.flatMap((e) => e.deviceIds));
  for (const assetId of incident.origin ? [incident.origin.assetId] : []) for (const plc of cyber.controllersOf(assetId)) deviceIds.add(plc);
  return {
    standing: a.standing,
    headline: a.headline,
    links: a.links,
    explanations: a.explanations,
    unknowns: a.unknowns,
    events: events.map((e) => ({
      id: e.id,
      onsetS: Math.round((e.t - t0) / 1000),
      ruleId: e.ruleId,
      category: e.category,
      severity: e.severity,
      title: e.title,
      source: e.source,
      destination: e.destination,
      identity: e.identity,
      deviceIds: e.deviceIds,
      parameterId: e.parameterId,
      changeRecordId: e.changeRecordId,
      rationale: e.rationale,
      attackContext: e.attack.map((t) => `${t.techniqueId} ${t.name}`),
    })),
    devices: [...deviceIds].slice(0, 24).map((id) => {
      const d = cyber.device(id)!;
      return { id, name: d.name, kind: d.kind, zone: d.zoneId, controls: d.kind === 'plc' ? cyber.controlledBy(id, 'controls') : [] };
    }),
  };
}
