/**
 * Finance domain: a fictional company, its operating drivers, budget and journal ledger.
 *
 * Kestrel Components is invented. Every figure is generated deterministically from a seed,
 * so each scenario has a known ground truth, exactly as the plant simulator does for the
 * industrial investigations. Nothing here connects to a real company or financial system.
 *
 * Structure (the finance counterpart of declared asset relationships):
 *   revenue = Σ segments volume × price (+ revenue entries)
 *   COGS    = Σ segments volume × unit cost + freight (+ COGS entries)
 *   gross profit = revenue − COGS;  EBITDA = gross profit − opex
 */

export type SegmentId = 'SEG-A' | 'SEG-B';
export type PnlLine = 'revenue' | 'cogs' | 'gross_profit' | 'opex' | 'ebitda';
export type PostingLine = 'revenue' | 'cogs' | 'opex';

export const SEGMENTS: { id: SegmentId; name: string }[] = [
  { id: 'SEG-A', name: 'Industrial bearings' },
  { id: 'SEG-B', name: 'Precision gearboxes' },
];

export const LINE_LABEL: Record<PnlLine, string> = { revenue: 'Revenue', cogs: 'Cost of goods sold', gross_profit: 'Gross profit', opex: 'Operating expenses', ebitda: 'EBITDA' };

/** Operating drivers for one month (what the business actually did). */
export interface Drivers {
  volume: Record<SegmentId, number>;
  price: Record<SegmentId, number>;
  unitCost: Record<SegmentId, number>;
  freight: number;
  opexBase: number;
}

export interface JournalEntry {
  id: string;
  month: number;
  line: PostingLine;
  /** Change to the line's value: +100 on opex raises opex (lowers EBITDA). */
  amount: number;
  kind: 'manual' | 'system';
  postedBy: string;
  /** Approval or change-memo reference; null when none is recorded. */
  approvalRef: string | null;
  description: string;
}

export interface BusinessEvent {
  id: string;
  month: number;
  title: string;
}

export interface Pnl {
  revenue: number;
  cogs: number;
  gross_profit: number;
  opex: number;
  ebitda: number;
}

export interface FinanceScenario {
  id: string;
  title: string;
  /** What the investigation should conclude: the ground truth the evaluation checks. */
  truth: string;
  /** The line the scenario is investigated on. */
  line: PnlLine;
}

export const SCENARIOS: FinanceScenario[] = [
  { id: 'normal', title: 'Normal month', truth: 'no_material_movement', line: 'ebitda' },
  { id: 'price-erosion', title: 'Price erosion in Segment A', truth: 'operating_supported', line: 'ebitda' },
  { id: 'accrual-release', title: 'EBITDA beat from a manual accrual release', truth: 'accounting_entry_supported', line: 'ebitda' },
  { id: 'approved-reclass', title: 'Gross margin jump from an approved reclassification', truth: 'approved_adjustment_supported', line: 'gross_profit' },
  { id: 'masked-decline', title: 'On budget, but a manual entry hides a real decline', truth: 'masked_by_entry', line: 'ebitda' },
  { id: 'volume-loss', title: 'Lost customer volume, with an unrelated small entry', truth: 'operating_supported', line: 'ebitda' },
];

export interface FinanceDataset {
  company: string;
  scenario: FinanceScenario;
  months: number;
  /** The month under investigation (the latest close). */
  focusMonth: number;
  monthLabel: (m: number) => string;
  plan: Drivers[];
  actualDrivers: Drivers[];
  budget: Pnl[];
  actual: Pnl[];
  journals: JournalEntry[];
  events: BusinessEvent[];
}

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MONTHS = 24;
const round = (x: number) => Math.round(x);

function planFor(m: number): Drivers {
  const season = 1 + 0.04 * Math.sin((2 * Math.PI * m) / 12);
  return {
    volume: { 'SEG-A': 20_000 * season, 'SEG-B': 8_000 * season },
    price: { 'SEG-A': 120, 'SEG-B': 200 },
    unitCost: { 'SEG-A': 72, 'SEG-B': 128 },
    freight: 160_000 * season,
    opexBase: 820_000,
  };
}

export function pnlFrom(d: Drivers, entries: JournalEntry[] = []): Pnl {
  const sum = (line: PostingLine) => entries.filter((e) => e.line === line).reduce((s, e) => s + e.amount, 0);
  const revenue = SEGMENTS.reduce((s, g) => s + d.volume[g.id] * d.price[g.id], 0) + sum('revenue');
  const cogs = SEGMENTS.reduce((s, g) => s + d.volume[g.id] * d.unitCost[g.id], 0) + d.freight + sum('cogs');
  const opex = d.opexBase + sum('opex');
  return { revenue: round(revenue), cogs: round(cogs), gross_profit: round(revenue - cogs), opex: round(opex), ebitda: round(revenue - cogs - opex) };
}

export function buildDataset(scenarioId: string, seed = 20260112): FinanceDataset {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) throw new Error(`Unknown finance scenario: ${scenarioId}`);
  const r = rng(seed);
  const noise = (pct: number) => 1 + (r() * 2 - 1) * pct;
  const focus = MONTHS;
  const plan: Drivers[] = [];
  const actualDrivers: Drivers[] = [];
  const journals: JournalEntry[] = [];
  const events: BusinessEvent[] = [];

  for (let m = 1; m <= MONTHS; m++) {
    const p = planFor(m);
    plan.push(p);
    actualDrivers.push({
      volume: { 'SEG-A': p.volume['SEG-A'] * noise(0.015), 'SEG-B': p.volume['SEG-B'] * noise(0.015) },
      price: { 'SEG-A': p.price['SEG-A'] * noise(0.002), 'SEG-B': p.price['SEG-B'] * noise(0.002) },
      unitCost: { 'SEG-A': p.unitCost['SEG-A'] * noise(0.006), 'SEG-B': p.unitCost['SEG-B'] * noise(0.006) },
      freight: p.freight * noise(0.03),
      opexBase: p.opexBase * noise(0.012),
    });
    // Routine month-end postings exist every month, so a manual entry alone is not unusual.
    journals.push({ id: `JE-${String(m).padStart(2, '0')}01`, month: m, line: 'opex', amount: round(2_000 + r() * 3_000), kind: 'manual', postedBy: 'gl.user07', approvalRef: `APR-${m}01`, description: 'Monthly prepaid insurance amortisation' });
  }

  const at = (m: number) => actualDrivers[m - 1];
  const priceCut = () => {
    events.push({ id: 'EV-01', month: focus - 2, title: 'Competitor announced a 10% list-price cut in industrial bearings' });
    for (const m of [focus - 1, focus]) at(m).price['SEG-A'] *= 0.93;
  };
  const manualRelease = (amount: number) =>
    journals.push({ id: `JE-${focus}17`, month: focus, line: 'opex', amount: -amount, kind: 'manual', postedBy: 'gl.user14', approvalRef: null, description: 'Release of bonus accrual' });

  switch (scenario.id) {
    case 'price-erosion':
      priceCut();
      break;
    case 'accrual-release':
      manualRelease(175_000);
      break;
    case 'approved-reclass':
      events.push({ id: 'EV-02', month: focus, title: 'Finance memo: outbound freight to be reported under operating expenses' });
      journals.push({ id: `JE-${focus}21`, month: focus, line: 'cogs', amount: -130_000, kind: 'manual', postedBy: 'gl.user03', approvalRef: 'MEMO-FIN-0412', description: 'Reclassify outbound freight out of COGS' });
      journals.push({ id: `JE-${focus}22`, month: focus, line: 'opex', amount: 130_000, kind: 'manual', postedBy: 'gl.user03', approvalRef: 'MEMO-FIN-0412', description: 'Reclassify outbound freight into operating expenses' });
      break;
    case 'masked-decline':
      priceCut();
      manualRelease(170_000);
      break;
    case 'volume-loss':
      events.push({ id: 'EV-03', month: focus, title: 'A large Segment B customer moved part of its orders to a second supplier' });
      at(focus).volume['SEG-B'] *= 0.8;
      journals.push({ id: `JE-${focus}09`, month: focus, line: 'opex', amount: 8_000, kind: 'manual', postedBy: 'gl.user14', approvalRef: null, description: 'Correction of a travel expense coding' });
      break;
    default:
  }

  const budget = plan.map((p) => pnlFrom(p));
  const actual = actualDrivers.map((d, i) => pnlFrom(d, journals.filter((j) => j.month === i + 1)));
  return {
    company: 'Kestrel Components (fictional)',
    scenario,
    months: MONTHS,
    focusMonth: focus,
    monthLabel: (m) => `M${String(m).padStart(2, '0')}`,
    plan,
    actualDrivers,
    budget,
    actual,
    journals,
    events,
  };
}
