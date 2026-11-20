/** Shared helpers for headless pipeline tests. */
import { SimulationAdapter } from '../adapters/SimulationAdapter';
import { formatOffset } from '../core/format';
import type { Incident } from '../core/types';
import { AtlasCore } from './AtlasCore';

export const TEST_SEED = 20260112;

export interface Rig {
  adapter: SimulationAdapter;
  core: AtlasCore;
  /** Advance the simulation by this many seconds of event time. */
  run(seconds: number): void;
  incident(): Incident | undefined;
}

export function boot(seed = TEST_SEED, prerollS = 120): Rig {
  const adapter = new SimulationAdapter(seed);
  const core = new AtlasCore(adapter);
  const run = (seconds: number) => {
    core.advance(Math.round(seconds / adapter.tickS));
  };
  run(prerollS);
  return { adapter, core, run, incident: () => core.intelligence.incidents()[0] };
}

/** Human-readable dump of what the pipeline concluded. Enabled with ATLAS_TRACE=1. */
export function trace(label: string, core: AtlasCore, sinceMs: number): void {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (!env?.ATLAS_TRACE) return;
  const lines: string[] = [`\n===== ${label} =====`];
  for (const e of core.timeline) {
    if (e.t < sinceMs) continue;
    lines.push(`${formatOffset(e.t - sinceMs).padEnd(8)} ${e.kind.padEnd(10)} ${e.severity.padEnd(8)} ${e.title}${e.kind === 'anomaly' ? `  [${e.signalId}]` : ''}`);
  }
  for (const inc of core.intelligence.incidents()) {
    lines.push(`--- ${inc.id} [${inc.status}/${inc.severity}] ${inc.title}`);
    lines.push(`    ${inc.summary}`);
    lines.push(`    origin: ${inc.origin?.assetId} (${inc.origin?.score.toFixed(2)})  assets: ${inc.assets.map((a) => a.assetId).join(', ')}`);
    for (const h of inc.hypotheses) {
      lines.push(`    H ${(h.support * 100).toFixed(0).padStart(3)}% ${h.band.padEnd(8)} ${h.title}`);
      for (const c of h.criteria) lines.push(`        ${c.role === 'supports' ? '+' : '-'} ${c.state === 'observed' ? '[x]' : '[ ]'} w${c.weight} ${c.description} :: ${c.detail}`);
    }
    lines.push(`    impact: ${inc.impact.map((i) => `${i.assetId}(${i.state},${i.exposure.toFixed(2)})`).join(' ')}`);
    for (const r of inc.recommendations) lines.push(`    R${r.priority} ${r.text}`);
  }
  console.log(lines.join('\n'));
}
