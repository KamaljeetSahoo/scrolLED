#!/usr/bin/env node
// Captures the manifest screenshots and the Open Graph image from the running app.
// Usage: node tools/make-screenshots.mjs [baseUrl]   (default http://127.0.0.1:8080/)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

async function loadPlaywright() {
  try { return await import('playwright'); }
  catch (e) { return import(path.join(execSync('npm root -g').toString().trim(), 'playwright', 'index.mjs')); }
}
const { chromium } = await loadPlaywright();
const base = process.argv[2] || 'http://127.0.0.1:8080/';
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ args });

async function shot(file, { width, height, dpr, hash, present = false, settle = 2500 }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(base + hash, { waitUntil: 'load' });
  await page.evaluate(() => { try { sessionStorage.setItem('scrolled.booted', '1'); } catch (e) {} });
  await page.waitForFunction(() => !document.body.classList.contains('booting'), null, { timeout: 10000 });
  if (present) { await page.click('#presentBtn'); }
  await page.waitForTimeout(settle);
  await page.screenshot({ path: path.join(out, file) });
  await ctx.close();
  console.log('wrote icons/' + file);
}
await shot('screenshot-narrow.png', { width: 390, height: 844, dpr: 2, hash: '#m=CALL+ME+MAYBE+%E2%99%A5&c=amber' });
await shot('screenshot-wide.png', { width: 844, height: 390, dpr: 2, hash: '#m=HELLO+WORLD&f=bungee&c=cyan', present: true });
await shot('og.png', { width: 1200, height: 630, dpr: 1, hash: '#m=HEYhash: '#m=HI+%E2%99%A5&f=pixelbold&c=red&z=20&s=0', present: true, settle: 3200f=pixelhash: '#m=HI+%E2%99%A5&f=pixelbold&c=red&z=20&s=0', present: true, settle: 3200c=redhash: '#m=HI+%E2%99%A5&f=pixelbold&c=red&z=20&s=0', present: true, settle: 3200z=20hash: '#m=HI+%E2%99%A5&f=pixelbold&c=red&z=20&s=0', present: true, settle: 3200s=0', present: true, settle: 3500 });
await browser.close();
