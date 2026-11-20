/**
 * Records the ~90-second Vanterra demo as a WebM video from the running application.
 *
 *   1. npm run dev        2. npm run record-demo   ->  docs/demo/vanterra-demo.webm
 *
 * How: Edge (or Chrome) is driven by playwright-core; the DevTools screencast streams
 * real frames of the app; afterwards the same browser replays those frames into a canvas
 * at their original timing, draws the captions from the script, and encodes the canvas
 * with MediaRecorder. Nothing is downloaded and nothing is staged: every frame is the
 * product running the cyber-physical scenario.
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const URL = process.env.ATLAS_URL ?? 'http://localhost:5173';
const OUT_DIR = join(process.cwd(), 'docs', 'demo');
const W = 1440;
const H = 900;
const executablePath = [
  process.env.ATLAS_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]
  .filter(Boolean)
  .find((p) => existsSync(p));
if (!executablePath) throw new Error('No Chromium-based browser found. Set ATLAS_BROWSER.');
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ executablePath, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const sleep = (ms) => page.waitForTimeout(ms);
async function click(pattern, within = 'body') {
  return page.evaluate(
    ([src, flags, sel]) => {
      const re = new RegExp(src, flags);
      const root = document.querySelector(sel);
      const b = root && [...root.querySelectorAll('button')].find((x) => re.test(x.innerText.trim()) && x.getBoundingClientRect().width > 0);
      if (b) b.click();
      return !!b;
    },
    [pattern.source, pattern.flags, within],
  );
}
const view = (label) => click(new RegExp(`^${label}$`, 'i'), '.views');
const selectRow = (text) => page.evaluate((t) => [...document.querySelectorAll('.row')].find((r) => r.innerText.includes(t))?.click(), text);
const scrollIn = (selector, by) => page.evaluate(([s, y]) => document.querySelector(s)?.scrollBy({ top: y, behavior: 'smooth' }), [selector, by]);

// ------------------------------------------------------------- capture
await page.goto(URL);
await page.evaluate(() => localStorage.setItem('atlas.welcome.dismissed.v2', '1'));
await page.reload();
await sleep(3500);

const frames = [];
const captions = [];
const cdp = await page.context().newCDPSession(page);
cdp.on('Page.screencastFrame', async (f) => {
  frames.push({ t: f.metadata.timestamp * 1000, data: f.data });
  await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 82, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
const t0 = Date.now();
const say = (text) => captions.push({ at: Date.now() - t0, text });

say('Vanterra — cyber-physical intelligence. A simulated plant and its OT network, investigated together.');
await sleep(6000);
await page.evaluate(() => [...document.querySelectorAll('.demo')].find((d) => d.innerText.includes('C · Cyber-physical'))?.querySelector('button')?.click());
say('A vendor account reaches the engineering workstation outside any approved change window…');
await sleep(4000);
await view('Cyber & OT');
await sleep(2500);
say('…and lowers the cooling-tower fan speed on controller PLC-500 from 100 % to 35 %.');
await sleep(2500);
await selectRow('Unapproved setting change');
say('No approved change record matches: different account, value outside the approved range.');
await sleep(7500);
await view('Overview');
say('Seconds later the process deviates. A critical incident opens at the cooling tower, from sensor data alone.');
await sleep(7000);
await page.evaluate(() => document.querySelector('.pane--attention .row')?.click());
await sleep(1200);
say('The link is declared, not guessed: PLC-500 controls CT-401. The change came first, and the expected signals moved.');
await sleep(10000);
await scrollIn('.investigation .rail__scroll', 380);
say('Competing explanations are tested. An equipment fault is not supported: no trip, no high vibration.');
await sleep(9500);
await scrollIn('.investigation .rail__scroll', 520);
say('What remains unknown is stated: who used the account, and whether the change was malicious.');
await sleep(7500);
await click(/^Overview/i, '.investigation');
say('Rule-based, AI-assisted, human and cyber-physical verdicts side by side.');
await sleep(6000);
await click(/^Hypotheses/i, '.investigation');
await sleep(800);
await click(/mark confirmed/i, '.investigation');
say('Vanterra recommends. Only a person confirms.');
await sleep(4500);
await click(/^Overview/i, '.investigation');
say('Conclusion: a control-system change is supported. Intent is not established.');
await sleep(7000);
await cdp.send('Page.stopScreencast');
const durationMs = Date.now() - t0;
console.log(`captured ${frames.length} frames over ${(durationMs / 1000).toFixed(1)} s`);

// ------------------------------------------------------------- encode
const base = frames[0].t;
const timeline = frames.map((f) => ({ at: Math.max(0, f.t - base) }));
const server = createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>encoder</title><body></body>');
    return;
  }
  const m = /^\/frame\/(\d+)$/.exec(req.url ?? '');
  if (m) {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*' });
    res.end(Buffer.from(frames[Number(m[1])].data, 'base64'));
    return;
  }
  if (req.url === '/upload' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      writeFileSync(join(OUT_DIR, 'vanterra-demo.webm'), Buffer.concat(chunks));
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
      res.end('ok');
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const enc = await browser.newPage({ viewport: { width: 400, height: 300 } });
await enc.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
const result = await enc.evaluate(
  async ({ port, timeline, captions, durationMs, W, H }) => {
    const OUT_W = 1280;
    const OUT_H = 800;
    const canvas = document.createElement('canvas');
    canvas.width = OUT_W;
    canvas.height = OUT_H;
    const g = canvas.getContext('2d');
    const load = (i) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = `http://127.0.0.1:${port}/frame/${i}`;
      });
    const wrap = (text, max) => {
      const words = text.split(' ');
      const lines = [];
      let line = '';
      for (const w of words) {
        const next = line ? `${line} ${w}` : w;
        if (g.measureText(next).width > max && line) {
          lines.push(line);
          line = w;
        } else line = next;
      }
      if (line) lines.push(line);
      return lines;
    };
    const drawCaption = (text) => {
      g.font = '500 25px "Segoe UI", Inter, sans-serif';
      const lines = wrap(text, OUT_W - 220);
      const h = 26 + lines.length * 34;
      g.fillStyle = 'rgba(8, 11, 16, 0.86)';
      g.fillRect(80, OUT_H - h - 40, OUT_W - 160, h);
      g.fillStyle = '#5e9bff';
      g.fillRect(80, OUT_H - h - 40, 4, h);
      g.fillStyle = '#e6edf3';
      lines.forEach((l, i) => g.fillText(l, 110, OUT_H - h - 40 + 38 + i * 34));
    };
    const card = (title, sub) => {
      g.fillStyle = '#0a0d12';
      g.fillRect(0, 0, OUT_W, OUT_H);
      g.fillStyle = '#dce4eb';
      g.font = '600 54px "Segoe UI", Inter, sans-serif';
      g.textAlign = 'center';
      g.fillText(title, OUT_W / 2, OUT_H / 2 - 10);
      g.font = '400 24px "Segoe UI", Inter, sans-serif';
      g.fillStyle = '#8d9aa8';
      g.fillText(sub, OUT_W / 2, OUT_H / 2 + 40);
      g.textAlign = 'left';
    };
    const stream = canvas.captureStream(25);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1_400_000 });
    const parts = [];
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    const done = new Promise((r) => (rec.onstop = r));
    rec.start(1000);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    const intro = 2500;
    const outro = 3000;
    const startIntro = performance.now();
    while (performance.now() - startIntro < intro) {
      card('VANTERRA', 'Cyber-physical intelligence · simulated environment');
      await wait(40);
    }
    // Replay the captured frames at their original timing, a few frames preloaded ahead.
    const cache = new Map();
    const want = (i) => {
      if (i < timeline.length && !cache.has(i)) cache.set(i, load(i));
    };
    for (let i = 0; i < 12; i++) want(i);
    const start = performance.now();
    let shown = -1;
    for (;;) {
      const now = performance.now() - start;
      if (now > durationMs) break;
      let idx = shown;
      while (idx + 1 < timeline.length && timeline[idx + 1].at <= now) idx++;
      if (idx >= 0) {
        for (let k = idx; k < idx + 12; k++) want(k);
        const img = await cache.get(idx);
        if (img) g.drawImage(img, 0, 0, W, H, 0, 0, OUT_W, OUT_H);
        for (const k of cache.keys()) if (k < idx) cache.delete(k);
        shown = idx;
      }
      const cap = [...captions].reverse().find((c) => c.at <= now);
      if (cap) drawCaption(cap.text);
      await wait(30);
    }
    const startOutro = performance.now();
    while (performance.now() - startOutro < outro) {
      card('Investigate the physical and the digital together.', 'Simulated plant and OT network · deterministic core · optional AI review · human confirmation');
      await wait(40);
    }
    rec.stop();
    await done;
    const blob = new Blob(parts, { type: 'video/webm' });
    await fetch(`http://127.0.0.1:${port}/upload`, { method: 'POST', body: blob });
    return { bytes: blob.size, mime };
  },
  { port, timeline, captions, durationMs, W, H },
);
console.log(`encoded ${(result.bytes / 1e6).toFixed(1)} MB (${result.mime}) -> docs/demo/vanterra-demo.webm`);
server.close();
await browser.close();
