#!/usr/bin/env node
// Layout audit: boots the app in 11 viewports (iPhone Safari with toolbars, small
// Androids, landscape, tablet, desktop) and asserts nothing is clipped: preview
// band >= 100px, Present button on screen, scroll cues present whenever the
// controls scroll, no text clipped in chips, HUD inside the viewport in Present.
// Usage: npx serve -l 8080 .   then   node tools/audit-layout.mjs [baseUrl] [screenshotDir]
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
async function loadPlaywright() {
  try { return await import('playwright'); }
  catch (e) { return import(path.join(execSync('npm root -g').toString().trim(), 'playwright', 'index.mjs')); }
}
const { chromium } = await loadPlaywright();
const base = process.argv[2] || 'http://127.0.0.1:8080/';
const out = process.argv[3] || path.join(process.cwd(), 'audit-shots');
fs.mkdirSync(out, { recursive: true });
const VIEWPORTS = [
  ['iPhoneSE-safari', 375, 553], ['iPhoneSE', 375, 667], ['iPhone14Pro-safari', 393, 660], ['iPhone14Pro', 393, 852],
  ['iPhone15ProMax-safari', 430, 745], ['pixel7-chrome', 412, 780], ['smallAndroid', 360, 640], ['tiny', 320, 480],
  ['landscape-phone', 852, 393], ['iPad', 768, 1024], ['desktop', 1280, 800],
];
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const problems = [];
for (const [name, w, h] of VIEWPORTS) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: w < 800, hasTouch: w < 800 });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(base + '#m=BOLE+CHUDIYA&f=bungee&z=40', { waitUntil: 'load' });
  await p.evaluate(() => { try { sessionStorage.setItem('scrolled.booted', '1'); localStorage.setItem('scrolled.v1', JSON.stringify({ recents: ['EK GANNA BOLO', 'SHOTS'] })); } catch (e) {} });
  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction(() => !document.body.classList.contains('booting'), null, { timeout: 15000 });
  await p.waitForTimeout(1600);
  const audit = await p.evaluate(() => {
    const W = innerWidth, H = innerHeight, out = { W, H, issues: [] };
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    const band = window.scrolled.engine.rect; out.band = { y: Math.round(band.y), h: Math.round(band.h), pitch: +(window.scrolled.engine.pitch).toFixed(2) };
    const sheet = r('#sheet'); out.sheetTop = Math.round(sheet.top); out.sheetH = Math.round(sheet.height);
    const top = r('#top');
    if (band.h < 100) out.issues.push(`preview band only ${Math.round(band.h)}px tall`);
    if (band.y < top.bottom - 1) out.issues.push('band overlaps header');
    if (band.y + band.h > sheet.top + 1 && sheet.left < W * 0.4) out.issues.push('band overlaps sheet');
    const cta = r('#presentBtn');
    if (cta.bottom > H + 0.5 || cta.top < 0) out.issues.push(`Present button off-screen (bottom ${Math.round(cta.bottom)} of ${H})`);
    const field = r('#msg');
    if (field.bottom > H || field.top < sheet.top - 1) out.issues.push('message field clipped');
    const controls = document.getElementById('controls'); const cr = controls.getBoundingClientRect();
    out.controlsScroll = controls.scrollHeight > controls.clientHeight + 4; out.hasMore = document.getElementById('sheet').classList.contains('has-more');
    if (out.controlsScroll && !out.hasMore) out.issues.push('controls scroll but no cue');
    if (cr.height < 60 && !document.body.classList.contains('typing')) out.issues.push(`controls area only ${Math.round(cr.height)}px`);
    // every visible button/label inside the sheet must be inside the sheet box horizontally (rows may scroll horizontally, that is fine)
    for (const el of document.querySelectorAll('#sheet .label, #sheet .cta, #sheet #msg, #sheet .segmented')) {
      const b = el.getBoundingClientRect(); if (b.width === 0) continue;
      if (b.left < sheet.left - 1 || b.right > sheet.right + 1) out.issues.push(`${el.id || el.className} overflows sheet horizontally`);
    }
    // text truncation: chips whose scrollWidth exceeds clientWidth
    for (const el of document.querySelectorAll('#sheet .chip, #sheet .segmented button, #sheet .cta')) {
      if (el.scrollWidth > el.clientWidth + 2) out.issues.push(`text clipped in "${el.textContent.trim().slice(0, 20)}"`);
    }
    // vertical: labels visible in the controls viewport should not be half-cut unless scrolling is possible

    return out;
  }).catch(e => ({ issues: ['audit error ' + e.message] }));
  // states: typing, collapsed, present
  await p.focus('#msg'); await p.waitForTimeout(600);
  const typing = await p.evaluate(() => ({ bandH: Math.round(window.scrolled.engine.rect.h), cta: document.getElementById('presentBtn').getBoundingClientRect().bottom <= innerHeight + 0.5 }));
  await p.keyboard.press('Enter'); await p.waitForTimeout(500);
  await p.click('#presentBtn'); await p.waitForTimeout(1200);
  if (w < 800) await p.tap('#led'); else await p.click('#led'); await p.waitForTimeout(400);
  const present = await p.evaluate(() => { const h = document.getElementById('hud').getBoundingClientRect(); return { hudInside: h.left >= -1 && h.top >= -1 && h.right <= innerWidth + 1 && h.bottom <= innerHeight + 1, angle: window.scrolled.engine.angle, rect: window.scrolled.engine.rect }; });
  await p.screenshot({ path: `${out}/audit-${name}-present.png` });
  await p.goBack(); await p.waitForTimeout(700);
  await p.screenshot({ path: `${out}/audit-${name}.png` });
  const issues = [...audit.issues];
  if (typing.bandH < 100) issues.push(`typing: band ${typing.bandH}px`);
  if (!typing.cta) issues.push('typing: Present button off-screen');
  if (!present.hudInside) issues.push('present: HUD off-screen');
  if (errs.length) issues.push('errors: ' + errs.join(' | '));
  console.log(`${issues.length ? 'FAIL' : 'ok  '} ${name} ${w}x${h}  band ${audit.band?.h}px pitch ${audit.band?.pitch} sheet ${audit.sheetH}px scroll=${audit.controlsScroll} cue=${audit.hasMore}${issues.length ? '\n     - ' + issues.join('\n     - ') : ''}`);
  if (issues.length) problems.push(name);
  await ctx.close();
}
console.log(problems.length ? `\n${problems.length} viewport(s) with issues` : '\nall viewports clean');
await b.close();
process.exit(problems.length ? 1 : 0);
