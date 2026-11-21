/**
 * Earnings movement investigation: is a reported movement real operating performance, an
 * accounting entry, or both?
 *
 * The finance counterpart of the cyber-physical assessment (src/cyber/assess.ts), with the
 * same discipline:
 *   - links come from declared structure only: an entry explains a line only if it posts to
 *     that line (or a line it rolls up into);
 *   - every explanation has explicit criteria, observed or not, each with evidence IDs;
 *   - competing explanations are kept open when the evidence supports both;
 *   - nothing is concluded about intent: an unapproved entry is not called an error or fraud;
 *   - a person decides. The assessment never changes the data.
 */
import { LINE_LABEL, SEGMENTS } from './data';
import type { BusinessEvent, Drivers, FinanceDataset, JournalEntry, PnlLine, PostingLine, SegmentId } from './data';

export type FinStanding =
  | 'operating_supported'
  | 'accounting_entry_supported'
  | 'approved_adjustment_supported'
  | 'masked_by_entry'
  | 'multiple_plausible'
  | 'no_material_movement'
  | 'insufficient_evidence';

export const FIN_STANDING_TEXT: Record<FinStanding, string> = {
  operating_supported: 'The movement is explained by operating drivers. No material accounting entry explains it.',
  accounting_entry_supported: 'The movement is explained by a manual entry without a recorded approval, not by operating drivers. Whether the entry is appropriate is not established.',
  approved_adjustment_supported: 'The movement is explained by an approved accounting adjustment, not by a change in operations.',
  masked_by_entry: 'The reported result looks close to plan, but operating drivers moved materially and an accounting entry offsets them. The underlying result differs from what is reported.',
  multiple_plausible: 'Operating drivers and an accounting entry both moved the result in the same direction. Both explanations remain open.',
  no_material_movement: 'There is no material movement against budget to explain.',
  insufficient_evidence: 'The movement is material but neither the drivers nor the ledger explain it.',
};

/** One driver effect in the bridge from budget to actual, in the investigated line's terms. */
export interface BridgeStep {
  key: string;
  label: string;
  amount: number;
  kind: 'operating' | 'approved_entry' | 'unapproved_entry';
  evidence: string[];
}

export interface DriverAnomaly {
  id: string;
  driver: string;
  label: string;
  change: number;
  z: number;
}

export interface FinCriterion {
  description: string;
  observed: boolean;
  evidence: string[];
}

export interface FinExplanation {
  key: 'operating' | 'unapproved_entry' | 'approved_entry' | 'unrelated_entries';
  title: string;
  status: 'supported' | 'possible' | 'not_supported';
  criteria: FinCriterion[];
}

export interface FinAssessment {
  line: PnlLine;
  month: number;
  standing: FinStanding;
  headline: string;
  budget: number;
  reported: number;
  /** Reported minus unapproved manual entries: what operations and approved accounting produced. */
  normalised: number;
  materiality: number;
  bridge: BridgeStep[];
  anomalies: DriverAnomaly[];
  entries: JournalEntry[];
  events: BusinessEvent[];
  explanations: FinExplanation[];
  unknowns: string[];
  nextSteps: string[];
}

/** How a posting line feeds the investigated line: +1 adds, −1 subtracts, 0 unrelated. */
const ROLLUP: Record<PnlLine, Record<PostingLine, number>> = {
  revenue: { revenue: 1, cogs: 0, opex: 0 },
  cogs: { revenue: 0, cogs: 1, opex: 0 },
  opex: { revenue: 0, cogs: 0, opex: 1 },
  gross_profit: { revenue: 1, cogs: -1, opex: 0 },
  ebitda: { revenue: 1, cogs: -1, opex: -1 },
};

const fmt = (x: number) => `${x < 0 ? '−' : ''}€${Math.round(Math.abs(x) / 1000)}k`;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Operating effects on the investigated line, exact: they sum to the operating variance. */
function operatingBridge(line: PnlLine, b: Drivers, a: Drivers, anomalyIds: Map<string, string>): BridgeStep[] {
  const w = ROLLUP[line];
  const steps: BridgeStep[] = [];
  const ev = (k: string) => (anomalyIds.has(k) ? [anomalyIds.get(k)!] : []);
  for (const g of SEGMENTS) {
    const id = g.id as SegmentId;
    const price = (a.price[id] - b.price[id]) * a.volume[id] * w.revenue;
    const volume = (a.volume[id] - b.volume[id]) * (b.price[id] * w.revenue + b.unitCost[id] * w.cogs);
    const rate = (a.unitCost[id] - b.unitCost[id]) * a.volume[id] * w.cogs;
    if (w.revenue) steps.push({ key: `price:${id}`, label: `Price, ${g.name}`, amount: price, kind: 'operating', evidence: ev(`price:${id}`) });
    if (w.revenue || w.cogs) steps.push({ key: `volume:${id}`, label: `Volume, ${g.name}`, amount: volume, kind: 'operating', evidence: ev(`volume:${id}`) });
    if (w.cogs) steps.push({ key: `unitCost:${id}`, label: `Unit cost, ${g.name}`, amount: rate, kind: 'operating', evidence: ev(`unitCost:${id}`) });
  }
  if (w.cogs) steps.push({ key: 'freight', label: 'Freight', amount: (a.freight - b.freight) * w.cogs, kind: 'operating', evidence: ev('freight') });
  if (w.opex) steps.push({ key: 'opexBase', label: 'Operating expenses (base)', amount: (a.opexBase - b.opexBase) * w.opex, kind: 'operating', evidence: ev('opexBase') });
  return steps;
}

/** Drivers that moved unusually in the focus month, against their own last 12 months. */
function driverAnomalies(ds: FinanceDataset): DriverAnomaly[] {
  const m = ds.focusMonth;
  const series: { key: string; label: string; get: (d: Drivers, i: number) => number }[] = [];
  for (const g of SEGMENTS) {
    series.push({ key: `price:${g.id}`, label: `${g.name} price`, get: (d) => d.price[g.id] });
    // Volume is compared with plan, so seasonality does not look unusual.
    series.push({ key: `volume:${g.id}`, label: `${g.name} volume vs plan`, get: (d, i) => d.volume[g.id] / ds.plan[i].volume[g.id] });
    series.push({ key: `unitCost:${g.id}`, label: `${g.name} unit cost`, get: (d) => d.unitCost[g.id] });
  }
  series.push({ key: 'freight', label: 'Freight vs plan', get: (d, i) => d.freight / ds.plan[i].freight });
  series.push({ key: 'opexBase', label: 'Operating expenses (base)', get: (d) => d.opexBase });
  const out: DriverAnomaly[] = [];
  for (const s of series) {
    const hist = ds.actualDrivers.slice(m - 13, m - 1).map((d, k) => s.get(d, m - 13 + k));
    const med = median(hist);
    const mad = median(hist.map((x) => Math.abs(x - med))) * 1.4826 || 1e-9;
    const now = s.get(ds.actualDrivers[m - 1], m - 1);
    const z = (now - med) / mad;
    if (Math.abs(z) >= 3.5) out.push({ id: `FA-${String(out.length + 1).padStart(2, '0')}`, driver: s.key, label: s.label, change: now / med - 1, z });
  }
  return out;
}

export function assessFinance(ds: FinanceDataset, line: PnlLine = ds.scenario.line, month = ds.focusMonth): FinAssessment {
  const i = month - 1;
  const w = ROLLUP[line];
  const materiality = Math.round(0.015 * ds.budget[i].revenue);
  const anomalies = month === ds.focusMonth ? driverAnomalies(ds) : [];
  const anomalyIds = new Map(anomalies.map((a) => [a.driver, a.id]));
  const ops = operatingBridge(line, ds.plan[i], ds.actualDrivers[i], anomalyIds);
  const inMonth = ds.journals.filter((j) => j.month === month);
  const effect = (j: JournalEntry) => j.amount * w[j.line];
  const relevant = inMonth.filter((j) => effect(j) !== 0);
  const unapproved = relevant.filter((j) => j.kind === 'manual' && !j.approvalRef);
  const approved = relevant.filter((j) => j.approvalRef);
  const sum = (xs: JournalEntry[]) => xs.reduce((s, j) => s + effect(j), 0);
  const eU = sum(unapproved);
  const eA = sum(approved);
  const op = ops.reduce((s, x) => s + x.amount, 0);
  const budget = ds.budget[i][line];
  const reported = ds.actual[i][line];
  const variance = reported - budget;
  const bridge: BridgeStep[] = [
    ...ops,
    ...approved.map((j) => ({ key: j.id, label: `Approved entry ${j.id}`, amount: effect(j), kind: 'approved_entry' as const, evidence: [j.id] })),
    ...unapproved.map((j) => ({ key: j.id, label: `Manual entry ${j.id} (no approval recorded)`, amount: effect(j), kind: 'unapproved_entry' as const, evidence: [j.id] })),
  ];

  const material = (x: number) => Math.abs(x) >= materiality;
  const materialOps = ops.filter((s) => material(s.amount));
  const opsEvidence = [...new Set(materialOps.flatMap((s) => s.evidence))];
  const eventIds = ds.events.filter((e) => e.month >= month - 3 && e.month <= month).map((e) => e.id);
  const opMaterial = material(op);
  const uMaterial = material(eU);
  const aMaterial = material(eA);
  const entryMaterial = uMaterial || aMaterial;
  const entryEffect = eU + eA;

  let standing: FinStanding;
  if (opMaterial && entryMaterial && Math.sign(op) !== Math.sign(entryEffect) && !material(variance)) standing = 'masked_by_entry';
  else if (opMaterial && entryMaterial && Math.sign(op) === Math.sign(entryEffect)) standing = 'multiple_plausible';
  else if (uMaterial) standing = 'accounting_entry_supported';
  else if (aMaterial) standing = 'approved_adjustment_supported';
  else if (opMaterial) standing = 'operating_supported';
  else if (!material(variance)) standing = 'no_material_movement';
  else standing = 'insufficient_evidence';

  const explanations: FinExplanation[] = [];
  const anomalyEvidence = anomalies.map((a) => a.id);
  explanations.push({
    key: 'operating',
    title: 'Operating performance (volume, price, costs)',
    status: opMaterial && anomalies.length ? 'supported' : opMaterial ? 'possible' : 'not_supported',
    criteria: [
      { description: `Operating drivers moved ${LINE_LABEL[line]} by at least the materiality threshold (${fmt(materiality)}): ${fmt(op)} in total`, observed: opMaterial, evidence: opsEvidence },
      { description: 'At least one driver moved unusually against its own last 12 months', observed: anomalies.length > 0, evidence: anomalyEvidence },
      { description: 'A business event recorded in the last three months fits the movement', observed: eventIds.length > 0, evidence: eventIds },
    ],
  });
  const entryCriteria = (xs: JournalEntry[], e: number, approvedSet: boolean): FinCriterion[] => [
    { description: `${approvedSet ? 'An approved' : 'A manual'} entry posts to ${LINE_LABEL[line]} or a line that rolls into it in this month`, observed: xs.length > 0, evidence: xs.map((j) => j.id) },
    { description: approvedSet ? 'The entry carries an approval or change-memo reference' : 'No approval reference is recorded for the entry', observed: xs.length > 0, evidence: xs.map((j) => j.id) },
    { description: `Its effect is material (${fmt(e)} against a threshold of ${fmt(materiality)})`, observed: material(e), evidence: material(e) ? xs.map((j) => j.id) : [] },
  ];
  explanations.push({ key: 'unapproved_entry', title: 'Manual entry without a recorded approval', status: uMaterial ? 'supported' : 'not_supported', criteria: entryCriteria(unapproved, eU, false) });
  if (approved.length) explanations.push({ key: 'approved_entry', title: 'Approved accounting adjustment', status: aMaterial ? 'supported' : 'not_supported', criteria: entryCriteria(approved, eA, true) });
  const minor = relevant.filter((j) => !material(effect(j)) && !(uMaterial && unapproved.includes(j)) && !(aMaterial && approved.includes(j)));
  if (minor.length && !entryMaterial) {
    explanations.push({ key: 'unrelated_entries', title: 'Entries in the month that do not explain the movement', status: 'supported', criteria: [{ description: 'Each is below the materiality threshold', observed: true, evidence: minor.map((j) => j.id) }] });
  }

  const unknowns = [
    'The ledger shows whether an approval reference exists, not whether the approval was appropriate.',
    'Whether a manual entry reflects a genuine change in an obligation or estimate is not established by the ledger alone.',
    'Drivers are compared with plan and with their own history; market data outside the dataset is not considered.',
    'The data is synthetic: these results show how the method reasons, not facts about any real company.',
  ];
  const nextSteps: string[] = [];
  for (const j of unapproved.filter((x) => material(effect(x)))) nextSteps.push(`Obtain the support for ${j.id} (${j.description.toLowerCase()}): who requested it, the calculation, and why no approval is recorded.`);
  for (const j of approved.filter((x) => material(effect(x)))) nextSteps.push(`Check ${j.id} against ${j.approvalRef}: does the memo cover this amount and period?`);
  for (const s of materialOps) nextSteps.push(`Confirm the ${s.label.toLowerCase()} movement (${fmt(s.amount)}) with the business owner and the source data.`);
  if (standing === 'masked_by_entry') nextSteps.unshift('Report the underlying result alongside the reported one: the entry offsets a real operating movement.');
  if (!nextSteps.length) nextSteps.push('No follow-up needed for this line this month.');

  const headline =
    standing === 'masked_by_entry'
      ? `${LINE_LABEL[line]} is within ${fmt(Math.abs(variance))} of budget, but operating drivers moved it by ${fmt(op)} and accounting entries offset ${fmt(entryEffect)}. ${FIN_STANDING_TEXT[standing]}`
      : `${LINE_LABEL[line]} ${fmt(variance)} against budget. ${FIN_STANDING_TEXT[standing]}`;

  return {
    line,
    month,
    standing,
    headline,
    budget,
    reported,
    normalised: reported - eU,
    materiality,
    bridge,
    anomalies,
    entries: inMonth,
    events: ds.events.filter((e) => eventIds.includes(e.id)),
    explanations,
    unknowns,
    nextSteps: nextSteps.slice(0, 4),
  };
}

/** Plain-language answer to "Is this result real?" */
export function briefFinance(a: FinAssessment): { answer: string; detail: string } {
  const line = LINE_LABEL[a.line];
  const gap = a.normalised - a.budget;
  switch (a.standing) {
    case 'operating_supported':
      return { answer: `Yes: the ${line.toLowerCase()} movement is real operating performance.`, detail: `Prices, volumes or costs moved it; no material accounting entry explains it.` };
    case 'accounting_entry_supported':
      return { answer: `No: the movement comes from a manual entry, not from operations.`, detail: `Without the entries that have no recorded approval, ${line} would be ${fmt(a.normalised)} (${fmt(gap)} against budget). Whether the entry is appropriate still needs its support.` };
    case 'approved_adjustment_supported':
      return { answer: `The movement is an approved accounting change, not an operating change.`, detail: `Operations did not change materially; an approved adjustment moved amounts between lines.` };
    case 'masked_by_entry':
      return { answer: `Not really: the result looks on plan, but operations deteriorated and an entry offsets it.`, detail: `Without the entries that have no recorded approval, ${line} would be ${fmt(a.normalised)}, ${fmt(gap)} against budget.` };
    case 'multiple_plausible':
      return { answer: `Partly: operations and an accounting entry both moved the result.`, detail: `Each needs checking before the movement is explained.` };
    case 'no_material_movement':
      return { answer: `Nothing material to explain this month.`, detail: `The result is within ${fmt(a.materiality)} of budget and no material entry was found.` };
    default:
      return { answer: `Unclear: the movement is material but not explained by the data.`, detail: `Look for missing data or postings outside this ledger.` };
  }
}
