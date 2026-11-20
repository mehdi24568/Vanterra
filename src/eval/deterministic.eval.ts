/**
 * Deterministic evaluation: detection, correlation, origin ranking, hypothesis ranking,
 * incident separation and false positives, over ten seeds. No model is involved.
 *
 * Results: eval/results/deterministic.{json,md}. Methodology: EVALUATION.md.
 */
import { describe, expect, it } from 'vitest';
import type { Incident } from '../core/types';
import { boot } from '../runtime/testHarness';
import { EVAL_SEEDS, FAULTS, MATERIAL_MIN_S, MATERIAL_Z, AFFECTED_Z, isAffected, isMaterial, twinRun } from './groundTruth';
import type { FaultTruth, TwinResult } from './groundTruth';
import { num, pct, stats, table, writeResults } from './results';

const WINDOW_S = 240;

function incidentFor(r: TwinResult, truth: FaultTruth): Incident | undefined {
  return r.incidents.find((i) => i.origin?.assetId === truth.origin) ?? r.incidents.find((i) => i.assets.some((a) => a.assetId === truth.origin));
}

function singleFault(seed: number, truth: FaultTruth) {
  const r = twinRun(seed, [truth.scenario], WINDOW_S);
  const material = r.effects.filter(isMaterial);
  const affected = new Set(r.effects.filter(isAffected).map((e) => e.signalId));
  const detected = new Set(r.detections.map((d) => d.signalId));
  const truePos = [...detected].filter((s) => affected.has(s));
  const falseDet = [...detected].filter((s) => !affected.has(s));
  const recalled = material.filter((e) => detected.has(e.signalId));
  const monitoredMaterial = material.filter((e) => e.monitored);
  const monitoredRecalled = monitoredMaterial.filter((e) => detected.has(e.signalId));
  const onsets = material.map((e) => e.firstMaterialS!).filter((x) => x !== null);
  const physicalOnsetS = onsets.length ? Math.min(...onsets) : null;
  const firstDetectionS = r.detections[0]?.atS ?? null;
  const inc = incidentFor(r, truth);
  const incidentOpenS = inc ? (inc.openedAt - r.t0) / 1000 : null;

  // Ranking over time, sampled each second after the first incident opened.
  const after = r.samples.filter((s) => s.incidents.length > 0);
  const right = (s: (typeof after)[number]) => s.incidents.some((i) => i.origin === truth.origin && i.lead === truth.leadTemplate);
  const firstRight = after.find(right);
  const firstSample = after[0];

  const expectedRank = inc ? inc.hypotheses.findIndex((h) => h.templateId === truth.leadTemplate) + 1 : 0;
  const lead = inc?.hypotheses[0];
  const second = inc?.hypotheses[1];
  const alternatives = inc ? inc.hypotheses.filter((h) => h.templateId !== truth.leadTemplate) : [];
  const expectedH = inc?.hypotheses.find((h) => h.templateId === truth.leadTemplate);
  const recs = inc?.recommendations ?? [];

  return {
    seed,
    scenario: truth.scenario,
    signalsMeasured: r.effects.length,
    signalsUnchanged: r.effects.filter((e) => e.identical).length,
    signalsMaterial: material.length,
    signalsAffected: affected.size,
    detections: detected.size,
    recall: material.length ? recalled.length / material.length : null,
    signalsMonitoredMaterial: monitoredMaterial.length,
    monitoredRecall: monitoredMaterial.length ? monitoredRecalled.length / monitoredMaterial.length : null,
    precision: detected.size ? truePos.length / detected.size : null,
    falseDetections: falseDet,
    missedMaterial: material.filter((e) => !detected.has(e.signalId)).map((e) => `${e.signalId} (max ${e.maxZ.toFixed(1)}σ)`),
    physicalOnsetS,
    firstDetectionS,
    detectionAfterOnsetS: physicalOnsetS !== null && firstDetectionS !== null ? firstDetectionS - physicalOnsetS : null,
    incidentOpenS,
    incidentsAtEnd: r.incidents.length,
    twinDetections: r.twinDetections,
    originAtFirstIncident: firstSample ? firstSample.incidents.some((i) => i.origin === truth.origin) : false,
    originCorrectAtEnd: inc?.origin?.assetId === truth.origin,
    leadCorrectAtEnd: lead?.templateId === truth.leadTemplate,
    timeToCorrectS: firstRight ? firstRight.t : null,
    stability: after.length ? after.filter(right).length / after.length : null,
    expectedRank,
    expectedSupport: expectedH?.support ?? null,
    expectedContradictionsObserved: expectedH ? expectedH.criteria.filter((c) => c.role === 'contradicts' && c.state === 'observed').length : null,
    leadMargin: lead && second ? lead.support - second.support : null,
    alternatives: alternatives.length,
    alternativesWithObservedContradiction: alternatives.filter((h) => h.criteria.some((c) => c.role === 'contradicts' && c.state === 'observed')).length,
    recommendations: recs.length,
    firstRecommendationOnOrigin: recs[0]?.assetId === truth.origin,
    noConfirmation: !!inc && inc.hypotheses.every((h) => h.disposition === 'unverified'),
  };
}

const COMBOS: string[][] = [
  ['pump-bearing', 'cooling-fan'],
  ['pump-bearing', 'mcc-sag'],
  ['cooling-fan', 'mcc-sag'],
  ['pump-bearing', 'cooling-fan', 'mcc-sag'],
];

function multiFault(seed: number, scenarios: string[]) {
  const r = twinRun(seed, scenarios, WINDOW_S);
  const truths = FAULTS.filter((f) => scenarios.includes(f.scenario));
  const origins = r.incidents.map((i) => i.origin?.assetId ?? '?').sort();
  const expectedOrigins = truths.map((t) => t.origin).sort();
  const leads = r.incidents.map((i) => i.hypotheses[0]?.templateId ?? '?').sort();
  const expectedLeads = truths.map((t) => t.leadTemplate).sort();
  const merged = r.incidents.filter((i) => truths.filter((t) => i.assets.some((a) => a.assetId === t.origin)).length > 1).length;
  return {
    seed,
    scenarios: scenarios.join(' + '),
    incidents: r.incidents.length,
    expected: truths.length,
    separated: r.incidents.length === truths.length && merged === 0,
    originsCorrect: JSON.stringify(origins) === JSON.stringify(expectedOrigins),
    leadsCorrect: JSON.stringify(leads) === JSON.stringify(expectedLeads),
    merged,
    origins,
  };
}

const ORDERS: string[][] = [
  ['pump-bearing', 'cooling-fan', 'mcc-sag'],
  ['mcc-sag', 'cooling-fan', 'pump-bearing'],
];
const GAPS_S = [30, 60, 90];

/** Faults injected one after another, `gap` seconds apart, as an operator would in the UI. */
function sequential(seed: number, order: string[], gap: number) {
  const rig = boot(seed);
  order.forEach((s, i) => {
    rig.adapter.trigger(s);
    rig.run(i < order.length - 1 ? gap : 150);
  });
  const incidents = rig.core.intelligence.incidents();
  const origins = incidents.map((i) => i.origin?.assetId ?? '?').sort();
  const leads = incidents.map((i) => i.hypotheses[0]?.templateId ?? '?').sort();
  return {
    seed,
    order: order.join(' → '),
    gapS: gap,
    incidents: incidents.length,
    separated: incidents.length === 3,
    originsCorrect: JSON.stringify(origins) === JSON.stringify(FAULTS.map((f) => f.origin).sort()),
    leadsCorrect: JSON.stringify(leads) === JSON.stringify(FAULTS.map((f) => f.leadTemplate).sort()),
    origins,
  };
}

function normalOps(seed: number) {
  const out: { seed: number; activity: string; simulatedS: number; anomalies: number; incidents: number }[] = [];
  const nominal = boot(seed);
  nominal.run(1800);
  out.push({ seed, activity: 'steady operation', simulatedS: 1800, anomalies: nominal.core.anomalies.all().length, incidents: nominal.core.intelligence.incidents().length });

  const rate = boot(seed);
  rate.adapter.trigger('reduced-rate');
  rate.run(420);
  rate.adapter.trigger('full-rate');
  rate.run(420);
  out.push({ seed, activity: 'rate change 100 → 70 → 100 %', simulatedS: 840, anomalies: rate.core.anomalies.all().length, incidents: rate.core.intelligence.incidents().length });

  const swap = boot(seed);
  swap.adapter.trigger('pump-changeover');
  swap.run(420);
  out.push({ seed, activity: 'feed pump changeover', simulatedS: 420, anomalies: swap.core.anomalies.all().length, incidents: swap.core.intelligence.incidents().length });
  return out;
}

describe('deterministic evaluation', () => {
  it('runs the full matrix and writes eval/results/deterministic.*', () => {
    const started = Date.now();
    const single = FAULTS.flatMap((f) => EVAL_SEEDS.map((s) => singleFault(s, f)));
    const multi = COMBOS.flatMap((c) => EVAL_SEEDS.map((s) => multiFault(s, c)));
    const normal = EVAL_SEEDS.flatMap((s) => normalOps(s));
    const seq = ORDERS.flatMap((o) => GAPS_S.flatMap((g) => EVAL_SEEDS.map((s) => sequential(s, o, g))));
    const seqSummary = ORDERS.flatMap((o) =>
      GAPS_S.map((g) => {
        const rows = seq.filter((r) => r.order === o.join(' → ') && r.gapS === g);
        return { order: o.join(' → '), gapS: g, runs: rows.length, separated: rows.filter((r) => r.separated).length, originsCorrect: rows.filter((r) => r.originsCorrect).length, leadsCorrect: rows.filter((r) => r.leadsCorrect).length };
      }),
    );
    const wallS = (Date.now() - started) / 1000;

    const per = FAULTS.map((f) => {
      const rows = single.filter((x) => x.scenario === f.scenario);
      const det = rows.flatMap((x) => (x.firstDetectionS === null ? [] : [x.firstDetectionS]));
      const after = rows.flatMap((x) => (x.detectionAfterOnsetS === null ? [] : [x.detectionAfterOnsetS]));
      const open = rows.flatMap((x) => (x.incidentOpenS === null ? [] : [x.incidentOpenS]));
      const ttc = rows.flatMap((x) => (x.timeToCorrectS === null ? [] : [x.timeToCorrectS]));
      const microRecall = rows.reduce((a, x) => a + (x.recall ?? 0) * x.signalsMaterial, 0) / Math.max(1, rows.reduce((a, x) => a + x.signalsMaterial, 0));
      const monitoredRecall = rows.reduce((a, x) => a + (x.monitoredRecall ?? 0) * x.signalsMonitoredMaterial, 0) / Math.max(1, rows.reduce((a, x) => a + x.signalsMonitoredMaterial, 0));
      const microPrecision = rows.reduce((a, x) => a + (x.precision ?? 0) * x.detections, 0) / Math.max(1, rows.reduce((a, x) => a + x.detections, 0));
      return {
        scenario: f.scenario,
        expectedOrigin: f.origin,
        expectedLead: f.leadTemplate,
        runs: rows.length,
        detected: rows.filter((x) => x.firstDetectionS !== null).length,
        firstDetectionS: stats(det),
        detectionAfterOnsetS: stats(after),
        incidentOpenS: stats(open),
        timeToCorrectS: stats(ttc),
        signalRecall: microRecall,
        monitoredRecall,
        materialSignalsPerRun: rows[0]?.signalsMaterial ?? 0,
        monitoredMaterialPerRun: rows[0]?.signalsMonitoredMaterial ?? 0,
        signalPrecision: microPrecision,
        falseDetections: rows.reduce((a, x) => a + x.falseDetections.length, 0),
        oneIncident: rows.filter((x) => x.incidentsAtEnd === 1).length,
        originCorrectAtEnd: rows.filter((x) => x.originCorrectAtEnd).length,
        originAtFirstIncident: rows.filter((x) => x.originAtFirstIncident).length,
        leadCorrectAtEnd: rows.filter((x) => x.leadCorrectAtEnd).length,
        meanStability: stats(rows.flatMap((x) => (x.stability === null ? [] : [x.stability]))).mean,
        meanLeadMargin: stats(rows.flatMap((x) => (x.leadMargin === null ? [] : [x.leadMargin]))).mean,
        alternativesContradicted: rows.reduce((a, x) => a + x.alternativesWithObservedContradiction, 0) / Math.max(1, rows.reduce((a, x) => a + x.alternatives, 0)),
        expectedHypothesisContradicted: rows.filter((x) => (x.expectedContradictionsObserved ?? 0) > 0).length,
        firstRecommendationOnOrigin: rows.filter((x) => x.firstRecommendationOnOrigin).length,
        twinDetections: rows.reduce((a, x) => a + x.twinDetections, 0),
        noConfirmation: rows.every((x) => x.noConfirmation),
      };
    });

    const comboSummary = COMBOS.map((c) => {
      const rows = multi.filter((m) => m.scenarios === c.join(' + '));
      return { scenarios: c.join(' + '), runs: rows.length, separated: rows.filter((r) => r.separated).length, originsCorrect: rows.filter((r) => r.originsCorrect).length, leadsCorrect: rows.filter((r) => r.leadsCorrect).length };
    });

    const normalSummary = ['steady operation', 'rate change 100 → 70 → 100 %', 'feed pump changeover'].map((activity) => {
      const rows = normal.filter((n) => n.activity === activity);
      const hours = rows.reduce((a, r) => a + r.simulatedS, 0) / 3600;
      const anomalies = rows.reduce((a, r) => a + r.anomalies, 0);
      const incidents = rows.reduce((a, r) => a + r.incidents, 0);
      return { activity, runs: rows.length, simulatedHours: hours, anomalies, incidents, anomaliesPerHour: anomalies / hours };
    });
    const totalNormalHours = normalSummary.reduce((a, r) => a + r.simulatedHours, 0);

    const md = `
## Deterministic evaluation — measured

Generated by \`npm run eval\` on ${new Date().toISOString().slice(0, 10)}. Seeds: ${EVAL_SEEDS.join(', ')}. Window: ${WINDOW_S} s after injection, 120 s pre-roll. Wall time ${wallS.toFixed(0)} s.
Ground truth: injected scenario (origin, mechanism) and a counterfactual twin run (which signals moved: material = ≥ ${MATERIAL_Z} σ for ≥ ${MATERIAL_MIN_S} s; affected = ≥ ${AFFECTED_Z} σ at any time).

### Single faults (${EVAL_SEEDS.length} seeds each)

${table(
  ['Scenario', 'Detected', 'First detection s (median, range)', 'After physical onset s (median)', 'Incident opens s (median)', 'Signal recall, monitored signals', 'Signal recall, all moved signals', 'Signal precision', 'False detections', 'One incident', 'Origin correct (end)', 'Lead correct (end)', 'Time to correct origin+lead s (median)', 'Ranking stability'],
  per.map((p) => [
    p.scenario,
    `${p.detected}/${p.runs}`,
    `${num(p.firstDetectionS.median)} (${num(p.firstDetectionS.min)}–${num(p.firstDetectionS.max)})`,
    num(p.detectionAfterOnsetS.median),
    num(p.incidentOpenS.median),
    `${pct(p.monitoredRecall)} of ${p.monitoredMaterialPerRun}`,
    `${pct(p.signalRecall)} of ${p.materialSignalsPerRun}`,
    pct(p.signalPrecision),
    p.falseDetections,
    `${p.oneIncident}/${p.runs}`,
    `${p.originCorrectAtEnd}/${p.runs}`,
    `${p.leadCorrectAtEnd}/${p.runs}`,
    num(p.timeToCorrectS.median),
    pct(p.meanStability),
  ]),
)}

### Hypothesis quality

${table(
  ['Scenario', 'Mean support margin, lead − second', 'Alternatives with an observed contradiction', 'Runs where the correct hypothesis had a contradiction observed', 'First check targets the origin', 'Detections in fault-free twin', 'Hypotheses confirmed without an operator'],
  per.map((p) => [p.scenario, num(p.meanLeadMargin, 2), pct(p.alternativesContradicted), `${p.expectedHypothesisContradicted}/${p.runs}`, `${p.firstRecommendationOnOrigin}/${p.runs}`, p.twinDetections, p.noConfirmation ? 'none' : 'FOUND'])
)}

### Simultaneous independent faults

${table(['Faults', 'Runs', 'Kept separate', 'Origins correct', 'Leads correct'], comboSummary.map((c) => [c.scenarios, c.runs, `${c.separated}/${c.runs}`, `${c.originsCorrect}/${c.runs}`, `${c.leadsCorrect}/${c.runs}`]))}

### Three faults injected one after another

${table(['Injection order', 'Gap s', 'Runs', 'Three separate incidents', 'Origins correct', 'Leads correct'], seqSummary.map((c) => [c.order, c.gapS, c.runs, `${c.separated}/${c.runs}`, `${c.originsCorrect}/${c.runs}`, `${c.leadsCorrect}/${c.runs}`]))}

### Normal operation (false positives)

${table(['Activity', 'Runs', 'Simulated hours', 'Anomalies', 'Incidents', 'Anomalies per hour'], normalSummary.map((n) => [n.activity, n.runs, num(n.simulatedHours, 2), n.anomalies, n.incidents, num(n.anomaliesPerHour, 2)]))}

Total normal operation evaluated: ${totalNormalHours.toFixed(1)} simulated hours.
`;

    writeResults('deterministic', { generated: new Date().toISOString(), seeds: EVAL_SEEDS, windowS: WINDOW_S, thresholds: { MATERIAL_Z, MATERIAL_MIN_S, AFFECTED_Z }, summary: per, combos: comboSummary, sequential: seqSummary, normal: normalSummary, runs: { single, multi, sequential: seq, normal } }, md);
    console.log(md);
    // The harness measures; it does not gate. It only asserts it produced a result for every run.
    expect(single).toHaveLength(FAULTS.length * EVAL_SEEDS.length);
  });
});
