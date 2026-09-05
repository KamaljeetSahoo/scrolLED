// raster.js — turns a message into a "strip": a horizontally scrollable field of
// LED brightness values. The message is drawn once at high resolution, then
// reduced to per-row prefix sums so the engine can box-filter any fractional
// scroll offset exactly (that's what makes "Smooth" motion look buttery instead
// of swimmy). Analogy: the strip is a long paper tape that has been pre-scanned;
// each frame we only ask "how much ink sits under this LED's window right now".

import { GLYPHS, GLYPH_W, GLYPH_H } from './font5x8.js';

export const FONTS = [
  { id: 'pixel',     label: 'Pixel',  kind: 'bitmap', bold: false },
  { id: 'pixelbold', label: 'Bold',   kind: 'bitmap', bold: true },
  { id: 'anton',     label: 'Tall',   kind: 'text', family: '"Anton", Impact, "Arial Narrow", sans-serif', weight: 400, spacing: 0.035, fit: 0.86 },
  { id: 'bungee',    label: 'Poster', kind: 'text', family: '"Bungee", "Arial Black", sans-serif', weight: 400, spacing: 0.03, fit: 0.78 },
  { id: 'orbitron',  label: 'Techno', kind: 'text', family: '"Orbitron", "Eurostile", sans-serif', weight: 900, spacing: 0.03, fit: 0.76 },
  { id: 'abril',     label: 'Fancy',  kind: 'text', family: '"Abril Fatface", Georgia, serif', weight: 400, spacing: 0.02, fit: 0.84 },
  { id: 'pacifico',  label: 'Script', kind: 'text', family: '"Pacifico", "Brush Script MT", cursive', weight: 400, spacing: 0, fit: 0.88, stroke: 0.75 },
  { id: 'sans',      label: 'Sans',   kind: 'text', family: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', weight: 800, spacing: 0.035, fit: 0.84 },
];

export const FONT_BY_ID = Object.fromEntries(FONTS.map(f => [f.id, f]));

/** Rows options: 10 rows = one bitmap glyph (8) + 1 LED padding top and bottom. */
export const ROW_OPTIONS = [10, 20, 30, 40];

/** CSS font shorthand used for canvas drawing and for document.fonts.load(). */
export function fontCss(font, px) {
  return `${font.weight || 400} ${px}px ${font.family}`;
}

/** Preload every web font so canvas rasterization never hits a fallback face. */
export function preloadFonts(timeoutMs = 2500) {
  if (!document.fonts || !document.fonts.load) return Promise.resolve();
  const loads = FONTS.filter(f => f.kind === 'text').map(f => document.fonts.load(fontCss(f, 40), 'Ag9♥').catch(() => {}));
  const timeout = new Promise(r => setTimeout(r, timeoutMs));
  return Promise.race([Promise.all(loads), timeout]);
}

// ---------------------------------------------------------------------------
// Grapheme segmentation (so emoji sequences stay together)
const segmenter = (typeof Intl !== 'undefined' && Intl.Segmenter) ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
export function graphemes(text) {
  if (segmenter) return Array.from(segmenter.segment(text), s => s.segment);
  return Array.from(text);
}

// Look up a bitmap glyph, falling back to the base letter for accented chars.
function bitmapGlyph(ch) {
  let g = GLYPHS[ch];
  if (g) return g;
  const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (base !== ch && GLYPHS[base]) return GLYPHS[base];
  if (ch === '’' || ch === '‘') return GLYPHS["'"];
  if (ch === '“' || ch === '”') return GLYPHS['"'];
  if (ch === '–' || ch === '—') return GLYPHS['-'];
  if (ch === '…') return null; // ellipsis → text fallback
  return null;
}

// ---------------------------------------------------------------------------
let scratch = null;
function scratchCtx(w, h) {
  if (!scratch) {
    scratch = document.createElement('canvas');
  }
  if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h; }
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

let measureCtx = null;
function getMeasureCtx() {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  return measureCtx;
}

/** Supersampling factor: hi-res pixels per LED. Coarser grids get more samples. */
export function superSample(rows) { return rows <= 20 ? 8 : 4; }

/**
 * Rasterize a message.
 * @returns {Strip}
 */
export function rasterize(text, fontId, rows) {
  const font = FONT_BY_ID[fontId] || FONTS[0];
  const ss = superSample(rows);
  const H = rows * ss;
  const plan = font.kind === 'bitmap' ? planBitmap(text, font, rows, ss) : planText(text, font, rows, ss);
  return buildStrip(plan.draw, plan.W, H, rows, ss);
}

// ---------------------------------------------------------------------------
// Bitmap font plan: every glyph pixel becomes k×k LEDs (k = rows / 10).
function planBitmap(text, font, rows, ss) {
  const k = Math.max(1, Math.round(rows / 10));  // LEDs per glyph pixel
  const px = k * ss;                             // hi-res px per glyph pixel
  const chars = graphemes(text);
  const items = [];
  let x = 0;
  const bold = !!font.bold;
  const advance = (GLYPH_W + (bold ? 2 : 1)) * px;
  const mctx = getMeasureCtx();
  const fbSize = 10 * px;                        // system font size for glyphs we lack
  mctx.font = `700 ${fbSize}px system-ui, -apple-system, "Segoe UI", Roboto, "Noto Color Emoji", "Apple Color Emoji", sans-serif`;
  for (const ch of chars) {
    if (ch === ' ') { items.push({ kind: 'space', x }); x += Math.round(advance * 0.75); continue; }
    const g = bitmapGlyph(ch);
    if (g) { items.push({ kind: 'glyph', x, g }); x += advance; continue; }
    // Fallback: draw with a system font (emoji, non-Latin scripts…)
    const w = Math.ceil(mctx.measureText(ch).width);
    items.push({ kind: 'text', x, ch, w });
    x += w + px;
  }
  // Trim the trailing inter-glyph gap; round the width up to whole LEDs.
  let contentW = x;
  if (items.length && items[items.length - 1].kind === 'glyph') contentW -= (bold ? 2 : 1) * px;
  const W = Math.max(ss, Math.ceil(contentW / ss) * ss);
  const top = 1 * px; // one LED-row of padding above row 0 (times k)
  const draw = (ctx, x0, x1) => {
    ctx.fillStyle = '#fff';
    for (const it of items) {
      if (it.kind === 'glyph') {
        const gx = it.x;
        const gw = (GLYPH_W + (bold ? 1 : 0)) * px;
        if (gx + gw < x0 || gx > x1) continue;
        for (let c = 0; c < GLYPH_W; c++) {
          const colBits = it.g[c];
          if (!colBits) continue;
          for (let r = 0; r < GLYPH_H; r++) {
            if (colBits & (1 << r)) {
              ctx.fillRect(gx + c * px, top + r * px, bold ? 2 * px : px, px);
            }
          }
        }
      } else if (it.kind === 'text') {
        if (it.x + it.w < x0 || it.x > x1) continue;
        ctx.font = mctx.font;
        ctx.textBaseline = 'alphabetic';
        // Baseline sits on glyph row 7 boundary (row 6 is the last cap row).
        ctx.fillText(it.ch, it.x, top + 7 * px);
      }
    }
  };
  return { draw, W };
}

// ---------------------------------------------------------------------------
// Text font plan: fit the message's ink box into `fit` of the strip height.
function planText(text, font, rows, ss) {
  const H = rows * ss;
  const mctx = getMeasureCtx();
  const probe = 100;
  mctx.font = fontCss(font, probe);
  if ('letterSpacing' in mctx) mctx.letterSpacing = `${(font.spacing || 0) * probe}px`;
  const m = mctx.measureText(text);
  const asc = m.actualBoundingBoxAscent || probe * 0.7;
  const desc = m.actualBoundingBoxDescent || 0;
  const ink = Math.max(asc + desc, probe * 0.3);
  const size = probe * (H * (font.fit || 0.84)) / ink;
  mctx.font = fontCss(font, size);
  if ('letterSpacing' in mctx) mctx.letterSpacing = `${(font.spacing || 0) * size}px`;
  const m2 = mctx.measureText(text);
  const left = Math.max(0, m2.actualBoundingBoxLeft || 0);
  const right = m2.actualBoundingBoxRight || m2.width;
  const inkW = left + right;
  const pad = Math.round(ss * 0.75);
  const W = Math.max(ss, Math.ceil((inkW + pad * 2) / ss) * ss);
  const blockTop = (H - (m2.actualBoundingBoxAscent + m2.actualBoundingBoxDescent)) / 2;
  const baseline = blockTop + (m2.actualBoundingBoxAscent || asc * size / probe);
  const fontStr = mctx.font;
  const spacing = mctx.letterSpacing;
  // A thin stroke around the glyphs guarantees every stem is at least ~1.5
  // LEDs wide, so thin strokes never fall between two LEDs and vanish.
  const strokeW = ss * (font.stroke != null ? font.stroke : 0.5);
  const draw = (ctx) => {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    ctx.font = fontStr;
    if ('letterSpacing' in ctx) ctx.letterSpacing = spacing;
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.lineWidth = strokeW;
    if (strokeW > 0) ctx.strokeText(text, pad + left, baseline);
    ctx.fillText(text, pad + left, baseline);
  };
  return { draw, W };
}

// ---------------------------------------------------------------------------
/**
 * Draw the plan in horizontal chunks (so we never allocate a canvas wider than
 * the browser allows) and accumulate per-row prefix sums of premultiplied RGBA.
 */
// sRGB byte -> linear-light byte, so coloured glyphs (emoji) mix correctly with
// the linear-light renderer. White text is unaffected.
const LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) LINEAR[i] = Math.pow(i / 255, 2.2) * 255;

function buildStrip(draw, W, H, rows, ss) {
  const CW = 1024;
  const stride = 4;
  const bands = new Array(rows);
  for (let r = 0; r < rows; r++) bands[r] = new Float32Array((W + 2) * stride);
  const ctx = scratchCtx(Math.min(CW, W), H);
  for (let x0 = 0; x0 < W; x0 += CW) {
    const w = Math.min(CW, W - x0);
    ctx.setTransform(1, 0, 0, 1, -x0, 0);
    ctx.clearRect(x0, 0, w, H);
    draw(ctx, x0, x0 + w);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const img = ctx.getImageData(0, 0, w, H).data;
    for (let r = 0; r < rows; r++) {
      const band = bands[r];
      const yEnd = (r + 1) * ss;
      for (let y = r * ss; y < yEnd; y++) {
        let i = y * w * 4;
        for (let x = 0; x < w; x++, i += 4) {
          const a = img[i + 3];
          if (a) {
            const o = (x0 + x + 1) * stride;
            const f = a / 255;
            band[o] += LINEAR[img[i]] * f;
            band[o + 1] += LINEAR[img[i + 1]] * f;
            band[o + 2] += LINEAR[img[i + 2]] * f;
            band[o + 3] += a;
          }
        }
      }
    }
  }
  for (let r = 0; r < rows; r++) {
    const band = bands[r];
    for (let x = 1; x <= W + 1; x++) {
      const o = x * stride, p = o - stride;
      band[o] += band[p]; band[o + 1] += band[p + 1]; band[o + 2] += band[p + 2]; band[o + 3] += band[p + 3];
    }
  }
  return new Strip(bands, W, rows, ss);
}

export class Strip {
  constructor(bands, W, rows, ss) {
    this.bands = bands;
    this.W = W;
    this.rows = rows;
    this.ss = ss;
    this.widthLED = W / ss;
  }

  /**
   * Fill `target` (Uint8ClampedArray, cols*rows*4, row-major from the top) with
   * the LED values for a display of `cols` columns whose left edge is at strip
   * position `-X` — i.e. X is where the text's left edge sits on the display.
   * The text repeats every `period` LEDs.
   */
  fill(target, cols, X, period) {
    const { bands, W, ss, widthLED, rows } = this;
    const norm = 1 / (ss * ss);
    const stride = 4;
    for (let c = 0; c < cols; c++) {
      let u = c - X;
      u -= Math.floor(u / period) * period; // [0, period)
      let a0 = -1, b0 = -1, a1 = -1, b1 = -1;
      if (u < widthLED) {
        a0 = u * ss; b0 = Math.min((u + 1) * ss, W);
      }
      if (u + 1 > period) { // straddling the wrap: also sample the strip start
        a1 = 0; b1 = Math.min((u + 1 - period) * ss, W);
      }
      for (let r = 0; r < rows; r++) {
        const o = (r * cols + c) * 4;
        if (a0 < 0 && a1 < 0) { target[o] = target[o + 1] = target[o + 2] = target[o + 3] = 0; continue; }
        const band = bands[r];
        let R = 0, G = 0, B = 0, A = 0;
        if (a0 >= 0) {
          // linear interpolation of the prefix sum == exact integral over [a, b]
          const xa = Math.floor(a0), ta = a0 - xa, xb = Math.floor(b0), tb = b0 - xb;
          const pa = xa * stride, pb = xb * stride;
          R += (band[pb] + (band[pb + stride] - band[pb]) * tb) - (band[pa] + (band[pa + stride] - band[pa]) * ta);
          G += (band[pb + 1] + (band[pb + stride + 1] - band[pb + 1]) * tb) - (band[pa + 1] + (band[pa + stride + 1] - band[pa + 1]) * ta);
          B += (band[pb + 2] + (band[pb + stride + 2] - band[pb + 2]) * tb) - (band[pa + 2] + (band[pa + stride + 2] - band[pa + 2]) * ta);
          A += (band[pb + 3] + (band[pb + stride + 3] - band[pb + 3]) * tb) - (band[pa + 3] + (band[pa + stride + 3] - band[pa + 3]) * ta);
        }
        if (a1 >= 0 && b1 > 0) {
          const xb = Math.floor(b1), tb = b1 - xb, pb = xb * stride;
          R += band[pb] + (band[pb + stride] - band[pb]) * tb;
          G += band[pb + 1] + (band[pb + stride + 1] - band[pb + 1]) * tb;
          B += band[pb + 2] + (band[pb + stride + 2] - band[pb + 2]) * tb;
          A += band[pb + 3] + (band[pb + stride + 3] - band[pb + 3]) * tb;
        }
        target[o] = R * norm; target[o + 1] = G * norm; target[o + 2] = B * norm; target[o + 3] = A * norm;
      }
    }
  }
}
