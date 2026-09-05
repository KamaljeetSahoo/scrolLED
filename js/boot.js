// boot.js — the sign powers on. A self-test bar sweeps the panel, the wordmark
// sparkles in LED by LED, an RGB colour test washes over it, then it scrolls
// off to hand the panel to the user. Like a real sign's power-on self-test it
// runs on the very LEDs the app will use, so there is no separate "loading UI".

import { rasterize } from './raster.js';

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
const hash = (i) => { let x = (i + 1) * 2654435761 >>> 0; x ^= x >>> 15; x = (x * 2246822519) >>> 0; x ^= x >>> 13; return (x >>> 0) / 4294967296; };

/**
 * @param {import('./engine.js').Engine} engine
 * @param {{W:number,H:number,ready:Promise<any>,tint:number[],warm?:boolean,reduced?:boolean,maxWait?:number}} opts
 * @returns {{done: Promise<void>, skip: () => void}}
 */
export function bootSequence(engine, { W, H, ready, tint = [1, 0.23, 0.12], warm = false, reduced = false, maxWait = 3500 }) {
  const pitch = Math.min(W, H) / 52;
  const rows = Math.max(12, Math.round(H / pitch));
  engine.setRows(rows);
  engine.setRect(0, 0, W, H, true);
  engine.setAngle(0, true);
  engine.setMode(2);                 // native colours: the boot paints its own RGB
  engine.setPresent(0, true);
  engine.setBrightness(0, true);
  engine.setBrightness(1);

  const mark = rasterize('scrolLED', 'pixel', 10);
  const mw = mark.widthLED, mh = 10;
  const markBuf = new Uint8ClampedArray(mw * mh * 4);
  mark.fill(markBuf, mw, 0, 1e9);

  // Linear-light colour of the sign (matches what the app will tint with).
  const T = tint.map(c => Math.pow(c, 2.2) * 255);
  const white = [255, 255, 255];

  let isReady = false;
  Promise.resolve(ready).catch(() => {}).then(() => { isReady = true; });
  setTimeout(() => { isReady = true; }, maxWait);

  // Timeline (seconds). Warm boots run the same choreography, faster.
  const rate = reduced ? 1.6 : warm ? 1.45 : 1;
  const SWEEP_END = 0.62, REVEAL_START = 0.42, REVEAL_END = 0.95, RGB_START = 1.02, RGB_LEN = 0.42, HOLD_UNTIL = 1.62;

  let t0 = null, e = 0, exitT = null, fast = false, finished = false;
  let trail = null;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });

  engine.setOverride((buf, cols, rows, t, dt) => {
    if (t0 === null) t0 = t;
    const speed = rate * (fast ? 4 : 1);
    e += dt * speed;
    if (!trail || trail.length !== buf.length) trail = new Float32Array(buf.length);
    buf.fill(0);

    // 1) Self-test sweep: a bar of light scans left to right across every row.
    if (e < SWEEP_END + 0.3 && !reduced) {
      const x = -4 + (cols + 8) * smooth(e / SWEEP_END);
      for (let c = 0; c < cols; c++) {
        const d = c - x;
        const w = Math.exp(-d * d / 3.0);
        if (w < 0.01) continue;
        // white-hot leading edge fading into the sign colour
        const mixW = clamp01((d + 1.5) / 3);
        const R = (white[0] * mixW + T[0] * (1 - mixW)) * w;
        const G = (white[1] * mixW + T[1] * (1 - mixW)) * w;
        const B = (white[2] * mixW + T[2] * (1 - mixW)) * w;
        const A = 255 * w;
        for (let r = 0; r < rows; r++) {
          const o = (r * cols + c) * 4;
          buf[o] = R; buf[o + 1] = G; buf[o + 2] = B; buf[o + 3] = A;
        }
      }
    }

    // 2) Wordmark sparkles in, 3) RGB colour test washes across it, 4) it slides off.
    if (e >= REVEAL_START) {
      if (exitT === null && (e >= HOLD_UNTIL && (isReady || fast))) exitT = e;
      const since = exitT === null ? 0 : e - exitT;
      const slide = since * since * 260 + since * 30;
      const cx0 = Math.round((cols - mw) / 2) - slide;
      const cy0 = Math.round((rows - mh) / 2);
      if (exitT !== null && cx0 + mw < -2 && !finished) { finished = true; resolveDone(); }
      const rgbT = (e - RGB_START) / RGB_LEN; // 0..1 while the colour wave crosses
      for (let r = 0; r < mh; r++) {
        const gy = cy0 + r;
        if (gy < 0 || gy >= rows) continue;
        for (let c = 0; c < mw; c++) {
          const mi = (r * mw + c) * 4;
          const a = markBuf[mi + 3];
          if (!a) continue;
          const ti = reduced ? REVEAL_START : REVEAL_START + hash(r * mw + c) * (REVEAL_END - REVEAL_START);
          const on = clamp01((e - ti) / 0.09);
          if (on <= 0) continue;
          // colour: sign tint, with a red->green->blue wave passing through once
          let R = T[0], G = T[1], B = T[2];
          if (rgbT > 0 && rgbT < 1) {
            const pos = c / mw - (rgbT * 1.6 - 0.3);       // wave position relative to this column
            const wR = Math.exp(-((pos + 0.16) ** 2) / 0.006);
            const wG = Math.exp(-((pos) ** 2) / 0.006);
            const wB = Math.exp(-((pos - 0.16) ** 2) / 0.006);
            const wSum = Math.min(1, wR + wG + wB);
            R = R * (1 - wSum) + 255 * wR; G = G * (1 - wSum) + 255 * wG; B = B * (1 - wSum) + 255 * wB;
          }
          // fractional slide: split the LED across two columns for smooth motion
          const gx = cx0 + c;
          const gxi = Math.floor(gx), f = gx - gxi;
          for (let k = 0; k < 2; k++) {
            const xx = gxi + k;
            const wgt = (k === 0 ? 1 - f : f) * on * (a / 255);
            if (xx < 0 || xx >= cols || wgt <= 0.001) continue;
            const o = (gy * cols + xx) * 4;
            buf[o] = Math.max(buf[o], R * wgt); buf[o + 1] = Math.max(buf[o + 1], G * wgt);
            buf[o + 2] = Math.max(buf[o + 2], B * wgt); buf[o + 3] = Math.max(buf[o + 3], 255 * wgt);
          }
        }
      }
    }

    // Phosphor trail for the sweep and the exit.
    const decay = Math.exp(-dt * speed / 0.09);
    for (let i = 0; i < buf.length; i++) {
      const p = trail[i] * decay;
      if (buf[i] >= p) trail[i] = buf[i]; else { trail[i] = p; buf[i] = p; }
    }
  });

  return {
    done,
    /** A tap does not cut the animation, it plays it 4x faster. */
    skip() { fast = true; },
  };
}
