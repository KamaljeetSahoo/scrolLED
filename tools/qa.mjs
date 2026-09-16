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
  const browser = await chromium.launch({ args, executablePath: process.env.PW_CHROME || undefined });
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  try { await fn(page, errors); }
  catch (e) { check('suite ran without aborting', false, String(e.message || e).split('\n')[0]); }
  finally { await browser.close(); }
}

await withPage(GL, { width: 390, height: 844 }, async (page, errors) => {
  await page.goto(base + '#m=QA+%E2%99%A5&f=bungee&c=cyan&s=70&z=30&d=r&sh=s&mo=st&a=1&g=2', { waitUntil: 'load' });
  const booted = await page.waitForFunction(() => !document.body.classList.contains('booting'), null, { timeout: 15000 }).then(() => true).catch(() => false);
  check('boot completes', booted);
  await page.waitForTimeout(2500);
  const st = await page.evaluate(() => ({
    text: document.querySelector('#msg').value,
    font: document.querySelector('#fonts [aria-checked="true"]').dataset.id,
    color: window.scrolled.state.color,
    speed: document.querySelector('#speed').value, rows: window.scrolled.state.rows,
    dir: window.scrolled.state.dir, shape: window.scrolled.state.shape, motion: window.scrolled.state.motion,
    after: window.scrolled.state.afterglow, glow: window.scrolled.state.glow,
    webgl: window.scrolled.engine.isWebGL, fps: window.scrolled.engine.stats.fps,
  }));
  check('hash state round-trips', st.text === 'QA ♥' && st.font === 'bungee' && st.color === 187 && st.speed === '70' && st.rows === 30 && st.dir === 'right' && st.shape === 'square' && st.motion === 'stepped' && st.after === true && st.glow === 2, JSON.stringify(st));
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
  // Auto-rotate is the source of truth: with the viewport already portrait and no
  // gravity reading, the sign must NOT rotate itself, or it lands sideways on a
  // phone the browser has already turned.
  check('present mode enters without fighting auto-rotate', pres.present && pres.angle === 0 && pres.hist, JSON.stringify(pres));
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

// An overlay that is invisible but still hit-testable makes the whole UI look
// fine and respond to nothing. Check that nothing covers the main controls.
await withPage(GL, { width: 393, height: 660 }, async (page, errors) => {
  await page.goto(base + '#m=TAP+TEST', { waitUntil: 'load' });
  await page.evaluate(() => { try { sessionStorage.setItem('scrolled.booted', '1'); } catch (e) {} });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !document.body.classList.contains('booting'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const clear = () => page.evaluate(() => {
    const ids = ['presentBtn', 'msg', 'handleBtn'];
    const bad = [];
    for (const id of ids) {
      const el = document.getElementById(id);
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, Math.min(r.top + r.height / 2, innerHeight - 2));
      if (!(top === el || el.contains(top) || top === null)) bad.push(`${id} covered by ${top.tagName}#${top.id}`);
      if (r.bottom > innerHeight + 1) bad.push(`${id} below the fold by ${Math.round(r.bottom - innerHeight)}px`);
    }
    return bad;
  });
  check('controls are not covered at rest', (await clear()).length === 0, (await clear()).join('; '));
  // open every overlay, dismiss it, and re-check immediately (no settle time)
  await page.evaluate(() => window.scrolled.showInstallCard && window.scrolled.showInstallCard());
  await page.waitForTimeout(400);
  await page.evaluate(() => document.getElementById('installClose').click());
  const afterCard = await clear();
  check('install card releases taps the moment it closes', afterCard.length === 0, afterCard.join('; '));
  await page.evaluate(() => window.scrolled.toast && window.scrolled.toast('hello', 300));
  await page.waitForTimeout(700);
  const afterToast = await clear();
  check('toast releases taps after it fades', afterToast.length === 0, afterToast.join('; '));
  // Colour is a native range input, so it drags, takes keys and needs no bespoke CSS.
  const drag = await page.evaluate(async () => {
    const el = document.getElementById('color');
    const vals = [];
    for (let i = 0; i <= 10; i++) {
      el.value = String(Math.round((359 * i) / 10));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => requestAnimationFrame(r));
      vals.push(window.scrolled.state.color);
    }
    return vals;
  });
  const rising = drag.every((v, i) => i === 0 || v >= drag[i - 1]);
  check('the colour slider sweeps the whole hue range', rising && drag[0] === 0 && drag[drag.length - 1] === 359, drag.join(','));
  await page.locator('#color').focus();
  const before = await page.evaluate(() => window.scrolled.state.color);
  await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(150);
  const afterKey = await page.evaluate(() => window.scrolled.state.color);
  check('the colour slider takes arrow keys', afterKey === before - 1, `${before} -> ${afterKey}`);
  const colour = await page.evaluate(() => {
    const sheet = document.getElementById('sheet').getBoundingClientRect();
    const parts = [document.getElementById('color'), document.getElementById('whiteBtn'), document.getElementById('rainbowBtn')];
    return {
      clipped: parts.some(c => { const b = c.getBoundingClientRect(); return b.left < sheet.left - 0.5 || b.right > sheet.right + 0.5; }),
      reachable: parts.every(c => { const b = c.getBoundingClientRect(); const t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return t === c || c.contains(t); }),
      sized: parts.every(c => { const b = c.getBoundingClientRect(); return b.width > 20 && b.height > 14; }),
    };
  });
  check('the colour row is not clipped by the sheet', !colour.clipped);
  check('the colour row is tappable', colour.reachable);
  check('the colour row has real size', colour.sized);
  await page.click('#whiteBtn'); await page.waitForTimeout(250);
  const white = await page.evaluate(() => window.scrolled.state.color);
  await page.click('#rainbowBtn'); await page.waitForTimeout(250);
  const rainbow = await page.evaluate(() => ({ c: window.scrolled.state.color, mode: window.scrolled.engine.mode }));
  check('white and rainbow chips select their modes', white === 'white' && rainbow.c === 'rainbow' && rainbow.mode === 1, `${white} / ${rainbow.c}`);
  // Dot size: every step selects, and the sliding highlight follows it.
  const sizes = [];
  for (const label of ['XL', 'M', 'S', 'L']) {
    await page.click(`#sizes button:text-is("${label}")`);
    await page.waitForTimeout(220);
    sizes.push(await page.evaluate(() => ({
      rows: window.scrolled.state.rows,
      i: getComputedStyle(document.getElementById('sizes')).getPropertyValue('--i').trim(),
      checked: document.querySelector('#sizes [aria-checked="true"]')?.textContent,
    })));
  }
  check('every dot size selects', sizes.map(s => s.rows).join(',') === '10,30,40,20', JSON.stringify(sizes.map(s => s.rows)));
  check('the dot size highlight follows the selection', sizes.map(s => s.i).join(',') === '0,2,3,1', JSON.stringify(sizes.map(s => s.i)));
  check('the dot size label matches the selection', sizes.map(s => s.checked).join(',') === 'XL,M,S,L', JSON.stringify(sizes.map(s => s.checked)));

  // and the button actually works from a real coordinate tap
  const box = await page.locator('#presentBtn').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(900);
  check('Present enters from a coordinate tap', await page.evaluate(() => document.body.classList.contains('present')));
  check('no page errors (overlay run)', errors.length === 0, errors.join(' | '));
});

// Present overlay: every control reachable, full screen toggles, drag scrubs.
await withPage(GL, { width: 393, height: 660 }, async (page, errors) => {
  await page.goto(base + '#m=A+LONG+ENOUGH+MESSAGE+TO+KEEP+SCROLLING&s=45', { waitUntil: 'load' });
  await page.evaluate(() => { try { sessionStorage.setItem('scrolled.booted', '1'); localStorage.setItem('scrolled.hint', '1'); } catch (e) {} });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !document.body.classList.contains('booting'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.click('#presentBtn');
  await page.waitForTimeout(2500);
  const openHud = async () => {
    for (let i = 0; i < 4; i++) {
      if (await page.evaluate(() => document.getElementById('hud').classList.contains('show'))) break;
      await page.touchscreen.tap(Math.round(393 / 2), Math.round(660 / 2));
      await page.waitForTimeout(450);
    }
    await page.waitForTimeout(450);
  };
  await openHud();
  const hud = await page.evaluate(() => {
    const h = document.getElementById('hud').getBoundingClientRect();
    const btns = [...document.querySelectorAll('#hud .hud-btn')].filter(b => !b.hidden);
    const unreachable = btns.filter(b => { const r = b.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !(t === b || b.contains(t)); }).map(b => b.getAttribute('aria-label'));
    return { labels: btns.map(b => b.getAttribute('aria-label')), unreachable, inside: h.left >= -1 && h.top >= -1 && h.right <= 393 + 1 && h.bottom <= 660 + 1 };
  });
  check('overlay offers exit, pause, full screen and beat', hud.labels.length === 4, hud.labels.join(', '));
  check('every overlay button is reachable', hud.unreachable.length === 0, hud.unreachable.join(', '));
  check('overlay sits inside the screen', hud.inside);
  const tapFs = async () => {
    await openHud();
    const c = await page.evaluate(() => { const r = document.getElementById('fsBtn').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; });
    await page.touchscreen.tap(c.x, c.y);
    await page.waitForTimeout(900);
  };
  const fsBefore = await page.evaluate(() => !!document.fullscreenElement);
  await tapFs();
  const fsAfter = await page.evaluate(() => ({ fs: !!document.fullscreenElement, present: document.body.classList.contains('present') }));
  check('full screen button toggles full screen', fsAfter.fs !== fsBefore, `${fsBefore} -> ${fsAfter.fs}`);
  check('leaving full screen stays in Present', fsAfter.present);
  const scrub = await page.evaluate(async () => {
    const e = window.scrolled.engine, c = document.getElementById('led');
    const rotated = Math.round(e.angleCur / 90) % 2 !== 0;
    const bx = Math.round(e.rect.x + e.rect.w / 2), by = Math.round(e.rect.y + e.rect.h / 2);
    const send = (t, x, y) => c.dispatchEvent(new PointerEvent(t, { pointerId: 1, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: true }));
    const frame = () => new Promise(r => requestAnimationFrame(r));
    await frame();
    const start = e.X;
    send('pointerdown', bx, by);
    let d = 0;
    for (let i = 1; i <= 14; i++) { d = i * 12; send('pointermove', rotated ? bx : bx + d, rotated ? by + d : by); await frame(); }
    const dragged = e.X, grabbed = !!e.grab;
    send('pointerup', rotated ? bx : bx + d, rotated ? by + d : by);
    const xs = [];
    for (let i = 0; i < 60; i++) { await frame(); xs.push(e.X); }   // allow a hard throw to settle
    let fwd = 0;
    for (let i = 1; i < xs.length; i++) { const dd = xs[i] - xs[i - 1]; if (Math.abs(dd) > 100) continue; if (dd < -0.05) fwd++; }
    return { moved: Math.abs(dragged - start) > 2, grabbed, resumes: fwd >= 5, released: !e.grab, fwd };
  });
  check('dragging the sign scrubs it', scrub.moved && scrub.grabbed);
  check('letting go resumes scrolling', scrub.resumes && scrub.released, `forward frames: ${scrub.fwd}`);
  check('no page errors (present run)', errors.length === 0, errors.join(' | '));
});

// Orientation: the phone's own rotation wins. Feeding gravity must never make
// the sign turn a second time on a viewport the browser already rotated.
await withPage(GL, { width: 393, height: 660 }, async (page, errors) => {
  await page.goto(base + '#m=ORIENTATION', { waitUntil: 'load' });
  await page.evaluate(() => { try { sessionStorage.setItem('scrolled.booted', '1'); localStorage.setItem('scrolled.hint', '1'); } catch (e) {} });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !document.body.classList.contains('booting'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await page.click('#presentBtn');
  await page.waitForTimeout(1500);
  const feed = (x, y, z) => page.evaluate(async ({ x, y, z }) => {
    const r = window.scrolled.reactive;
    if (!r.motionOn) await r.startMotion();
    const t0 = performance.now();
    while (performance.now() - t0 < 700) {
      dispatchEvent(new DeviceMotionEvent('devicemotion', { accelerationIncludingGravity: { x, y, z }, interval: 16 }));
      await new Promise(res => setTimeout(res, 16));
    }
    await new Promise(res => setTimeout(res, 300));
    return window.scrolled.engine.angle;
  }, { x, y, z });
  // Portrait viewport, phone upright: no rotation.
  check('upright phone is not rotated', ((await feed(0.2, 9.8, 0.4)) % 360 + 360) % 360 === 0);
  // Portrait viewport, phone turned sideways (rotation lock on): compensate.
  const locked = ((await feed(9.8, 0.2, 0.4)) % 360 + 360) % 360;
  check('rotation-locked phone held sideways is compensated', locked === 90 || locked === 270, String(locked));
  // Landscape viewport, i.e. auto-rotate already did the work: never rotate again.
  await page.setViewportSize({ width: 660, height: 393 });
  await page.waitForTimeout(600);
  const land = ((await feed(9.8, 0.2, 0.4)) % 360 + 360) % 360;
  check('landscape viewport is never rotated again', land === 0, String(land));
  check('no page errors (orientation run)', errors.length === 0, errors.join(' | '));
});

await withPage(GL, { width: 1280, height: 800 }, async (page, errors) => {
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => !document.body.classList.contains('booting'), null, { timeout: 15000 }).catch(() => {});
  const side = await page.evaluate(() => document.querySelector('#sheet').getBoundingClientRect().left > innerWidth * 0.5);
  check('desktop uses side panel layout', side);
  check('no page errors (desktop run)', errors.length === 0, errors.join(' | '));
});

// A half-updated cache can pair this document with a stylesheet from an older
// release. Every control must still be visible, sized and operable then: that is
// what a native <input> buys over a div wearing a role. Blocking the stylesheet
// outright is the strictest form of the same test.
await withPage(GL, { width: 390, height: 844 }, async (page, errors) => {
  await page.route('**/css/app.css', (r) => r.abort());
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => !document.body.classList.contains('booting'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  const alive = await page.evaluate(() => {
    const sized = (sel) => { const e = document.querySelector(sel); if (!e) return false; const b = e.getBoundingClientRect(); return b.width > 20 && b.height > 8; };
    return {
      booted: !!window.scrolled,
      color: sized('#color'), white: sized('#whiteBtn'), rainbow: sized('#rainbowBtn'),
      sizes: sized('#sizes'), speed: sized('#speed'), present: sized('#presentBtn'),
      sizeKids: document.querySelectorAll('#sizes button').length,
    };
  });
  check('stylesheetless: every control is still on screen', Object.values(alive).every(Boolean), JSON.stringify(alive));
  const works = await page.evaluate(async () => {
    const el = document.getElementById('color');
    el.value = '200'; el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
    const colour = window.scrolled.state.color;
    document.querySelector('#sizes button:last-child').click();
    await new Promise(r => setTimeout(r, 120));
    return { colour, rows: window.scrolled.state.rows };
  });
  check('stylesheetless: colour and dot size still work', works.colour === 200 && works.rows === 40, JSON.stringify(works));
  const real = errors.filter(e => !/app\.css|ERR_FAILED/.test(e));   // the blocked stylesheet is the point of this run
  check('no page errors (stylesheetless run)', real.length === 0, real.join(' | '));
});

// One broken control must not take the panel down with it.
await withPage(GL, { width: 390, height: 844 }, async (page, errors) => {
  await page.addInitScript(() => {
    addEventListener('DOMContentLoaded', () => document.getElementById('color')?.remove(), { once: true });
  });
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => !document.body.classList.contains('booting'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  const rest = await page.evaluate(async () => {
    document.querySelector('#sizes button:last-child')?.click();
    await new Promise(r => setTimeout(r, 120));
    return { booted: !!window.scrolled, sizeKids: document.querySelectorAll('#sizes button').length, rows: window.scrolled?.state?.rows, fonts: document.querySelectorAll('#fonts button').length };
  });
  check('a missing control does not break the others', rest.booted && rest.sizeKids === 4 && rest.rows === 40 && rest.fonts > 0, JSON.stringify(rest));
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
