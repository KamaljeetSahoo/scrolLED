// app.js — wires the UI to the LED engine. State lives in one object, is
// mirrored to localStorage and to the URL hash (so a sign can be shared as a link).

import { Engine } from './engine.js';
import { FONTS, FONT_BY_ID, ROW_OPTIONS, rasterize, preloadFonts } from './raster.js';
import { GLYPHS } from './font5x8.js';
import { bootSequence } from './boot.js';
import { Reactive } from './reactive.js';

const $ = (sel) => document.querySelector(sel);
const root = document.documentElement;
const body = document.body;

// ------------------------------------------------------------------ config
const COLORS = [
  { id: 'red',     hex: '#ff3b1f' },
  { id: 'amber',   hex: '#ff9f0a' },
  { id: 'yellow',  hex: '#ffd60a', dark: true },
  { id: 'green',   hex: '#3cff5c', dark: true },
  { id: 'cyan',    hex: '#22e6ff', dark: true },
  { id: 'blue',    hex: '#2f6bff' },
  { id: 'purple',  hex: '#a855f7' },
  { id: 'pink',    hex: '#ff3cac' },
  { id: 'white',   hex: '#f4f6ff', dark: true },
  { id: 'rainbow', hex: '#b06cff', rainbow: true },
];
const COLOR_BY_ID = Object.fromEntries(COLORS.map(c => [c.id, c]));
const SIZES = [
  { rows: 10, label: 'XL' },
  { rows: 20, label: 'L' },
  { rows: 30, label: 'M' },
  { rows: 40, label: 'S' },
];
const GLOW_LEVELS = [0.12, 0.6, 1.0];
const GLOW_LABELS = ['Glow off', 'Glow', 'Glow+'];
const PLACEHOLDER = 'type something...';
const STORE_KEY = 'scrolled.v1';
const DEFAULTS = { text: '', font: 'pixel', color: 'red', speed: 50, rows: 20, dir: 'left', shape: 'round', motion: 'smooth', afterglow: false, glow: 1, mic: false, recents: [] };

// ------------------------------------------------------------------- state
function loadState() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { stored = {}; }
  const s = { ...DEFAULTS, ...stored };
  Object.assign(s, fromHash(location.hash));
  // Web Share Target: an installed app can receive text from other apps (?text=...)
  const q = new URLSearchParams(location.search);
  if (q.has('text') || q.has('title')) {
    s.text = (q.get('text') || q.get('title') || '').trim();
    try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) { /* ignore */ }
  }
  if (!FONT_BY_ID[s.font]) s.font = DEFAULTS.font;
  if (!COLOR_BY_ID[s.color]) s.color = DEFAULTS.color;
  if (!ROW_OPTIONS.includes(+s.rows)) s.rows = DEFAULTS.rows;
  s.rows = +s.rows;
  s.speed = Math.min(100, Math.max(0, +s.speed || 0));
  s.glow = Math.min(2, Math.max(0, Math.round(+s.glow) || 0));
  if (!Array.isArray(s.recents)) s.recents = [];
  s.text = String(s.text || '').slice(0, 200);
  return s;
}
function fromHash(hash) {
  if (!hash || hash.length < 2) return {};
  const p = new URLSearchParams(hash.slice(1));
  const o = {};
  if (p.has('m')) o.text = p.get('m');
  if (p.has('f')) o.font = p.get('f');
  if (p.has('c')) o.color = p.get('c');
  if (p.has('s')) o.speed = +p.get('s');
  if (p.has('z')) o.rows = +p.get('z');
  if (p.has('d')) o.dir = p.get('d') === 'r' ? 'right' : 'left';
  if (p.has('sh')) o.shape = p.get('sh') === 's' ? 'square' : 'round';
  if (p.has('mo')) o.motion = p.get('mo') === 'st' ? 'stepped' : 'smooth';
  if (p.has('a')) o.afterglow = p.get('a') === '1';
  if (p.has('g')) o.glow = +p.get('g');
  return o;
}
function toHash(s) {
  const p = new URLSearchParams();
  if (s.text) p.set('m', s.text);
  if (s.font !== DEFAULTS.font) p.set('f', s.font);
  if (s.color !== DEFAULTS.color) p.set('c', s.color);
  if (s.speed !== DEFAULTS.speed) p.set('s', s.speed);
  if (s.rows !== DEFAULTS.rows) p.set('z', s.rows);
  if (s.dir !== DEFAULTS.dir) p.set('d', s.dir === 'right' ? 'r' : 'l');
  if (s.shape !== DEFAULTS.shape) p.set('sh', s.shape === 'square' ? 's' : 'r');
  if (s.motion !== DEFAULTS.motion) p.set('mo', s.motion === 'stepped' ? 'st' : 'sm');
  if (s.afterglow !== DEFAULTS.afterglow) p.set('a', s.afterglow ? '1' : '0');
  if (s.glow !== DEFAULTS.glow) p.set('g', s.glow);
  const str = p.toString();
  return str ? '#' + str : '';
}

const state = loadState();
let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* private mode */ }
    const h = toHash(state);
    if (h !== location.hash && (h || location.hash)) {
      try { history.replaceState(history.state, '', location.pathname + location.search + h); } catch (e) { /* ignore */ }
    }
  }, 150);
}

// -------------------------------------------------------------------- DOM
const canvas = $('#led');
const sheet = $('#sheet');
const topBar = $('#top');
const msg = $('#msg');
const clearBtn = $('#clearBtn');
const recentsEl = $('#recents');
const fontsEl = $('#fonts');
const colorsEl = $('#colors');
const speedEl = $('#speed');
const speedWord = $('#speedWord');
const sizesEl = $('#sizes');
const dirBtn = $('#dirBtn');
const shapeBtn = $('#shapeBtn');
const motionBtn = $('#motionBtn');
const afterBtn = $('#afterBtn');
const glowBtn = $('#glowBtn');
const beatBtn = $('#beatBtn');
const micBtn = $('#micBtn');
const presentBtn = $('#presentBtn');
const handleBtn = $('#handleBtn');
const hud = $('#hud');
const toastEl = $('#toast');
const splash = $('#splash');
const themeMeta = document.querySelector('meta[name="theme-color"]');

const vibrate = (p) => { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* ignore */ } };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone === true;

// ------------------------------------------------------------------ engine
const engine = new Engine(canvas);
const reactive = new Reactive();
engine.start();
let firstFrame = false;
let lastFrameAt = performance.now();
let lastBeatVar = 0;
engine.onFrame = () => {
  if (!firstFrame) { firstFrame = true; splash.classList.add('out'); setTimeout(() => splash.remove(), 400); }
  const now = performance.now();
  const dt = (now - lastFrameAt) / 1000; lastFrameAt = now;
  // The senses feed the sign every frame (and, subtly, the UI).
  reactive.update(dt);
  engine.setReactive(reactive.pulse, reactive.beat, reactive.up);
  const b = Math.max(reactive.beat, reactive.pulse * 0.5);
  if (!reducedMotion && Math.abs(b - lastBeatVar) > 0.02) { lastBeatVar = b; root.style.setProperty('--beat', b.toFixed(3)); }
  if (!booting) layout();
};

let strip = null;
let stripKey = '';
function updateStrip() {
  const text = state.text.trim() ? state.text : PLACEHOLDER;
  const key = `${text} ${state.font} ${state.rows}`;
  if (key === stripKey) return;
  stripKey = key;
  strip = rasterize(text, state.font, state.rows);
  engine.setStrip(strip);
  engine.setBrightness(state.text.trim() ? 1 : 0.42);
}

function applyEngine({ refit = false } = {}) {
  const col = COLOR_BY_ID[state.color];
  engine.setRows(state.rows);
  engine.setTint(hexToRgb(col.rainbow ? '#ffffff' : col.hex));
  engine.setRainbow(!!col.rainbow);
  engine.setSpeed(speedToUnits(state.speed));
  engine.setDirection(state.dir === 'right' ? 1 : -1);
  engine.setShape(state.shape);
  engine.setStepped(state.motion === 'stepped');
  engine.setAfterglow(state.afterglow);
  engine.setGlow(GLOW_LEVELS[state.glow]);
  if (refit && !reducedMotion) engine.brownout(0.3); // a controller re-configuring blinks
  updateStrip();
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
// slider 0..100 -> glyph pixels per second (one Pixel-font character is 6 px):
// 0 is static, otherwise ~1.2 to ~9 characters per second on an exponential curve.
function speedToUnits(s) { return s <= 0 ? 0 : 7.2 * Math.pow(7.5, s / 100); }
function speedName(s) {
  if (s <= 0) return 'Static';
  if (s <= 22) return 'Crawl';
  if (s <= 50) return 'Cruise';
  if (s <= 74) return 'Brisk';
  if (s <= 90) return 'Fast';
  return 'Ludicrous';
}

// ------------------------------------------------------------------ layout
let present = false;
let rotOffset = 0;
let autoAngle = null;   // from gravity, when available
let booting = true;

function presentAngle() {
  const portrait = innerHeight > innerWidth;
  const base = autoAngle !== null ? autoAngle : (portrait ? 90 : 0);
  return (base + rotOffset) % 360;
}

function layout() {
  const W = innerWidth, H = innerHeight;
  if (present) {
    // Full screen when the text axis runs along the long side of the viewport;
    // otherwise a wide band across the middle (an upright phone showing a sign).
    const rotated = (Math.round(presentAngle() / 90) % 2) === 1;
    const portrait = H > W;
    if (rotated === portrait) engine.setRect(0, 0, W, H);
    else if (portrait) { const bh = Math.min(H, W / 2.2); engine.setRect(0, (H - bh) / 2, W, bh); }
    else { const bw = Math.min(W, H / 2.2); engine.setRect((W - bw) / 2, 0, bw, H); }
    return;
  }
  const sr = sheet.getBoundingClientRect();
  const tr = topBar.getBoundingClientRect();
  const top = Math.max(tr.bottom, 0) + 6;
  const side = sr.left > W * 0.4 && sr.top < H * 0.3; // sheet is a side panel (landscape / desktop)
  let avail;
  if (side) avail = { x: 14, y: top, w: Math.max(40, sr.left - 28), h: Math.max(40, H - top - 20) };
  else avail = { x: 12, y: top, w: W - 24, h: Math.max(40, Math.min(sr.top, H) - top - 10) };
  const h = Math.max(40, Math.min(avail.h, avail.w / 2.1));
  const y = avail.y + (avail.h - h) / 2;
  engine.setRect(avail.x, y, avail.w, h);
}

function updateAngle() {
  engine.setAngle(present ? presentAngle() : 0);
}

function onResize() {
  engine.resize();
  updateAngle();
  if (!booting) layout();
}
addEventListener('resize', onResize);
addEventListener('orientationchange', onResize);
if (window.visualViewport) {
  const vv = window.visualViewport;
  const onVV = () => {
    const kb = Math.max(0, innerHeight - vv.height - vv.offsetTop);
    root.style.setProperty('--kb', `${Math.round(kb)}px`);
    if (kb > 0) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', onVV);
  vv.addEventListener('scroll', onVV);
}

// ----------------------------------------------------------------- UI build
function setAccent(colorId) {
  const c = COLOR_BY_ID[colorId];
  const [r, g, b] = hexToRgb(c.hex).map(v => Math.round(v * 255));
  root.style.setProperty('--accent', c.hex);
  root.style.setProperty('--accent-rgb', `${r} ${g} ${b}`);
  root.style.setProperty('--on-accent', c.dark ? '#0a0a0a' : '#fff');
  updateThemeColor();
}
function updateThemeColor() {
  if (!themeMeta) return;
  if (present) { themeMeta.setAttribute('content', '#000000'); return; }
  const [r, g, b] = hexToRgb(COLOR_BY_ID[state.color].hex).map(v => Math.round(v * 255 * 0.12));
  themeMeta.setAttribute('content', `rgb(${r},${g},${b})`);
}

function buildWordmark() {
  const el = $('#wordmark');
  const word = 'scrolLED';
  const step = 3, r = 1.15;
  let x = 0;
  const circles = [];
  for (const ch of word) {
    const g = GLYPHS[ch];
    if (!g) continue;
    for (let c = 0; c < 5; c++) for (let row = 0; row < 8; row++) {
      if (g[c] & (1 << row)) circles.push(`<circle class="on${'LED'.includes(ch) ? ' accent' : ''}" cx="${(x + c) * step + r}" cy="${row * step + r}" r="${r}"/>`);
    }
    x += 6;
  }
  const w = (x - 1) * step, h = 8 * step;
  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="scrolLED">${circles.join('')}</svg>`;
}

function buildFonts() {
  fontsEl.innerHTML = '';
  for (const f of FONTS) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = `chip ${f.id}`; b.setAttribute('role', 'radio');
    b.dataset.id = f.id; b.textContent = f.label;
    b.setAttribute('aria-checked', String(f.id === state.font));
    b.addEventListener('click', () => { if (state.font === f.id) return; state.font = f.id; syncFonts(); applyEngine({ refit: true }); persist(); vibrate(6); });
    fontsEl.appendChild(b);
  }
}
function syncFonts() {
  for (const b of fontsEl.children) b.setAttribute('aria-checked', String(b.dataset.id === state.font));
  const active = fontsEl.querySelector('[aria-checked="true"]');
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
}

function buildColors() {
  colorsEl.innerHTML = '';
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = `swatch${c.rainbow ? ' rainbow' : ''}`; b.setAttribute('role', 'radio');
    b.dataset.id = c.id; b.setAttribute('aria-label', c.id);
    const [r, g, bl] = hexToRgb(c.hex).map(v => Math.round(v * 255));
    b.style.setProperty('--c', c.hex); b.style.setProperty('--c-rgb', `${r} ${g} ${bl}`);
    b.setAttribute('aria-checked', String(c.id === state.color));
    b.addEventListener('click', () => { if (state.color === c.id) return; state.color = c.id; syncColors(); setAccent(c.id); applyEngine(); persist(); vibrate(6); });
    colorsEl.appendChild(b);
  }
}
function syncColors() {
  for (const b of colorsEl.children) b.setAttribute('aria-checked', String(b.dataset.id === state.color));
}

function buildSizes() {
  sizesEl.innerHTML = '';
  sizesEl.style.setProperty('--n', SIZES.length);
  SIZES.forEach((sz) => {
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'radio'); b.textContent = sz.label; b.dataset.rows = sz.rows;
    b.setAttribute('aria-label', `Dot size ${sz.label}`);
    b.addEventListener('click', () => { if (state.rows === sz.rows) return; state.rows = sz.rows; syncSizes(); applyEngine({ refit: true }); persist(); vibrate(6); });
    sizesEl.appendChild(b);
  });
  syncSizes();
}
function syncSizes() {
  const i = Math.max(0, SIZES.findIndex(s => s.rows === state.rows));
  sizesEl.style.setProperty('--i', i);
  [...sizesEl.children].forEach((b, j) => b.setAttribute('aria-checked', String(i === j)));
}

function syncSpeed() {
  speedEl.value = state.speed;
  speedEl.style.setProperty('--p', `${state.speed}%`);
  speedWord.textContent = speedName(state.speed);
}
let lastSpeedTick = -1;
speedEl.addEventListener('input', () => {
  state.speed = +speedEl.value; syncSpeed(); engine.setSpeed(speedToUnits(state.speed)); persist();
  const tick = state.speed === 0 ? -2 : Math.floor(state.speed / 10);
  if (tick !== lastSpeedTick) { lastSpeedTick = tick; vibrate(state.speed === 0 ? 12 : 4); }
});

function syncToggles() {
  dirBtn.querySelector('span').textContent = state.dir === 'right' ? 'Right' : 'Left';
  dirBtn.querySelector('svg').style.transform = state.dir === 'right' ? 'scaleX(-1)' : '';
  shapeBtn.classList.toggle('square', state.shape === 'square');
  shapeBtn.querySelector('span').textContent = state.shape === 'square' ? 'Square' : 'Round';
  shapeBtn.setAttribute('aria-pressed', String(state.shape === 'square'));
  motionBtn.querySelector('span').textContent = state.motion === 'stepped' ? 'Stepped' : 'Smooth';
  motionBtn.setAttribute('aria-pressed', String(state.motion === 'stepped'));
  afterBtn.setAttribute('aria-pressed', String(!!state.afterglow));
  glowBtn.querySelector('span').textContent = GLOW_LABELS[state.glow];
  glowBtn.setAttribute('aria-pressed', String(state.glow > 0));
}
dirBtn.addEventListener('click', () => { state.dir = state.dir === 'right' ? 'left' : 'right'; syncToggles(); applyEngine(); persist(); vibrate(6); });
shapeBtn.addEventListener('click', () => { state.shape = state.shape === 'square' ? 'round' : 'square'; syncToggles(); applyEngine(); persist(); vibrate(6); });
motionBtn.addEventListener('click', () => { state.motion = state.motion === 'stepped' ? 'smooth' : 'stepped'; syncToggles(); applyEngine(); persist(); vibrate(6); });
afterBtn.addEventListener('click', () => { state.afterglow = !state.afterglow; syncToggles(); applyEngine(); persist(); vibrate(6); });
glowBtn.addEventListener('click', () => { state.glow = (state.glow + 1) % 3; syncToggles(); applyEngine(); persist(); vibrate(6); });

// Beat: the sign listens to the room. Opt-in, because it asks for the microphone.
function syncMic() {
  const on = reactive.micOn;
  beatBtn.setAttribute('aria-pressed', String(on));
  micBtn.setAttribute('aria-pressed', String(on));
}
async function toggleMic() {
  vibrate(6);
  if (reactive.micOn) { reactive.stopMic(); state.mic = false; syncMic(); persist(); return; }
  const ok = await reactive.startMic();
  state.mic = ok; syncMic(); persist();
  if (!ok) toast(reactive.micSupported ? 'Microphone not available' : 'This browser has no microphone access', 2600);
  else if (!present) toast('Listening. The sign now moves to the music', 2200);
}
beatBtn.addEventListener('click', toggleMic);
micBtn.addEventListener('click', () => { toggleMic(); showHud(); });

// The grab handle collapses the sheet to just the message and the Present button.
let collapsed = false;
function setCollapsed(v) {
  collapsed = v;
  sheet.classList.toggle('collapsed', v);
  handleBtn.setAttribute('aria-expanded', String(!v));
}
let handlePtr = null;
handleBtn.addEventListener('pointerdown', (e) => { handlePtr = { y: e.clientY, t: performance.now() }; });
handleBtn.addEventListener('pointerup', (e) => {
  if (!handlePtr) return;
  const dy = e.clientY - handlePtr.y; handlePtr = null;
  if (dy > 24) setCollapsed(true); else if (dy < -24) setCollapsed(false); else setCollapsed(!collapsed);
  vibrate(6);
});
handleBtn.addEventListener('pointercancel', () => { handlePtr = null; });
handleBtn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed(!collapsed); } });

// ---------------------------------------------------------------- message
msg.value = state.text;
function syncMsg() {
  clearBtn.hidden = !msg.value;
}
// Long messages take tens of milliseconds to rasterize, so coalesce keystrokes.
let stripTimer = 0;
function scheduleStrip() {
  clearTimeout(stripTimer);
  if (state.text.length < 40) { updateStrip(); return; }
  stripTimer = setTimeout(updateStrip, 60);
}
msg.addEventListener('input', () => { state.text = msg.value; syncMsg(); scheduleStrip(); persist(); });
msg.addEventListener('focus', () => { body.classList.add('typing'); });
msg.addEventListener('blur', () => { body.classList.remove('typing'); root.style.setProperty('--kb', '0px'); commitRecent(); });
msg.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); msg.blur(); } });
clearBtn.addEventListener('click', () => { msg.value = ''; state.text = ''; syncMsg(); updateStrip(); persist(); msg.focus(); });

function commitRecent() {
  const t = state.text.trim();
  if (!t) return;
  state.recents = [t, ...state.recents.filter(x => x !== t)].slice(0, 8);
  persist();
  renderRecents();
}
function renderRecents() {
  const items = state.recents.filter(x => x !== state.text.trim());
  recentsEl.hidden = items.length === 0;
  recentsEl.innerHTML = '';
  for (const t of items) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.setAttribute('role', 'listitem'); b.title = t;
    const span = document.createElement('span'); span.textContent = t; b.appendChild(span);
    b.addEventListener('click', () => { msg.value = t; state.text = t; syncMsg(); updateStrip(); commitRecent(); vibrate(6); });
    recentsEl.appendChild(b);
  }
}

// ------------------------------------------------------- canvas gestures
// Tap: show/hide the overlay (present) or dismiss the keyboard (edit).
// Drag along the text axis: grab the strip and move it 1:1; release throws it.
let ptr = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  if (booting) { boot.skip(); return; }
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  ptr = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t: performance.now(), moved: false, pos: 0, samples: [] };
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
});
canvas.addEventListener('pointermove', (e) => {
  if (!ptr || e.pointerId !== ptr.id) return;
  const now = performance.now();
  if (!ptr.moved) {
    if (Math.hypot(e.clientX - ptr.x0, e.clientY - ptr.y0) < 8) return;
    ptr.moved = true;
    ptr.x = e.clientX; ptr.y = e.clientY;
    engine.grabStart();
    if (document.activeElement === msg) msg.blur();
    if (present) hideHud();
  }
  const dx = e.clientX - ptr.x, dy = e.clientY - ptr.y;
  ptr.x = e.clientX; ptr.y = e.clientY;
  const th = engine.angleCur * Math.PI / 180;
  const along = dx * Math.cos(th) + dy * Math.sin(th); // CSS px along the text axis
  ptr.pos += along;
  ptr.samples.push({ t: now, pos: ptr.pos });
  while (ptr.samples.length > 2 && now - ptr.samples[0].t > 90) ptr.samples.shift();
  const first = ptr.samples[0], last = ptr.samples[ptr.samples.length - 1];
  const vel = last.t > first.t ? (last.pos - first.pos) / ((last.t - first.t) / 1000) : 0;
  engine.grabMove(along * engine.dpr, vel * engine.dpr);
});
function endPointer(e, cancelled) {
  if (!ptr || e.pointerId !== ptr.id) return;
  const p = ptr; ptr = null;
  if (p.moved) { engine.grabEnd(); return; }
  if (cancelled || performance.now() - p.t > 500) return;
  // a tap
  if (present) { if (hud.classList.contains('show')) hideHud(); else showHud(); }
  else if (document.activeElement === msg) msg.blur();
}
canvas.addEventListener('pointerup', (e) => endPointer(e, false));
canvas.addEventListener('pointercancel', (e) => endPointer(e, true));

// ------------------------------------------------------------ present mode
let hudTimer = 0;
let wakeLock = null;

async function requestWakeLock() {
  try {
    if (!('wakeLock' in navigator)) return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
      if (present && document.visibilityState === 'visible') setTimeout(() => { if (present && !wakeLock) requestWakeLock(); }, 500);
    });
  } catch (e) { wakeLock = null; }
}
function releaseWakeLock() { const w = wakeLock; wakeLock = null; try { if (w) w.release(); } catch (e) { /* ignore */ } }

function showHud(autoHide = true) {
  hud.hidden = false;
  requestAnimationFrame(() => hud.classList.add('show'));
  clearTimeout(hudTimer);
  if (autoHide) hudTimer = setTimeout(hideHud, 3000);
}
function hideHud() {
  clearTimeout(hudTimer);
  hud.classList.remove('show');
  setTimeout(() => { if (!hud.classList.contains('show')) hud.hidden = true; }, 300);
}

// Motion: gravity keeps the text upright for whoever is looking (even with the
// phone's rotation lock on), tilt moves the LED highlights, movement adds energy.
reactive.onOrientation = (deg) => { autoAngle = deg; if (present) { updateAngle(); layout(); } };
async function startMotion() {
  const res = await reactive.startMotion();
  if (res !== 'granted') autoAngle = null;
}

async function enterPresent() {
  if (present || booting) return;
  present = true;
  msg.blur();
  body.classList.add('present');
  try { history.pushState({ present: true }, ''); } catch (e) { /* ignore */ }
  engine.setPresent(1);
  layout();
  updateAngle();
  updateThemeColor();
  vibrate([8, 30, 8]);
  startMotion(); // inside the tap: iOS shows its motion permission prompt here
  try { if (document.documentElement.requestFullscreen && !document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch (e) { /* iOS */ }
  try { if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape'); } catch (e) { /* unsupported or not fullscreen */ }
  updateAngle();
  layout();
  requestWakeLock();
  let seenHint = false;
  try { seenHint = !!localStorage.getItem('scrolled.hint'); } catch (e) { /* ignore */ }
  if (!seenHint) {
    toast('Tap the screen for controls', 2600);
    try { localStorage.setItem('scrolled.hint', '1'); } catch (e) { /* ignore */ }
  } else {
    showHud();
  }
}

function exitPresent({ fromHistory = false } = {}) {
  if (!present) return;
  if (!fromHistory && history.state && history.state.present) { history.back(); return; }
  present = false;
  rotOffset = 0;
  engine.paused = false;
  engine.setPresent(0);
  body.classList.remove('present', 'paused');
  hideHud();
  hideToast();
  releaseWakeLock();
  try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) { /* ignore */ }
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  updateAngle();
  updateThemeColor();
  layout();
}

addEventListener('popstate', () => { if (present) exitPresent({ fromHistory: true }); });
document.addEventListener('fullscreenchange', () => { if (present && !document.fullscreenElement) exitPresent(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { engine.start(); reactive.resume(); if (present && !wakeLock) requestWakeLock(); }
  else { engine.stop(); reactive.suspend(); }
});
addEventListener('pageshow', (e) => { if (e.persisted) { engine.start(); if (present) requestWakeLock(); } });

presentBtn.addEventListener('click', enterPresent);
$('#exitBtn').addEventListener('click', () => { vibrate(6); exitPresent(); });
const ROT_CYCLE = [0, 180, 90, 270];
function cycleRotation() {
  rotOffset = ROT_CYCLE[(ROT_CYCLE.indexOf(rotOffset) + 1) % ROT_CYCLE.length];
  updateAngle(); layout(); showHud(); vibrate(6);
}
$('#rotateBtn').addEventListener('click', cycleRotation);
$('#pauseBtn').addEventListener('click', () => { togglePause(); showHud(); });
function togglePause() {
  engine.paused = !engine.paused;
  body.classList.toggle('paused', engine.paused);
  vibrate(engine.paused ? 20 : [10, 30, 10]);
}

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && t !== document.body && t !== canvas && t !== document.documentElement) return; // a control has focus

  if (e.key === 'Escape' && present) { exitPresent(); e.preventDefault(); }
  else if ((e.key === 'f' || e.key === 'F') && !present) { enterPresent(); e.preventDefault(); }
  else if (e.key === ' ') { togglePause(); if (present) showHud(); e.preventDefault(); }
  else if ((e.key === 'r' || e.key === 'R') && present) cycleRotation();
});

// ------------------------------------------------------------------- toast
let toastTimer = 0;
function toast(text, ms = 2200, action) {
  toastEl.innerHTML = '';
  toastEl.append(document.createTextNode(text));
  if (action) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = action.label;
    b.addEventListener('click', () => { hideToast(); action.onClick(); });
    toastEl.appendChild(b);
  }
  toastEl.hidden = false;
  requestAnimationFrame(() => toastEl.classList.add('show'));
  clearTimeout(toastTimer);
  if (ms > 0) toastTimer = setTimeout(hideToast, ms);
}
function hideToast() {
  toastEl.classList.remove('show');
  setTimeout(() => { if (!toastEl.classList.contains('show')) toastEl.hidden = true; }, 300);
}

// ------------------------------------------------------------ share / PWA
// Renders a square card of the current sign (used for sharing as an image).
let cardEngine = null;
async function renderCard(size = 1080) {
  if (!cardEngine) {
    const c = document.createElement('canvas');
    cardEngine = new Engine(c, { width: size, height: size, dpr: 1 });
  }
  const e = cardEngine;
  const col = COLOR_BY_ID[state.color];
  e.setRows(state.rows);
  e.setTint(hexToRgb(col.rainbow ? '#ffffff' : col.hex), true);
  e.setRainbow(!!col.rainbow);
  e.setShape(state.shape);
  e.setGlow(GLOW_LEVELS[state.glow]);
  e.setAfterglow(false);
  e.setStepped(state.motion === 'stepped');
  e.setPresent(1, true);
  e.setBrightness(1, true);
  e.setSpeed(0);
  const bandH = Math.round(size / 2.4);
  e.setRect(0, (size - bandH) / 2, size, bandH, true);
  e.setAngle(0, true);
  e.setStrip(strip);
  e.paused = true;
  e.renderNow();                 // lays out the grid (cols) for this size
  const wl = strip ? strip.widthLED : 0;
  e.X = wl <= e.cols ? (e.cols - wl) / 2 : 0;
  e.renderNow();
  // Compose: sign + a small dot-matrix wordmark, then export.
  const out = document.createElement('canvas');
  out.width = size; out.height = size;
  const ctx = out.getContext('2d');
  ctx.drawImage(e.canvas, 0, 0, size, size);
  const step = 6, r = 2.2;
  let x = 0;
  ctx.globalAlpha = 0.5;
  const startX = size - 48 * step - 40, startY = size - 8 * step - 36;
  for (const ch of 'scrolLED') {
    const g = GLYPHS[ch];
    ctx.fillStyle = 'LED'.includes(ch) ? col.hex : '#f5f5f7';
    for (let c = 0; c < 5; c++) for (let row = 0; row < 8; row++) {
      if (g[c] & (1 << row)) { ctx.beginPath(); ctx.arc(startX + (x + c) * step + r, startY + row * step + r, r, 0, Math.PI * 2); ctx.fill(); }
    }
    x += 6;
  }
  ctx.globalAlpha = 1;
  return new Promise((resolve) => out.toBlob(resolve, 'image/png'));
}

$('#shareBtn').addEventListener('click', async () => {
  vibrate(6);
  const url = location.origin + location.pathname + toHash(state);
  const text = state.text.trim() ? `"${state.text.trim()}" on scrolLED` : 'scrolLED: turn your phone into an LED sign';
  if (navigator.share) {
    let files;
    try {
      if (navigator.canShare && state.text.trim()) {
        const blob = await renderCard();
        if (blob) {
          const file = new File([blob], 'scrolled.png', { type: 'image/png' });
          if (navigator.canShare({ files: [file] })) files = [file];
        }
      }
    } catch (e) { files = undefined; }
    try { await navigator.share(files ? { files, title: 'scrolLED', text, url } : { title: 'scrolLED', text, url }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('Link copied'); }
  catch (e) { toast('Copy this link: ' + url, 6000); }
});

const installBtn = $('#installBtn');
let deferredInstall = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; if (!isStandalone) installBtn.hidden = false; });
addEventListener('appinstalled', () => { deferredInstall = null; installBtn.hidden = true; toast('Installed. Find scrolLED on your home screen'); });
if (isIOS && !isStandalone) installBtn.hidden = false;
installBtn.addEventListener('click', async () => {
  vibrate(6);
  if (deferredInstall) {
    deferredInstall.prompt();
    try { await deferredInstall.userChoice; } catch (e) { /* ignore */ }
    deferredInstall = null;
    installBtn.hidden = true;
  } else if (isIOS) {
    toast('Tap Share, then "Add to Home Screen"', 4200);
  }
});

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  let wantReload = false;
  const register = async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
      const offerUpdate = (worker) => toast('A new version is ready', 0, { label: 'Refresh', onClick: () => { wantReload = true; worker.postMessage({ type: 'SKIP_WAITING' }); } });
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(nw); });
      });
    } catch (e) { /* offline or unsupported */ }
  };
  addEventListener('load', () => {
    if ('requestIdleCallback' in window) requestIdleCallback(register, { timeout: 1500 }); else setTimeout(register, 800);
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (wantReload) location.reload(); });
}

// -------------------------------------------------------------------- boot
buildWordmark();
buildFonts();
buildColors();
buildSizes();
syncSpeed();
syncToggles();
syncMsg();
renderRecents();
setAccent(state.color);
body.classList.add('booting');

let warm = false;
try { warm = sessionStorage.getItem('scrolled.booted') === '1'; sessionStorage.setItem('scrolled.booted', '1'); } catch (e) { /* ignore */ }
const fontsReady = preloadFonts(2500);
const bootTint = hexToRgb(COLOR_BY_ID[state.color].rainbow ? '#ff3b1f' : COLOR_BY_ID[state.color].hex);
const boot = bootSequence(engine, { W: innerWidth, H: innerHeight, ready: fontsReady, tint: bootTint, warm, reduced: reducedMotion });
addEventListener('keydown', () => boot.skip(), { once: true });

boot.done.then(() => {
  engine.setOverride(null);
  engine.setBrightness(0, true);
  applyEngine();
  engine.resetPosition();
  booting = false;
  body.classList.remove('booting');
  sheet.classList.add('reveal');
  layout();
  engine.rectCur = { ...engine.rect }; // no zoom from the boot grid: the panel fades in and then follows the rising sheet
  requestAnimationFrame(() => { engine.setBrightness(state.text.trim() ? 1 : 0.42); });
  setTimeout(() => sheet.classList.remove('reveal'), 1200);
  fontsReady.then(() => { stripKey = ''; updateStrip(); }); // re-raster once web fonts are certain
  if (reactive.motionSupported && !reactive.motionNeedsPermission) startMotion();
  if (state.mic) reactive.startMic().then((ok) => { state.mic = ok; syncMic(); if (!ok) persist(); });
});

// A small handle for debugging and automated QA (not part of the UI).
window.scrolled = { engine, state, reactive, present: () => present, renderCard };
