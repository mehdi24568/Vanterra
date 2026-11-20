/**
 * Cyber-physical assessment - deterministic.
 *
 * For a physical incident: is there cyber evidence that relates to it, and what does
 * that evidence support? For a cyber case: did anything physical follow?
 *
 * Rules of evidence enforced here:
 *  - A cyber event relates to an incident only through a declared relationship: the
 *    controller it touched controls the incident's origin candidate. Time alone is
 *    never a link.
 *  - A change can explain a physical deviation only if it came first, within a
 *    plausible lag, and the deviation matches what that parameter is declared to
 *    move. Even then the assessment says nothing about intent.
 *  - Independent evidence of an equipment fault (a trip, high vibration) keeps the
 *    physical explanation open.
 *  - What is not known is listed, every time.
 */
import type { Anomaly, Incident } from '../core/types';
import type { CyberEngine } from './CyberEngine';
import type { CyberCase, CyberEvent } from './types';

export type CpStanding =
  | 'physical_supported'
  | 'control_change_supported'
  | 'authorized_change_supported'
  | 'possible_relationship'
  | 'correlated_not_causal'
  | 'multiple_plausible'
  | 'insufficient_evidence';

export const STANDING_TEXT: Record<CpStanding, string> = {
  physical_supported: 'Evidence supports a physical explanation. No cyber evidence relates to the affected equipment.',
  control_change_supported:
    'Evidence supports an unapproved control-system change as the cause of the physical deviation. Whether the change was malicious is not established.',
  authorized_change_supported: 'Evidence supports an approved configuration change as the cause of the physical deviation. Whether its effect was intended is not established.',
  possible_relationship: 'Cyber activity reached a controller of the affected equipment, but no change is recorded. A relationship is possible; the evidence is insufficient.',
  correlated_not_causal: 'Cyber events occurred close in time but have no declared relationship to the affected equipment. They are correlated; causality is not established.',
  multiple_plausible: 'A configuration change and an independent equipment fault both fit the evidence. Multiple explanations remain plausible.',
  insufficient_evidence: 'There is not enough evidence to reach a meaningful conclusion.',
};

export interface CpCriterion {
  description: string;
  observed: boolean;
  evidence: string[];
}

export interface CpExplanation {
  key: 'equipment' | 'control_change' | 'authorized_change' | 'unrelated_cyber';
  title: string;
  status: 'supported' | 'possible' | 'not_supported';
  criteria: CpCriterion[];
}

export interface CpLink {
  eventId: string;
  relation: string;
  /** Seconds from the event to the physical onset; positive = event came first. */
  leadS: number;
}

export interface CyberPhysicalAssessment {
  incidentId: string;
  standing: CpStanding;
  headline: string;
  onsetT: number;
  /** Cyber events considered (in the time window). */
  consideredEventIds: string[];
  /** Events with a declared relationship to the incident's origin candidates. */
  links: CpLink[];
  explanations: CpExplanation[];
  unknowns: string[];
  nextSteps: string[];
}

const WINDOW_BEFORE_MS = 30 * 60_000;
const MAX_LEAD_S = 600;
/** A change logged up to this long after the first detection is still treated as "before" (detection latency). */
const LATENCY_S = 2;

function directionMatches(a: Anomaly, expected: 'low' | 'high'): boolean {
  return expected === 'low' ? a.direction === 'low' || a.direction === 'falling' : a.direction === 'high' || a.direction === 'rising';
}

export function originCandidates(inc: Incident): string[] {
  if (!inc.origin) return inc.assets.slice(0, 1).map((a) => a.assetId);
  const top = inc.origin.score;
  return [inc.origin.assetId, ...inc.originAlternatives.filter((o) => o.score >= top - 0.1).map((o) => o.assetId)];
}

export function assessCyberPhysical(inc: Incident, anomalies: Anomaly[], cyber: CyberEngine, now: number): CyberPhysicalAssessment {
  const mine = anomalies.filter((a) => inc.anomalyIds.includes(a.id));
  const onsetT = mine.length ? Math.min(...mine.map((a) => a.startedAt)) : inc.openedAt;
  const origins = originCandidates(inc);
  const controllers = new Set(origins.flatMap((a) => cyber.controllersOf(a)));
  const considered = cyber.events.filter((e) => e.t >= onsetT - WINDOW_BEFORE_MS && e.t <= now);
  const notable = considered.filter((e) => e.severity !== 'info');

  // Declared relationships only: an event touching a controller of an origin candidate.
  const links: CpLink[] = [];
  for (const e of considered) {
    const plc = e.deviceIds.find((d) => controllers.has(d));
    if (!plc) continue;
    const assets = cyber.controlledBy(plc, 'controls').filter((a) => origins.includes(a));
    links.push({ eventId: e.id, relation: `${plc} controls ${assets.join(', ')}`, leadS: Math.round((onsetT - e.t) / 1000) });
  }
  const linked = links.map((l) => cyber.event(l.eventId)!);

  // Change events on a controller of the origin, with their timing and signature.
  const changes = linked
    .filter((e) => e.ruleId === 'UNAPPROVED-CHANGE' || e.ruleId === 'APPROVED-CHANGE')
    .map((e) => {
      const param = cyber.model.parameters.find((p) => p.id === e.parameterId);
      const leadS = (onsetT - e.t) / 1000;
      const precedes = leadS >= -LATENCY_S && leadS <= MAX_LEAD_S;
      const decreased = typeof e.evidence.newValue === 'number' && typeof e.evidence.oldValue === 'number' && e.evidence.newValue < e.evidence.oldValue;
      const expected = (param?.expectedSignals ?? []).map((s) => ({ ...s, dir: decreased ? s.whenDecreased : s.whenDecreased === 'low' ? ('high' as const) : ('low' as const) }));
      const matched = expected.filter((s) => mine.some((a) => a.signalId === s.signalId && directionMatches(a, s.dir)));
      const affectsOrigin = !!param && param.affects.some((a) => origins.includes(a));
      const signature = expected.length > 0 && matched.length >= Math.min(2, expected.length);
      return { e, param, leadS, precedes, affectsOrigin, expected, matched, signature };
    });
  const best = changes.filter((c) => c.affectsOrigin).sort((a, b) => Number(b.precedes && b.signature) - Number(a.precedes && a.signature) || Math.abs(a.leadS) - Math.abs(b.leadS))[0];
  const consistent = !!best && best.precedes && best.signature;

  // Independent evidence of an equipment fault on the origin candidates.
  const faultSigns = mine.filter(
    (a) => origins.includes(a.assetId) && ((a.signalId.endsWith('.STATUS') && directionMatches(a, 'high')) || (a.measurementType === 'vibration' && directionMatches(a, 'high'))),
  );
  const lead = inc.hypotheses[0];
  const physicalStrong = !!lead && (lead.band === 'strong' || lead.band === 'moderate');

  // Access (not change) to a controller of the origin before onset.
  const access = linked.filter((e) => e.ruleId !== 'UNAPPROVED-CHANGE' && e.ruleId !== 'APPROVED-CHANGE' && (onsetT - e.t) / 1000 >= -LATENCY_S);
  const coincident = notable.filter((e) => !links.some((l) => l.eventId === e.id) && Math.abs(e.t - onsetT) <= 120_000);

  // An approved change that explains the onset does not excuse a later unapproved change
  // to the same setting during the incident: that change deepened the deviation and must
  // not be hidden behind the approval. (Found by the independent evaluation, IND-05.)
  const escalation =
    consistent && best.e.ruleId === 'APPROVED-CHANGE'
      ? changes.find((c) => c.e.ruleId === 'UNAPPROVED-CHANGE' && c.affectsOrigin && c.e.parameterId === best.e.parameterId && c.e.t > best.e.t)
      : undefined;
  const sameDirection =
    !!escalation &&
    typeof escalation.e.evidence.newValue === 'number' &&
    typeof best?.e.evidence.newValue === 'number' &&
    typeof best?.e.evidence.oldValue === 'number' &&
    Math.sign(escalation.e.evidence.newValue - best.e.evidence.newValue) === Math.sign(best.e.evidence.newValue - best.e.evidence.oldValue);

  let standing: CpStanding;
  if (consistent && faultSigns.length > 0) standing = 'multiple_plausible';
  else if (escalation && sameDirection) standing = 'control_change_supported';
  else if (consistent) standing = best.e.ruleId === 'APPROVED-CHANGE' ? 'authorized_change_supported' : 'control_change_supported';
  else if (access.length > 0) standing = 'possible_relationship';
  else if (coincident.length > 0) standing = 'correlated_not_causal';
  else if (physicalStrong) standing = 'physical_supported';
  else standing = 'insufficient_evidence';

  const anomalyIds = (pred: (a: Anomaly) => boolean) => mine.filter(pred).map((a) => a.id);
  const explanations: CpExplanation[] = [];

  explanations.push({
    key: 'equipment',
    title: best ? 'Equipment fault, independent of any configuration change' : lead ? `Equipment or process cause: ${lead.title}` : 'Equipment or process cause',
    status: consistent && faultSigns.length === 0 ? 'not_supported' : physicalStrong ? (consistent ? 'possible' : 'supported') : 'possible',
    criteria: [
      {
        description: lead
          ? `Physical mechanism from the rule-based engine: ${lead.title} (${lead.band} evidence support)${best ? '. A commanded change would produce the same mechanism; the explanations differ in what started it.' : ''}`
          : 'No rule-based physical mechanism matched',
        observed: physicalStrong,
        evidence: lead ? lead.criteria.filter((c) => c.state === 'observed').flatMap((c) => c.anomalyIds).slice(0, 6) : [],
      },
      { description: 'A trip or high vibration on the origin equipment (independent sign of an equipment fault)', observed: faultSigns.length > 0, evidence: faultSigns.map((a) => a.id) },
      { description: 'No configuration change explains the deviation', observed: !consistent, evidence: best ? [best.e.id] : [] },
    ],
  });

  if (best) {
    const approved = best.e.ruleId === 'APPROVED-CHANGE';
    const criteria: CpCriterion[] = [
      { description: `${best.e.deviceIds.find((d) => controllers.has(d))} controls the origin equipment (declared relationship)`, observed: true, evidence: [best.e.id] },
      { description: `Parameter ${best.param?.name ?? best.e.parameterId} is declared to act on ${best.param?.affects.join(', ') ?? '—'}`, observed: best.affectsOrigin, evidence: [best.e.id] },
      {
        description: `The change preceded the first detection (${best.leadS >= 0 ? `${Math.round(best.leadS)} s before` : `${Math.round(-best.leadS)} s after`}, plausible lag ≤ ${MAX_LEAD_S} s)`,
        observed: best.precedes,
        evidence: [best.e.id, ...(mine.length ? [mine.reduce((x, y) => (x.startedAt <= y.startedAt ? x : y)).id] : [])],
      },
      {
        description: `Observed deviation matches the parameter's expected signature (${best.matched.length} of ${best.expected.length} expected signals)`,
        observed: best.signature,
        evidence: anomalyIds((a) => best.matched.some((m) => m.signalId === a.signalId)),
      },
      { description: 'No trip or high vibration contradicts a commanded change', observed: faultSigns.length === 0, evidence: faultSigns.map((a) => a.id) },
    ];
    explanations.push({
      key: approved ? 'authorized_change' : 'control_change',
      title: approved ? `Approved configuration change (${best.e.changeRecordId}) on ${best.e.destination}` : `Unapproved configuration change on ${best.e.destination}`,
      status: consistent ? (faultSigns.length > 0 ? 'possible' : 'supported') : best.precedes ? 'possible' : 'not_supported',
      criteria,
    });
  }

  if (escalation && best) {
    const plc = escalation.e.deviceIds.find((d) => controllers.has(d));
    explanations.push({
      key: 'control_change',
      title: `Unapproved change on ${escalation.e.destination} during the incident, after the approved change`,
      status: sameDirection && faultSigns.length === 0 ? 'supported' : 'possible',
      criteria: [
        { description: `${plc} controls the origin equipment (declared relationship)`, observed: true, evidence: [escalation.e.id] },
        { description: `Same setting as the approved change (${escalation.param?.name ?? escalation.e.parameterId})`, observed: true, evidence: [escalation.e.id, best.e.id] },
        {
          description: `Made ${Math.round((escalation.e.t - best.e.t) / 1000)} s after the approved change, ${Math.round(-escalation.leadS)} s after the first detection: it cannot have started the deviation, but it acts on it`,
          observed: true,
          evidence: [escalation.e.id],
        },
        {
          description: `Moves the setting further in the same direction (${String(best.e.evidence.newValue)} → ${String(escalation.e.evidence.newValue)}), outside what the change record approved`,
          observed: sameDirection,
          evidence: [escalation.e.id],
        },
        { description: 'No trip or high vibration contradicts a commanded change', observed: faultSigns.length === 0, evidence: faultSigns.map((a) => a.id) },
      ],
    });
  }

  if (notable.length > 0 || access.length > 0) {
    const unlinked = notable.filter((e) => !links.some((l) => l.eventId === e.id));
    explanations.push({
      key: 'unrelated_cyber',
      title: 'Cyber activity unrelated to this incident',
      status: links.length === 0 ? 'supported' : consistent ? 'not_supported' : 'possible',
      criteria: [
        { description: 'Cyber events in the investigation window without a declared relationship to the origin equipment', observed: unlinked.length > 0, evidence: unlinked.map((e) => e.id).slice(0, 8) },
        { description: 'No event touched a controller of the origin equipment', observed: links.length === 0, evidence: links.map((l) => l.eventId) },
      ],
    });
  }

  const unknowns = [
    'Sensor validity is assumed: no redundant instruments are modelled, so a sensor fault cannot be excluded from telemetry alone.',
    'Flow records summarise traffic; packet content is not captured.',
  ];
  if (linked.some((e) => e.identity)) unknowns.push(`Who operated ${[...new Set(linked.map((e) => e.identity).filter(Boolean))].join(', ')} is not established by the account name.`);
  if (controllers.size > 0 && linked.length > 0) unknowns.push(`The program on ${[...controllers].join(', ')} has not been compared with a known-good copy.`);
  if (considered.length === 0) unknowns.push('No cyber events were recorded in the window. This covers only the simulated sensor and audit sources; absence of evidence is not evidence of absence.');

  const nextSteps: string[] = [];
  const plc = best?.e.destination ?? [...controllers][0];
  if (standing === 'control_change_supported' && best) {
    const cause = escalation && sameDirection ? escalation : best;
    nextSteps.push(`Confirm with the account owner whether the ${cause.e.identity} session that changed ${plc} was theirs${cause === escalation ? ', and why the setting went beyond the approved range' : ''}.`);
    nextSteps.push(`Compare ${plc} settings and program with the last approved configuration.`);
    nextSteps.push('Preserve engineering-workstation and jump-host logs before anything is restored.');
    nextSteps.push(`Decide, through change control, whether to restore ${cause.param?.name ?? 'the setting'}. Vanterra does not change equipment.`);
  } else if (standing === 'authorized_change_supported' && best) {
    nextSteps.push(`Confirm with the owner of ${best.e.changeRecordId} that this physical effect was expected.`);
    nextSteps.push('Decide, through change control, whether the new setting should stay.');
  } else if (standing === 'multiple_plausible') {
    nextSteps.push('Inspect the equipment for the fault signs, and in parallel verify the configuration change with its author.');
  } else if (standing === 'possible_relationship') {
    nextSteps.push(`Review the session that reached ${plc} and compare its program with a known-good copy.`);
    nextSteps.push('Continue the physical checks; nothing yet links the access to the deviation.');
  } else if (standing === 'correlated_not_causal') {
    nextSteps.push('Investigate the cyber case on its own; do not treat it as the cause of this incident without a relationship.');
  }
  if (standing !== 'control_change_supported' && standing !== 'authorized_change_supported') nextSteps.push('Follow the rule-based physical checks for this incident.');

  return {
    incidentId: inc.id,
    standing,
    headline:
      escalation && sameDirection && standing === 'control_change_supported'
        ? 'An approved change started the deviation, and a later unapproved change to the same setting deepened it. Evidence supports an unapproved control-system change as a contributing cause. Whether it was malicious is not established.'
        : STANDING_TEXT[standing],
    onsetT,
    consideredEventIds: considered.map((e) => e.id),
    links,
    explanations,
    unknowns,
    nextSteps,
  };
}

// ------------------------------------------------------------------ cyber cases

export interface CaseAssessment {
  caseId: string;
  /** Physical assets controlled by controllers this case touched (potential impact, not observed impact). */
  potentialImpact: { plcId: string; assets: string[] }[];
  /** Incidents whose origin equipment is controlled by a touched controller. */
  relatedIncidents: string[];
  physicalEffectObserved: boolean;
  summary: string;
  unknowns: string[];
}

export function assessCase(c: CyberCase, events: CyberEvent[], incidents: Incident[], cyber: CyberEngine): CaseAssessment {
  const plcs = c.deviceIds.filter((d) => cyber.device(d)?.kind === 'plc');
  const potentialImpact = plcs.map((plcId) => ({ plcId, assets: cyber.controlledBy(plcId, 'controls') }));
  const reachable = new Set(potentialImpact.flatMap((p) => p.assets));
  const related = incidents.filter((i) => i.status !== 'resolved' && originCandidates(i).some((a) => reachable.has(a)) && i.openedAt >= c.openedAt - 60_000);
  const changed = events.some((e) => e.ruleId === 'UNAPPROVED-CHANGE' || e.ruleId === 'APPROVED-CHANGE');
  const summary =
    plcs.length === 0
      ? 'No controller was touched. The activity stayed in the IT-facing and supervisory zones.'
      : related.length > 0
        ? `A physical incident on equipment controlled by ${plcs.join(', ')} followed: ${related.map((i) => i.id).join(', ')}. See its cyber-physical assessment for what the evidence supports.`
        : `${plcs.join(', ')} ${changed ? 'was changed' : 'was accessed'}, but no physical deviation has been detected on the equipment it controls.`;
  return {
    caseId: c.id,
    potentialImpact,
    relatedIncidents: related.map((i) => i.id),
    physicalEffectObserved: related.length > 0,
    summary,
    unknowns: [
      'Account names do not establish who was acting.',
      'Flow records summarise traffic; packet content is not captured.',
      ...(plcs.length ? [`The program on ${plcs.join(', ')} has not been compared with a known-good copy.`] : []),
    ],
  };
}
