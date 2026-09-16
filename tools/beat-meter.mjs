#!/usr/bin/env node
// Measure how much the sign actually changes between a quiet moment and a beat.
//
// The complaint that started this was "the mic to visual feedback is not really
// noticeable", and opinions about that are hard to settle by looking. So this
// renders the sign in Present mode at a series of forced (pulse, beat) values,
// screenshots each one and reports how far the pixels moved. A change nobody can
// see scores near zero here no matter how impressive the code looks.
//
// Usage: node tools/beat-meter.mjs [baseUrl]
import path from 'node:path';
import { execSync } from 'node:child_process';

async function loadPlaywright() {
  try { return await import('playwright'); }
  catch (e) { return import(path.join(execSync('npm root -g').toString().trim(), 'playwright', 'index.mjs')); }
}
const { chromium } = await loadPlaywright();
const base = process.argv[2] || 'http://127.0.0.1:8080/';
const GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

// (pulse, beat) pairs: a quiet bar, then the moment a kick lands.
const FRAMES = [
  ['quiet', 0, 0],
  ['sustained', 0.7, 0],
  ['beat', 0.7, 1],
  ['hard beat', 1, 1],
];

const browser = await chromium.launch({ args: GL, executablePath: process.env.PW_CHROME || undefined });
const ctx = await browser.newContext({ viewport: { width: 852, height: 393 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(() => !document.body.classList.contains('booting'), null, { timeout: 20000 });

await page.fill('#msg', 'DANCE');
await page.waitForTimeout(400);
await page.click('#presentBtn');
await page.waitForTimeout(1200);

// Freeze the scroll so frame-to-frame differences are the beat and nothing else,
// and take the senses out of the loop so we can dial them by hand. Short text with
// speed 0 eases to the centre and stops, so give it time to actually arrive: a
// frame caught mid-slide would read as an enormous "beat response" that is really
// just the sign moving.
await page.evaluate(() => {
  const { engine, reactive } = window.scrolled;
  engine.setSpeed(0);
  reactive.update = function (dt) { return this; };   // hold whatever we set below
});
await page.waitForTimeout(2500);
// Speed 0 only parks text that fits the panel; anything longer keeps crawling so it
// is never stuck. Pin the position outright instead, so the only thing left moving
// is the effect under test.
await page.evaluate(() => {
  const e = window.scrolled.engine;
  const frozen = e.X;
  Object.defineProperty(e, 'X', { get: () => frozen, set: () => {}, configurable: true });
});
await page.waitForTimeout(600);

const set = (pulse, beat) => page.evaluate(({ pulse, beat }) => {
  const r = window.scrolled.reactive;
  r.level = pulse; r.motion = 0; r.pulse = pulse; r.beat = beat;
}, { pulse, beat });

// Prove the frame is stationary before trusting any of the numbers below.
await set(0, 0);
await page.waitForTimeout(450);
const still = [(await page.screenshot({ type: 'png' })).toString('base64')];
await page.waitForTimeout(450);
still.push((await page.screenshot({ type: 'png' })).toString('base64'));

const shots = [];
for (const [name, pulse, beat] of FRAMES) {
  await set(pulse, beat);
  await page.waitForTimeout(450);          // let any eased uniform settle
  shots.push({ name, pulse, beat, png: (await page.screenshot({ type: 'png' })).toString('base64') });
}

// Decode and compare in a blank page: no image library needed.
const scratch = await ctx.newPage();
await scratch.setContent('<canvas id="a"></canvas><canvas id="b"></canvas>');
const measure = await scratch.evaluate(async ({ shots, still }) => {
  const load = (b64) => new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img); img.onerror = rej;
    img.src = 'data:image/png;base64,' + b64;
  });
  const pixels = async (b64) => {
    const img = await load(b64);
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0);
    return x.getImageData(0, 0, c.width, c.height).data;
  };
  const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  const delta = (a, b) => {
    let sum = 0, peak = 0, moved = 0, n = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.abs(lum(b, i) - lum(a, i));
      sum += d; if (d > peak) peak = d; if (d > 8) moved++; n++;
    }
    return { mean: sum / n, peak, movedPct: 100 * moved / n };
  };
  const drift = delta(await pixels(still[0]), await pixels(still[1]));
  const frames = [];
  for (const s of shots) frames.push({ ...s, data: await pixels(s.png) });
  const ref = frames[0].data;
  const rows = frames.map((f) => {
    let sum = 0, peak = 0, moved = 0, bright = 0, n = 0;
    for (let i = 0; i < f.data.length; i += 4) {
      const a = lum(ref, i), b = lum(f.data, i);
      const d = Math.abs(b - a);
      sum += d; if (d > peak) peak = d; if (d > 8) moved++;
      bright += b; n++;
    }
    return {
      name: f.name, pulse: f.pulse, beat: f.beat,
      meanDelta: +(sum / n).toFixed(2),          // average luminance shift vs the quiet frame, 0..255
      peakDelta: +peak.toFixed(1),               // the single most-changed pixel
      movedPct: +(100 * moved / n).toFixed(1),   // share of the screen that visibly changed
      meanLum: +(bright / n).toFixed(1),
    };
  });
  return { rows, drift: { mean: +drift.mean.toFixed(2), movedPct: +drift.movedPct.toFixed(1) } };
}, { shots, still });
const stats = measure.rows;

console.log(`\nbeat meter vs the quiet frame  (${base})\n`);
console.log(`  still-frame drift: mean ${measure.drift.mean}/255 over ${measure.drift.movedPct}% ` +
  `${measure.drift.mean < 0.5 ? '(stationary — numbers below are the beat)' : '*** THE SIGN IS STILL MOVING, NUMBERS BELOW ARE NOT TRUSTWORTHY ***'}\n`);
console.log('  frame            pulse  beat   mean Δlum   peak Δ   screen changed   mean lum');
for (const s of stats) {
  console.log(`  ${s.name.padEnd(16)} ${String(s.pulse).padEnd(6)} ${String(s.beat).padEnd(5)} ${String(s.meanDelta).padStart(9)} ${String(s.peakDelta).padStart(8)} ${(s.movedPct + '%').padStart(15)} ${String(s.meanLum).padStart(10)}`);
}
const hard = stats[stats.length - 1];
console.log(`\n  a beat should move a good share of the screen, not a handful of pixels.`);
console.log(`  hard beat: mean Δ ${hard.meanDelta}/255 over ${hard.movedPct}% of the screen\n`);
await browser.close();

// Gates. Before this was fixed a hard beat scored mean Δ 8.0 over 34.9%, which is
// what "not really noticeable" looks like as a number.
let bad = 0;
const gate = (name, ok, detail) => { console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + detail : ''}`); if (!ok) bad++; };
gate('the measurement frame was stationary', measure.drift.mean < 0.5, `drift ${measure.drift.mean}`);
gate('a beat moves most of the screen', hard.movedPct > 60, `${hard.movedPct}%`);
gate('a beat is a big change, not a nudge', hard.meanDelta > 15, `mean Δ ${hard.meanDelta}/255`);
gate('a beat reads on top of sustained energy',
  hard.meanDelta > stats[1].meanDelta * 2, `beat ${hard.meanDelta} vs sustained ${stats[1].meanDelta}`);
console.log(bad ? `\n${bad} check(s) failed\n` : '\nall checks passed\n');
process.exit(bad ? 1 : 0);
