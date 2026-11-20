/**
 * Text colours must stay readable: WCAG 2 AA requires a contrast ratio of at least 4.5:1
 * for normal-size text. Checked against the page background and the solid panel colour.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
const token = (name: string) => {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`--${name} not found`);
  return m[1];
};
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('text contrast (WCAG 2 AA)', () => {
  for (const text of ['text', 'text-dim', 'text-faint', 'cyan', 'cyber', 'ai', 'amber', 'ok']) {
    for (const bg of ['bg', 'panel-solid']) {
      it(`--${text} on --${bg} is at least 4.5:1`, () => {
        expect(contrast(token(text), token(bg))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
