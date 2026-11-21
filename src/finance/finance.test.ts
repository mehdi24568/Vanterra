/**
 * Earnings movement investigation: each scenario has a known cause (ground truth), and the
 * assessment must reach it from the data alone, with exact arithmetic, real evidence and
 * no claims about intent.
 */
import { describe, expect, it } from 'vitest';
import { assessFinance, briefFinance } from './assess';
import { buildDataset, SCENARIOS } from './data';

const OVERREACH = /\b(fraud|fraudulent|manipulat\w*|intentional\w*|deliberate\w*|cooked|definitely|certainly|proves?|guaranteed)\b/i;

describe('finance dataset', () => {
  it('is deterministic and internally consistent', () => {
    const a = buildDataset('masked-decline');
    const b = buildDataset('masked-decline');
    expect(JSON.stringify(a.actual)).toBe(JSON.stringify(b.actual));
    for (const p of [...a.actual, ...a.budget]) {
      expect(p.gross_profit).toBeCloseTo(p.revenue - p.cogs, -1);
      expect(p.ebitda).toBeCloseTo(p.revenue - p.cogs - p.opex, -1);
    }
  });
});

describe('earnings movement investigation', () => {
  for (const s of SCENARIOS) {
    it(`${s.id}: reaches the ground truth (${s.truth}) from the data`, () => {
      const ds = buildDataset(s.id);
      const a = assessFinance(ds);
      expect(a.standing).toBe(s.truth);

      // The bridge is exact: budget + every step = reported (to rounding).
      const total = a.bridge.reduce((sum, x) => sum + x.amount, 0);
      expect(Math.abs(a.budget + total - a.reported)).toBeLessThan(5);

      // Every cited ID exists in the dataset or the assessment's own anomalies.
      const ids = new Set([...ds.journals.map((j) => j.id), ...ds.events.map((e) => e.id), ...a.anomalies.map((x) => x.id)]);
      for (const x of a.explanations) for (const c of x.criteria) for (const id of c.evidence) expect(ids.has(id), id).toBe(true);

      // No intent or certainty in anything a person reads.
      const brief = briefFinance(a);
      for (const text of [a.headline, brief.answer, brief.detail, ...a.nextSteps]) expect(text, text).not.toMatch(OVERREACH);
    });
  }

  it('masked decline: on budget as reported, but the normalised result shows the real price-driven drop', () => {
    const a = assessFinance(buildDataset('masked-decline'));
    expect(Math.abs(a.reported - a.budget)).toBeLessThan(a.materiality);
    expect(a.budget - a.normalised).toBeGreaterThan(130_000);
    expect(a.anomalies.some((x) => x.driver === 'price:SEG-A' && x.change < -0.05)).toBe(true);
    expect(briefFinance(a).answer).toMatch(/Not really/);
    expect(a.nextSteps[0]).toMatch(/underlying result/);
  });

  it('accrual release: the beat disappears once the unapproved manual entry is excluded', () => {
    const a = assessFinance(buildDataset('accrual-release'));
    expect(a.reported - a.budget).toBeGreaterThan(2 * a.materiality); // a clear beat (entry €175k, less normal noise)
    expect(Math.abs(a.normalised - a.budget)).toBeLessThan(a.materiality);
    expect(a.explanations.find((x) => x.key === 'operating')!.status).toBe('not_supported');
  });

  it('approved reclassification moves gross profit but not EBITDA', () => {
    const ds = buildDataset('approved-reclass');
    expect(assessFinance(ds, 'gross_profit').standing).toBe('approved_adjustment_supported');
    expect(assessFinance(ds, 'ebitda').standing).toBe('no_material_movement');
  });

  it('a small unapproved entry next to a real volume loss is not treated as the cause', () => {
    const a = assessFinance(buildDataset('volume-loss'));
    expect(a.explanations.find((x) => x.key === 'unapproved_entry')!.status).toBe('not_supported');
    expect(a.explanations.find((x) => x.key === 'unrelated_entries')?.status).toBe('supported');
  });

  it('is read-only: assessing never changes the data', () => {
    const ds = buildDataset('masked-decline');
    const before = JSON.stringify({ a: ds.actual, j: ds.journals, d: ds.actualDrivers });
    assessFinance(ds);
    assessFinance(ds, 'revenue');
    expect(JSON.stringify({ a: ds.actual, j: ds.journals, d: ds.actualDrivers })).toBe(before);
  });
});
