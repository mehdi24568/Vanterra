/**
 * Plain-language briefing.
 *
 * Restates the deterministic cyber-physical assessment for someone who is not an OT or
 * security specialist: an operator, a plant manager, a student. It adds no reasoning of
 * its own. Every sentence is derived from the incident, its detections, the cyber events
 * and the assessment, and carries the evidence IDs it rests on. No model is involved, so
 * it is instant, works offline and cannot invent anything.
 *
 * It answers the questions a non-specialist asks, in this order: what is going on, should
 * this become a cyber investigation, what do we know for certain, what does the evidence
 * suggest (and what does it rule out), what is not known, and what would settle it.
 */
import type { Anomaly, AnomalyDirection, Incident } from '../core/types';
import type { CpExplanation, CpStanding, CyberPhysicalAssessment } from './assess';
import type { CyberEvent } from './types';

export type CyberInvestigationAnswer = 'yes' | 'check' | 'separately' | 'no' | 'not_yet';

export interface BriefingStatement {
  text: string;
  /** Evidence IDs (detections ANM-…, cyber events CEV-…) this statement rests on. */
  evidence: string[];
}

export interface Briefing {
  incidentId: string;
  standing: CpStanding;
  /** One or two sentences in everyday words. */
  inShort: string;
  /** "Should this become a cyber investigation?" A recommendation, not an action. */
  cyberInvestigation: { answer: CyberInvestigationAnswer; label: string; reason: string };
  /** Observations and records: what is known for certain. */
  known: BriefingStatement[];
  /** What the evidence supports, leaves open or does not support. Interpretation, not fact. */
  suggests: BriefingStatement[];
  notKnown: string[];
  toSettle: string[];
}

export interface BriefingLookups {
  assetName(id: string): string | undefined;
  signalName(id: string): string | undefined;
  anomaly(id: string): Anomaly | undefined;
  event(id: string): CyberEvent | undefined;
  parameterName(id: string): string | undefined;
}

const IN_SHORT: Record<CpStanding, string> = {
  physical_supported: 'This looks like an equipment or process problem. Nothing in the security records points to the control system.',
  control_change_supported:
    'A setting was changed through the control system without an approved change record, and the equipment then behaved the way that setting would make it behave. Whether anyone meant harm is not known.',
  authorized_change_supported: 'An approved change to a setting explains what the equipment did. Whether that effect was intended is not known.',
  possible_relationship: 'Someone reached the controller that runs this equipment, but no change is recorded. A connection is possible; the evidence does not show one.',
  correlated_not_causal:
    'Security events happened around the same time, but none of them involves the equipment that has the problem. Happening at the same time does not make them the cause.',
  multiple_plausible: 'Two explanations both fit: a settings change and a separate equipment fault. Both need checking.',
  insufficient_evidence: 'There is not yet enough evidence to say what is causing this.',
};

const CYBER_INVESTIGATION: Record<CpStanding, Briefing['cyberInvestigation']> = {
  control_change_supported: {
    answer: 'yes',
    label: 'Yes: bring in OT security and the control engineer together',
    reason: 'An unapproved change on the controller of this equipment came before the problem and fits the readings.',
  },
  multiple_plausible: {
    answer: 'yes',
    label: 'Yes, alongside an equipment check',
    reason: 'A change on the controller fits the readings, but there are also signs of an independent equipment fault.',
  },
  possible_relationship: {
    answer: 'check',
    label: 'Check with OT security',
    reason: 'Activity reached the controller of this equipment. No change is recorded, so nothing links it to the problem yet.',
  },
  correlated_not_causal: {
    answer: 'separately',
    label: 'Not for this problem: follow up the security events on their own',
    reason: 'The security events have no declared connection to this equipment.',
  },
  authorized_change_supported: {
    answer: 'no',
    label: 'Not a security matter on this evidence: review the approved change with engineering',
    reason: 'The change that explains the readings matches an approved change record.',
  },
  physical_supported: {
    answer: 'no',
    label: 'No: treat it as an equipment or process problem',
    reason: 'No security evidence relates to this equipment. That is absence of evidence, not proof that nothing happened.',
  },
  insufficient_evidence: {
    answer: 'not_yet',
    label: 'Not decided yet',
    reason: 'Collect the evidence listed under "What would settle it" first.',
  },
};

const DIRECTION: Record<AnomalyDirection, string> = {
  high: 'went above its normal range',
  low: 'went below its normal range',
  rising: 'started rising faster than normal',
  falling: 'started falling faster than normal',
  unstable: 'became unstable',
};

const SUGGESTS: Record<CpExplanation['key'], Record<CpExplanation['status'], string>> = {
  equipment: {
    supported: 'The evidence supports an equipment or process fault.',
    possible: 'An equipment or process fault remains possible.',
    not_supported: 'The evidence does not point to an independent equipment fault: the change explains the readings, and there are no fault signs such as a trip or high vibration.',
  },
  control_change: {
    supported: 'The evidence supports a settings change made through the control system as the cause: it came first, it acts on this equipment, and the readings moved the way that setting moves them.',
    possible: 'A settings change made through the control system may be involved, but not every condition for linking it is met.',
    not_supported: 'The evidence does not support an unapproved settings change as the cause.',
  },
  authorized_change: {
    supported: 'The evidence supports an approved settings change as the cause.',
    possible: 'An approved settings change may be involved.',
    not_supported: 'The evidence does not support an approved change as the cause.',
  },
  unrelated_cyber: {
    supported: 'The nearby security events are not connected to this equipment.',
    possible: 'Some nearby security events may be unrelated to this equipment.',
    not_supported: 'Some of the security events involve the controller of this equipment, so they cannot be set aside as unrelated.',
  },
};

/** Everyday wording for each detection rule; the technical title stays in the expert view. */
const ACTIVITY: Record<string, string> = {
  'FIRST-SEEN': 'a connection from a computer that had never connected to it before',
  'ENG-SESSION': 'an engineering session outside any approved maintenance window',
  CONDUIT: 'network traffic between zones that are not supposed to talk to each other',
  'AUTH-BURST': 'a burst of failed logins',
  'CONTROLLER-READ': 'someone reading its settings',
};

const ago = (s: number) => (s >= 120 ? `${Math.round(s / 60)} minutes` : s === 1 ? '1 second' : `${s} seconds`);

export function briefIncident(inc: Incident, a: CyberPhysicalAssessment, look: BriefingLookups): Briefing {
  const known: BriefingStatement[] = [];

  // Observations: the earliest unusual readings, in everyday words.
  const detections = inc.anomalyIds
    .map((id) => look.anomaly(id))
    .filter((x): x is Anomaly => !!x)
    .sort((x, y) => x.startedAt - y.startedAt);
  // Several detectors can flag the same reading; say it once and keep all their evidence.
  const readings = new Map<string, string[]>();
  for (const d of detections) {
    const signal = look.signalName(d.signalId) ?? 'A measurement';
    const asset = look.assetName(d.assetId);
    const text = `${signal}${asset ? ` on ${asset}` : ''} ${DIRECTION[d.direction]}.`;
    readings.set(text, [...(readings.get(text) ?? []), d.id]);
  }
  const ordered = [...readings.entries()];
  for (const [text, evidence] of ordered.slice(0, 3)) known.push({ text, evidence });
  const rest = ordered.slice(3);
  if (rest.length > 0) {
    known.push({ text: `${rest.length} more unusual reading${rest.length === 1 ? '' : 's'} followed.`, evidence: rest.flatMap(([, ids]) => ids) });
  }

  // Records: what the security and change logs show, related or not.
  for (const link of a.links) {
    const e = look.event(link.eventId);
    if (!e) continue;
    const when = link.leadS >= 0 ? `${ago(link.leadS)} before the first unusual reading` : `${ago(-link.leadS)} after the first unusual reading`;
    const equipment = look.assetName(inc.origin?.assetId ?? '') ?? 'this equipment';
    if (e.parameterId) {
      const setting = look.parameterName(e.parameterId) ?? 'a setting';
      const who = e.identity ? ` by the account "${e.identity}"` : '';
      const record = e.changeRecordId ? `It matches approved change record ${e.changeRecordId}.` : 'No approved change record covers it.';
      known.push({ text: `The controller of ${equipment} records a change to ${setting}${who}, ${when}. ${record}`, evidence: [e.id] });
    } else {
      const what = ACTIVITY[e.ruleId] ?? 'security-relevant activity';
      known.push({ text: `The security records show ${what} on the controller of ${equipment}, ${when}.`, evidence: [e.id] });
    }
  }
  const unlinked = a.consideredEventIds.filter((id) => !a.links.some((l) => l.eventId === id));
  if (a.consideredEventIds.length === 0) {
    known.push({ text: 'No security events were recorded in the 30 minutes before the problem started.', evidence: [] });
  } else if (unlinked.length > 0) {
    known.push({
      text: `${unlinked.length} other security event${unlinked.length === 1 ? ' was' : 's were'} recorded around that time, none of them on the controller of this equipment.`,
      evidence: unlinked,
    });
  }

  // Interpretation: what the evidence supports first, then what it leaves open, then what it rules out.
  const order: CpExplanation['status'][] = ['supported', 'possible', 'not_supported'];
  const suggests = [...a.explanations]
    .sort((x, y) => order.indexOf(x.status) - order.indexOf(y.status))
    .map((x) => ({ text: SUGGESTS[x.key][x.status], evidence: [...new Set(x.criteria.filter((c) => c.observed).flatMap((c) => c.evidence))] }));

  return {
    incidentId: inc.id,
    standing: a.standing,
    inShort: IN_SHORT[a.standing],
    cyberInvestigation: CYBER_INVESTIGATION[a.standing],
    known,
    suggests,
    notKnown: a.unknowns,
    toSettle: a.nextSteps.slice(0, 3),
  };
}
