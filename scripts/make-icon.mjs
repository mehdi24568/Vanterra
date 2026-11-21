/**
 * Renders the Vanterra mark (the same design as the favicon) to build/icon.png, 512 × 512,
 * which electron-builder turns into the Windows app and installer icon.
 * Uses the installed Edge or Chrome through playwright-core; downloads nothing.
 *
 *   npm run icon
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="512" height="512">
  <rect width="32" height="32" rx="6" fill="#0a0d12"/>
  <path d="M3 22 L16 6 L29 22" fill="none" stroke="#dce4eb" stroke-width="2" stroke-linejoin="round"/>
  <path d="M8.5 22 L16 13 L23.5 22" fill="none" stroke="#5e9bff" stroke-width="1.8" stroke-linejoin="round"/>
  <path d="M2 26.5 H30" stroke="#dce4eb" stroke-width="1.5" opacity=".55"/>
</svg>`;

const executablePath = [
  process.env.ATLAS_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
]
  .filter(Boolean)
  .find((p) => existsSync(p));
if (!executablePath) throw new Error('No Chromium-based browser found. Set ATLAS_BROWSER.');

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
await page.setContent(`<html><body style="margin:0;background:transparent">${SVG}</body></html>`);
const png = await page.locator('svg').screenshot({ omitBackground: true });
await browser.close();
mkdirSync('build', { recursive: true });
writeFileSync(join('build', 'icon.png'), png);
console.log(`build/icon.png written (${png.length} bytes)`);
