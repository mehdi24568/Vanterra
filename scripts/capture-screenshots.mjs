/**
 * Captures the README / portfolio screenshots from the running application.
 *
 *   1. npm run dev   (AI review appears as configured: a real key, the labelled test
 *      double, or "unavailable" - the screenshots show whichever is true)
 *   2. npm run capture
 *
 * Uses an installed Chromium-based browser (Edge or Chrome) through playwright-core;
 * nothing is downloaded. Override with ATLAS_BROWSER=<path to browser executable>.
 * Output: docs/screenshots/*.png, 1440x900 unless noted.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const URL = process.env.ATLAS_URL ?? 'http://localhost:5173';
const OUT = join(process.cwd(), 'docs', 'screenshots');
const CANDIDATES = [
  process.env.ATLAS_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const executablePath = CANDIDATES.find((p) => existsSync(p));
if (!executablePath) throw new Error('No Chromium-based browser found. Set ATLAS_BROWSER to its executable.');

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (f.endsWith('.png')) rmSync(join(OUT, f));

const browser = await chromium.launch({ executablePath, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const sleep = (ms) => page.waitForTimeout(ms);

/** Click the first visible button whose text matches, optionally inside a container. */
async function click(pattern, within = 'body') {
  const ok = await page.evaluate(
    ([src, flags, sel]) => {
      const re = new RegExp(src, flags);
      const root = document.querySelector(sel);
      const b = root && [...root.querySelectorAll('button')].find((x) => re.test(x.innerText.trim()) && x.getBoundingClientRect().width > 0);
      if (b) b.click();
      return !!b;
    },
    [pattern.source, pattern.flags, within],
  );
  if (!ok) console.warn(`  (no button matching ${pattern} in ${within})`);
  return ok;
}
async function shot(name, note) {
  await sleep(800);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`  ${name}.png  ${note}`);
}
const view = (label) => click(new RegExp(`^${label}$`, 'i'), '.views');
async function runScenario(label) {
  await view('Overview');
  await page.evaluate((l) => [...document.querySelectorAll('.demo')].find((d) => d.innerText.includes(l))?.querySelector('button')?.click(), label);
}
async function selectRow(text) {
  await page.evaluate((t) => [...document.querySelectorAll('.row')].find((r) => r.innerText.includes(t))?.click(), text);
  await sleep(500);
}

console.log(`Capturing ${URL} with ${executablePath}`);
await page.goto(URL);
await page.evaluate(() => localStorage.removeItem('atlas.welcome.dismissed.v2'));
await page.reload();
await sleep(3500);
await shot('01-welcome', 'first-run welcome');
await click(/explore on my own/i);
await sleep(1200);
await shot('02-overview-normal', 'overview, plant and OT network normal');

// Flagship: cyber-physical scenario.
await runScenario('C · Cyber-physical');
await sleep(24_000);
await shot('03-overview-cyber-physical', 'overview during the cyber-physical scenario');
await view('Cyber & OT');
await sleep(600);
await selectRow('CYB-0001');
await shot('04-cyber-case', 'Cyber & OT: zone map, case, potential physical impact');
await selectRow('Unapproved setting change');
await shot('05-cyber-event', 'unapproved change: evidence, rationale, limitations, ATT&CK context');
await click(/open cyber-physical assessment/i, '.pane--detail');
await sleep(1800);
await shot('06-workbench-cyber-physical', 'workbench: what the evidence supports, explanations, unknowns');
await click(/show ot layer in 3d/i, '.investigation');
await sleep(1500);
await shot('07-spatial-ot-layer', 'spatial view with the OT layer and the focused incident');
await click(/^Overview/i, '.investigation');
await shot('08-workbench-overview', 'rule-based, AI-assisted, human and cyber-physical side by side');
await click(/^AI review/i, '.investigation');
await shot('09-ai-review', 'AI review as configured on this machine');
await click(/^Hypotheses/i, '.investigation');
await sleep(400);
await click(/mark confirmed/i, '.investigation');
await sleep(500);
await click(/^Overview/i, '.investigation');
await shot('10-human-verification', 'operator verdict recorded beside the automated assessments');

// Contrast: a physical fault with no cyber evidence.
await runScenario('A · Physical anomaly');
await sleep(22_000);
await page.evaluate(() => document.querySelector('.pane--attention .row')?.click());
await sleep(1500);
await click(/^Cyber-physical/i, '.investigation');
await shot('11-physical-no-cyber', 'pump fault: physical explanation supported, absence of cyber evidence stated');

// Narrow layouts.
await page.setViewportSize({ width: 820, height: 1000 });
await view('Overview');
await shot('12-narrow-overview', 'overview at 820 px');
await page.setViewportSize({ width: 700, height: 900 });
await view('Cyber & OT');
await shot('13-narrow-cyber', 'Cyber & OT at 700 px');

await browser.close();
console.log(`Done: ${OUT}`);
