/**
 * Captures the Finance view (flagship "masked decline" scenario) to docs/screenshots/.
 * Needs the dev server (npm run dev). Uses the installed Edge or Chrome; downloads nothing.
 *
 *   node scripts/capture-finance.mjs
 */
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const URL = process.env.ATLAS_URL ?? 'http://localhost:5173';
const executablePath = [process.env.ATLAS_BROWSER, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/google-chrome']
  .filter(Boolean)
  .find((p) => existsSync(p));
if (!executablePath) throw new Error('No Chromium-based browser found. Set ATLAS_BROWSER.');

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 1440, height: 1500 }, deviceScaleFactor: 1 });
await page.goto(URL, { waitUntil: 'load' });
const explore = page.locator('button', { hasText: 'Explore on my own' });
if (await explore.isVisible({ timeout: 10_000 }).catch(() => false)) await explore.click();
await page.locator('.topbar button', { hasText: 'Finance' }).click();
await page.locator('.fin-bridge').waitFor();
await page.waitForTimeout(500);
await page.screenshot({ path: 'docs/screenshots/14-finance-masked-decline.png', fullPage: false });
await browser.close();
console.log('docs/screenshots/14-finance-masked-decline.png');
