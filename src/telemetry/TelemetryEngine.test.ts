import { describe, expect, it } from 'vitest';
import { FACILITY } from '../simulation/facility';
import { TelemetryEngine } from './TelemetryEngine';

const signals = FACILITY.assets.flatMap((a) => a.signals);

describe('TelemetryEngine', () => {
  it('normalises units, attaches metadata and stores history', () => {
    const tel = new TelemetryEngine(signals);
    const out = tel.ingest(
      [
        { tag: 'P-101.VIB', ts: 1000, value: 2.2 },
        { tag: 'AC-610.DISCH_P', ts: 1000, value: 101.5, unit: 'psi' },
        { tag: 'TX-501.OIL_TEMP', ts: 1000, value: 136.4, unit: 'degF' },
      ],
      'test',
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ assetId: 'P-101', signalId: 'P-101.VIB', type: 'vibration', unit: 'mm/s', quality: 'good', source: 'test' });
    expect(tel.latest('AC-610.DISCH_P')).toBeCloseTo(7.0, 1);
    expect(tel.latest('TX-501.OIL_TEMP')).toBeCloseTo(58, 0);
    expect(tel.stats.converted).toBe(2);
    expect(tel.now).toBe(1000);
  });

  it('rejects unknown tags, non-finite values and wildly out-of-range readings', () => {
    const tel = new TelemetryEngine(signals);
    const out = tel.ingest(
      [
        { tag: 'NOT-A-TAG', ts: 1, value: 1 },
        { tag: 'P-101.VIB', ts: 1, value: Number.NaN },
        { tag: 'P-101.VIB', ts: 1, value: 9999 },
      ],
      'test',
    );
    expect(out).toHaveLength(0);
    expect(tel.stats).toMatchObject({ accepted: 0, rejected: 3, unknownTags: 1 });
    expect(tel.latest('P-101.VIB')).toBeUndefined();
  });

  it('marks readings in an unrecognised unit as uncertain rather than trusting them', () => {
    const tel = new TelemetryEngine(signals);
    const [obs] = tel.ingest([{ tag: 'P-101.BRG_TEMP', ts: 1, value: 56, unit: 'furlongs' }], 'test');
    expect(obs.quality).toBe('uncertain');
  });

  it('keeps a bounded ring of history in chronological order', () => {
    const tel = new TelemetryEngine(signals, 8);
    for (let i = 1; i <= 20; i++) tel.ingest([{ tag: 'P-101.VIB', ts: i * 250, value: i }], 'test');
    const series = tel.read('P-101.VIB', 0, { t: [], v: [] });
    expect(series.v).toEqual([13, 14, 15, 16, 17, 18, 19, 20]);
    expect(tel.read('P-101.VIB', 19 * 250, { t: [], v: [] }).v).toEqual([19, 20]);
    expect(tel.mean('P-101.VIB', 19 * 250, 20 * 250)).toBe(19.5);
    expect(tel.freshSignalCount(1000)).toBe(1);
  });
});
