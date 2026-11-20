import { describe, expect, it } from 'vitest';
import { FACILITY } from '../simulation/facility';
import { AssetGraph } from './AssetGraph';

const graph = new AssetGraph(FACILITY.assets, FACILITY.relations);
const never = () => false;

describe('AssetGraph', () => {
  it('loads a consistent asset model', () => {
    expect(graph.relations).toHaveLength(FACILITY.relations.length);
    expect(graph.connectedCount()).toBe(FACILITY.assets.length);
    const ids = FACILITY.assets.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    const signalIds = FACILITY.assets.flatMap((a) => a.signals.map((s) => s.id));
    expect(new Set(signalIds).size).toBe(signalIds.length);
  });

  it('finds the shortest dependency path and records direction per step', () => {
    const found = graph.findPath('RX-301', new Set(['P-101']), { maxHops: 5, allowSiblingVia: never })!;
    expect(found.path.map((s) => s.to)).toEqual(['PL-120', 'HX-201', 'PL-110', 'P-101']);
    expect(found.path.every((s) => s.direction === 'upstream')).toBe(true);
    const drive = graph.findPath('M-101', new Set(['P-101']), { maxHops: 3, allowSiblingVia: never })!;
    expect(drive.path).toHaveLength(1);
    expect(drive.path[0].direction).toBe('downstream');
    expect(drive.path[0].relation).toBe('mechanical');
  });

  it('respects the hop limit', () => {
    expect(graph.findPath('RX-301', new Set(['P-101']), { maxHops: 3, allowSiblingVia: never })).toBeNull();
  });

  it('does not relate two consumers merely because they share a supply', () => {
    const viaBoard = graph.findPath('M-101', new Set(['M-401']), { maxHops: 3, allowSiblingVia: never });
    expect(viaBoard).toBeNull();
    const implicated = graph.findPath('M-101', new Set(['M-401']), { maxHops: 3, allowSiblingVia: (id) => id === 'MCC-510' });
    expect(implicated?.path.map((s) => s.to)).toEqual(['MCC-510', 'M-401']);
  });

  it('can refuse to relate two suppliers through a consumer they share', () => {
    // The feed header and the cooling-water supply both end at the process cooler.
    const allowed = graph.findPath('PL-110', new Set(['PL-410']), { maxHops: 3, allowSiblingVia: never });
    expect(allowed?.path.map((s) => s.to)).toEqual(['HX-201', 'PL-410']);
    const refused = graph.findPath('PL-110', new Set(['PL-410']), { maxHops: 3, allowSiblingVia: never, allowConvergeVia: never });
    expect(refused).toBeNull();
  });

  it('lets a caller veto a path that ends at an unimplicated supplier', () => {
    const q = { maxHops: 3, allowSiblingVia: never, acceptTarget: (_id: string, arrival: 'downstream' | 'upstream') => arrival === 'downstream' };
    expect(graph.findPath('MCC-520', new Set(['TX-501']), q)).toBeNull();
    expect(graph.findPath('TX-501', new Set(['MCC-520']), q)?.path).toHaveLength(1);
  });

  it('propagates a process disturbance downstream but barely into the cooling loop', () => {
    const reach = graph.propagate('P-101');
    for (const id of ['PL-110', 'HX-201', 'PL-120', 'RX-301', 'FL-310']) expect(reach.has(id), id).toBe(true);
    expect(reach.has('CT-401')).toBe(false);
    expect(reach.get('PL-110')!.exposure).toBeGreaterThan(reach.get('FL-310')!.exposure);
    // A cooling problem, by contrast, does reach the process it serves.
    expect(graph.propagate('CT-401').has('RX-301')).toBe(true);
  });

  it('reflects load up mechanical and electrical supply chains, but not back down to siblings', () => {
    const reach = graph.influenceReach('P-101');
    for (const id of ['M-101', 'MCC-510', 'TX-501', 'RX-301']) expect(reach.has(id), id).toBe(true);
    // Its own suppliers and the standby train are not influenced by it.
    for (const id of ['TK-101', 'PL-100', 'P-102', 'M-102', 'LS-601']) expect(reach.has(id), id).toBe(false);
    // Load reflects up from the motor to its board, but not back down to the board's other consumers.
    const fromMotor = graph.influenceReach('M-401');
    expect(fromMotor.has('MCC-510')).toBe(true);
    expect(fromMotor.has('M-101')).toBe(false);
  });

  it('ignores relations that reference unknown assets instead of failing', () => {
    const g = new AssetGraph(FACILITY.assets.slice(0, 3), [
      { id: 'X1', from: 'TK-101', to: 'NOPE', type: 'process', medium: 'x', description: '' },
    ]);
    expect(g.relations).toHaveLength(0);
  });
});
