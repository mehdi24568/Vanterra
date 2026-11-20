/** Writes evaluation results to eval/results/ as JSON (machine-readable) and Markdown (for EVALUATION.md). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const RESULTS_DIR = join(process.cwd(), 'eval', 'results');

export function writeResults(name: string, data: unknown, markdown: string): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(join(RESULTS_DIR, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  writeFileSync(join(RESULTS_DIR, `${name}.md`), `${markdown.trim()}\n`, 'utf8');
}

export const pct = (x: number | null) => (x === null || !Number.isFinite(x) ? 'n/a' : `${(x * 100).toFixed(1)} %`);
export const num = (x: number | null, digits = 1) => (x === null || !Number.isFinite(x) ? 'n/a' : x.toFixed(digits));

export function stats(xs: number[]): { n: number; mean: number | null; median: number | null; min: number | null; max: number | null } {
  if (!xs.length) return { n: 0, mean: null, median: null, min: null, max: null };
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return {
    n: s.length,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    median: s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2,
    min: s[0],
    max: s[s.length - 1],
  };
}

export function table(header: string[], rows: (string | number)[][]): string {
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}
