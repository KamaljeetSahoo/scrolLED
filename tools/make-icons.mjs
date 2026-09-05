#!/usr/bin/env node
// Renders the PWA icons with the real LED shader look using headless Chromium.
// Usage: node tools/make-icons.mjs   (requires a globally installed playwright)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

// Use a local playwright if installed, else the global one (npm i -g playwright).
async function loadPlaywright() {
  try { return await import('playwright'); }
  catch (e) {
    const root = execSync('npm root -g').toString().trim();
    return import(path.join(root, 'playwright', 'index.mjs'));
  }
}
const { chromium } = await loadPlaywright();

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'icons');
fs.mkdirSync(out, { recursive: true });

// A 7x7 LED arrow "double chevron" — the sign is always scrolling.
const PATTERN = [
  '.#...#.',
  '..#...#',
  '...#...',
  '#######',
  '...#...',
  '..#...#',
  '.#...#.',
];

const html = (size, { maskable = false, radius = 0.22, pad = 0.16 } = {}) => `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:transparent}canvas{display:block}</style>
<canvas id="c" width="${size}" height="${size}"></canvas>
<script>
const P = ${JSON.stringify(PATTERN)};
const S = ${size}, maskable = ${maskable};
const c = document.getElementById('c'), x = c.getContext('2d');
// background tile
const r = maskable ? 0 : S * ${radius};
x.beginPath(); x.roundRect(0, 0, S, S, r); x.fillStyle = '#0a0a0c'; x.fill();
const g = x.createLinearGradient(0, 0, 0, S); g.addColorStop(0, 'rgba(255,255,255,0.05)'); g.addColorStop(1, 'rgba(0,0,0,0)');
x.fillStyle = g; x.fill();
// LED grid
const n = 7, padF = maskable ? 0.24 : ${pad};
const inner = S * (1 - 2 * padF), pitch = inner / n, ox = S * padF, oy = S * padF;
const R = pitch * 0.34;
for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
  const cx = ox + i * pitch + pitch / 2, cy = oy + j * pitch + pitch / 2;
  const on = P[j][i] === '#';
  if (on) {
    x.globalCompositeOperation = 'lighter';
    const halo = x.createRadialGradient(cx, cy, R * 0.6, cx, cy, pitch * 1.1);
    halo.addColorStop(0, 'rgba(255,59,31,0.55)'); halo.addColorStop(1, 'rgba(255,59,31,0)');
    x.fillStyle = halo; x.beginPath(); x.arc(cx, cy, pitch * 1.1, 0, 7); x.fill();
    x.globalCompositeOperation = 'source-over';
    const dome = x.createRadialGradient(cx - R * 0.2, cy - R * 0.2, 0, cx, cy, R);
    dome.addColorStop(0, '#ffb39f'); dome.addColorStop(0.35, '#ff5a3c'); dome.addColorStop(1, '#d92a12');
    x.fillStyle = dome;
  } else {
    x.fillStyle = '#1c1c20';
  }
  x.beginPath(); x.arc(cx, cy, R, 0, 7); x.fill();
}
document.title = 'ready';
</script>`;

const browser = await chromium.launch();
async function render(file, size, opts) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => { console.error('icon page error:', e.message); process.exitCode = 1; });
  await page.setContent(html(size, opts));
  await page.waitForFunction(() => document.title === 'ready', null, { timeout: 10000 });
  await page.locator('#c').screenshot({ path: path.join(out, file), omitBackground: true });
  await page.close();
  console.log('wrote icons/' + file);
}
await render('icon-192.png', 192);
await render('icon-512.png', 512);
await render('maskable-512.png', 512, { maskable: true });
await render('apple-touch-icon.png', 180, { radius: 0, pad: 0.16 });
await browser.close();
