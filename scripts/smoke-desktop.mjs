/**
 * Smoke test of the packaged desktop app (release/win-unpacked/Vanterra.exe):
 * launches it, waits for the UI, checks the AI service through app://, runs the flagship
 * scenario, opens the incident's Ask tab, asks a quick (engine) question, checks the 3D
 * canvas, reads the Finance view's verdict, checks console errors, and saves a screenshot.
 * Optionally asks the model one
 * question when SMOKE_ASK_MODEL=1 (slow on a CPU).
 *
 *   npm run desktop:dist && node scripts/smoke-desktop.mjs [screenshot.png]
 */
import { _electron as electron } from 'playwright-core';

const exe = process.env.VANTERRA_EXE ?? 'release/win-unpacked/Vanterra.exe';
const shot = process.argv[2] ?? 'release/smoke.png';
// A separate data folder lets the test run next to an installed, running Vanterra.
const userData = process.env.SMOKE_USER_DATA;
const app = await electron.launch({ executablePath: exe, timeout: 60_000, args: userData ? [`--user-data-dir=${userData}`] : [] });
const pid = app.process().pid;
const page = await app.firstWindow();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
await page.waitForSelector('text=Overview', { timeout: 60_000 });

const result = { pid, url: page.url(), title: await page.title() };
result.aiStatus = await page.evaluate(async () => (await fetch('/api/ai/status')).json());
result.webgl2 = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));

// First-run path: the welcome card's "Run the cyber-physical scenario" → incident → Ask.
// A returning user has no welcome card: use the Overview's scenario C instead.
const welcome = page.locator('button', { hasText: 'Run the cyber-physical scenario' });
if (await welcome.isVisible({ timeout: 5000 }).catch(() => false)) await welcome.click();
else await page.locator('button', { hasText: /run scenario/i }).nth(2).click();
await page.locator('button', { hasText: 'INC-0001' }).first().waitFor({ timeout: 90_000 });
await page.locator('button', { hasText: 'INC-0001' }).first().click();
await page.locator('[role=tab]', { hasText: /^Ask/ }).click();
await page.locator('button', { hasText: 'Should security be involved?' }).click();
result.engineAnswer = await page.locator('.ask__msg--engine .ask__text').first().textContent();
await page.locator('[role=tab]', { hasText: /^AI review/ }).click();
result.aiTabButtons = await page.locator('.button-row button').allTextContents();
await page.locator('[role=tab]', { hasText: /^Ask/ }).click();

if (process.env.SMOKE_ASK_MODEL === '1') {
  await page.fill('#ask-input', 'What changed on the cooling tower, and when?');
  await page.keyboard.press('Enter');
  await page.locator('.ask__msg--model:not(.ask__msg--pending)').first().waitFor({ timeout: 600_000 });
  result.modelAnswer = await page.locator('.ask__msg--model').first().evaluate((m) => ({
    state: m.className,
    source: m.querySelector('.ask__source')?.textContent,
    text: m.querySelector('.ask__text')?.textContent ?? m.querySelector('.ask__rejected')?.textContent,
  }));
}

await page.keyboard.press('2'); // Spatial (3D) view
await page.waitForTimeout(3000);
result.canvases = await page.locator('canvas').count();
await page.keyboard.press('4'); // Finance view
await page.locator('.fin-verdict__label').waitFor({ timeout: 15_000 });
result.financeVerdict = `${await page.locator('.fin-verdict__label').textContent()}: ${await page.locator('.fin-verdict__answer').textContent()}`;
await page.keyboard.press('2');
await page.waitForTimeout(1000);
await page.screenshot({ path: shot });
result.consoleErrors = errors;
console.log(JSON.stringify(result, null, 2));
await app.close();
