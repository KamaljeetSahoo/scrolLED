#!/usr/bin/env node
// Smoke test against a running static server (default http://127.0.0.1:8080/).
// Usage: npx serve -l 8080 .   then   node tools/qa.mjs [baseUrl]
// Checks: boot completes, no page errors, service worker activates, state round-trips
// through the URL hash, present mode enters/exits (incl. back button), Canvas2D fallback.
import path from 'node:path';
import { execSync } from 'node:child_process';

async function loadPlaywright() {
  try { return await import('playwright'); }
  catch (e) { return import(path.join(execSync('npm root -g').toString().trim(), 'playwright', 'index.mjs')); }
}
const { chromium } = await loadPlaywright();
const base = process.argv[2] || 'http://127.0.0.1:8080/';
const GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`); if (!ok) failures++; };

async function withPage(args, viewport, fn) {
  const browser = await chromium.launch({ args });
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  try { await fn(page, errors); } finally { await browser.close(); }
}

await withPage(GL, { width: 390, height: 844 }, async (page, errors) => {
  await page.goto(base + '#m=QA+%E2%99%A5&f=bungee&c=cyan&s=70&z=30&d=r&sh=s&mo=st&a=1&g=2', { waitUntil: 'load' });
  const booted = await page.waitForFunction(() => !document.body.classList.contains('booting'), null, { timeout: 15000 }).then(() => true).catch(() => false);
  check('boot completes', booted);
  await page.waitForTimeout(2500);
  const st = await page.evaluate(() => ({
    text: document.querySelector('#msg').value,
    font: document.querySelector('#fonts [aria-checked="true"]').dataset.id,
    color: document.querySelector('#colors [aria-checked="true"]').dataset.id,
    speed: document.querySelector('#speed').value, rows: window.scrolled.state.rows,
    dir: window.scrolled.state.dir, shape: window.scrolled.state.shape, motion: window.scrolled.state.motion,
    after: window.scrolled.state.afterglow, glow: window.scrolled.state.glow,
    webgl: window.scrolled.engine.isWebGL, fps: window.scrolled.engine.stats.fps,
  }));
  check('hash state round-trips', st.text === 'QA ♥' && st.font === 'bungee' && st.color === 'cyan' && st.speed === '70' && st.rows === 30 && st.dir === 'right' && st.shape === 'square' && st.motion === 'stepped' && st.after === true && st.glow === 2, JSON.stringify(st));
  check('WebGL renderer active', st.webgl);
  const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return r && r.active ? 'active' : 'none'; });
  check('service worker active', sw === 'active', sw);
  await page.fill('#msg', 'HELLO THERE');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  check('typing then Enter blurs and restores controls', await page.evaluate(() => document.activeElement.id !== 'msg' && !document.body.classList.contains('typing')));
  await page.click('#presentBtn');
  await page.waitForTimeout(1200);
  const pres = await page.evaluate(() => ({ present: document.body.classList.contains('present'), angle: window.scrolled.engine.angle, hist: !!(history.state && history.state.present) }));
  check('present mode enters (rotated in portrait)', pres.present && pres.angle === 90 && pres.hist, JSON.stringify(pres));
  await page.goBack();
  await page.waitForTimeout(800);
  check('back button exits present', await page.evaluate(() => !document.body.classList.contains('present')));
  check('no page errors (WebGL run)', errors.length === 0, errors.join(' | '));
});

await withPage(['--disable-3d-apis'], { width: 390, height: 844 }, async (page, errors) => {
  await page.goto(base + '#m=FALLBACK', { waitUntil: 'load' });
  const booted = await page.waitForFunction(() => !document.body.classList.contains('booting'), null, { timeout: 15000 }).then(() => true).catch(() => false);
  check('boot completes without WebGL', booted);
  const webgl = await page.evaluate(() => window.scrolled.engine.isWebGL);
  check('Canvas2D fallback used', webgl === false);
  check('no page errors (fallback run)', errors.length === 0, errors.join(' | '));
});

await withPage(GL, { width: 1280, height: 800 }, async (page, errors) => {
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => !document.body.classList.contains('booting'), null, { timeout: 15000 }).catch(() => {});
  const side = await page.evaluate(() => document.querySelector('#sheet').getBoundingClientRect().left > innerWidth * 0.5);
  check('desktop uses side panel layout', side);
  check('no page errors (desktop run)', errors.length === 0, errors.join(' | '));
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
