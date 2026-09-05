// engine.js — the LED panel. Owns the canvas, the per-frame motion of the text,
// and the rendering (WebGL with a Canvas2D fallback). Think of it as the sign's
// controller board: the app hands it a Strip (the message on tape) plus a few
// knobs, and it drives the LEDs every frame.
//
// Light is handled in linear space: the LED texture stores sqrt-encoded values
// (decoded in the shader), colours are tinted in linear light, and the output is
// tone-mapped and gamma-encoded with a touch of dither. That is what keeps a
// half-covered LED at half the light instead of a fifth, so smooth scrolling
// reads as motion rather than flicker.

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (cur, target, rate, dt) => lerp(cur, target, 1 - Math.exp(-rate * dt));
const mod = (a, n) => a - Math.floor(a / n) * n;
const toLinear = (c) => Math.pow(c, 2.2);

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uTex;
uniform vec2 uGrid;        // cols, rows
uniform vec2 uCanvas;      // device px
uniform mat3 uToLogical;   // device px -> logical px
uniform float uPitch;      // logical px per LED
uniform vec2 uGridOrigin;  // logical px of the grid's top-left
uniform vec3 uTint;        // linear light
uniform float uMode;       // 0 mono tint, 1 rainbow, 2 native colours
uniform float uGlow;       // 0..1
uniform float uShape;      // 0 round, 1 square
uniform float uBright;
uniform float uPresent;    // 0 preview, 1 presenting (distance profile)
uniform float uTime;
uniform float uPulse;      // 0..1 energy from mic / motion
uniform float uBeat;       // 0..1 beat impulse
uniform vec2 uTilt;        // physical "up" in logical space (y down); shifts the dome highlight

vec3 hsv(float h) {
  vec3 p = abs(fract(vec3(h) + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return clamp(p - 1.0, 0.0, 1.0);
}
float hash(vec2 p) { p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }

// Linear colour of one LED from its (decoded) texel. rgb is premultiplied by
// coverage, so a half-covered white LED is (0.5,0.5,0.5).
vec3 ledCol(vec4 s, vec2 cell) {
  float lum = dot(s.rgb, vec3(0.2126, 0.7152, 0.0722));
  if (uMode < 0.5) return uTint * lum;
  if (uMode > 1.5) return s.rgb;
  float mx = max(s.r, max(s.g, s.b));
  float mn = min(s.r, min(s.g, s.b));
  float sat = mx > 0.002 ? (mx - mn) / mx : 0.0;
  float hue = fract(cell.x / (uGrid.x * 1.6) + cell.y / uGrid.y * 0.06 - uTime * 0.05 + uBeat * 0.08);
  vec3 rb = mix(hsv(hue), vec3(1.0), 0.10) * lum;
  return mix(rb, s.rgb, smoothstep(0.15, 0.6, sat)); // emoji keep their own colours
}

vec4 fetch(vec2 cell) { vec4 t = texture2D(uTex, (cell + 0.5) / uGrid); return t * t; }

void main() {
  vec2 dp = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y);
  vec3 l3 = uToLogical * vec3(dp, 1.0);
  vec2 q = (l3.xy - uGridOrigin) / uPitch;
  vec2 cell = floor(q);
  vec2 f = q - cell - 0.5;

  // Halo: every lit neighbour bleeds a gaussian of light onto this pixel.
  vec3 halo = vec3(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 nc = cell + vec2(float(i), float(j));
      if (nc.x < 0.0 || nc.y < 0.0 || nc.x >= uGrid.x || nc.y >= uGrid.y) continue;
      vec2 d = q - (nc + 0.5);
      halo += ledCol(fetch(nc), nc) * exp(-dot(d, d) * 2.2);
    }
  }

  vec3 col = vec3(0.0);
  float core = 0.0;
  bool inside = cell.x >= 0.0 && cell.y >= 0.0 && cell.x < uGrid.x && cell.y < uGrid.y;
  if (inside) {
    vec4 s = fetch(cell);
    float v = clamp(s.a, 0.0, 1.0);
    vec3 c = ledCol(s, cell);
    float small = clamp((uPitch - 4.0) / 8.0, 0.0, 1.0);
    float R = mix(mix(0.44, 0.37, small), 0.45, uPresent);   // tiny LEDs and presenting: fuller discs
    if (uShape > 0.5) R -= 0.03;
    R *= 1.0 + 0.05 * uPulse + 0.04 * uBeat;                  // the discs swell with the music
    float d = uShape < 0.5 ? length(f) : max(abs(f.x), abs(f.y));
    float aa = 0.8 / uPitch;
    core = 1.0 - smoothstep(R - aa, R + aa, d);
    // The dome's bright spot sits toward physical "up", like a glossy LED catching the light.
    float dome = 1.0 - smoothstep(0.0, R, length(f - uTilt * 0.13));
    float hot = smoothstep(0.55, 1.0, v) * dome;             // overdriven white core
    vec3 lit = mix(c, vec3(max(c.r, max(c.g, c.b))), mix(0.22, 0.45, uPresent) * hot);
    lit *= (0.78 + 0.42 * dome) * (1.0 + 0.30 * uBeat);
    lit *= 0.94 + 0.06 * hash(cell);                          // tiny per-LED gain variance
    vec3 unlit = (vec3(0.0026) + uTint * 0.0014) * (1.0 - uPresent) * mix(0.5, 1.0, small);
    col += core * (unlit * (1.0 - v) + lit);
  }

  // Wide, soft bloom from the bilinear field; masked so it stops at the panel edge.
  vec2 dOut = max(max(-q, q - uGrid), 0.0);
  float edgeMask = exp(-dot(dOut, dOut) * 6.0);
  vec4 wide = texture2D(uTex, q / uGrid); wide *= wide;
  vec3 wideCol = ledCol(wide, q) * edgeMask;

  // The halo sums are perceptual-ish quantities; squaring them before adding in
  // linear light keeps the falloff soft instead of flooding the gaps.
  float glowGain = (0.05 + 0.17 * uGlow) * (1.0 + 0.35 * uPresent) * (1.0 + 0.9 * uPulse + 0.7 * uBeat);
  col += halo * halo * glowGain * (1.0 - 0.55 * core);
  col += wideCol * wideCol * (0.07 * uGlow);
  col *= uBright;

  // tone map (soft shoulder), gamma, dither
  col = 1.0 - exp(-col * 2.2);
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  float n = fract(52.9829189 * fract(0.06711056 * gl_FragCoord.x + 0.00583715 * gl_FragCoord.y));
  gl_FragColor = vec4(col + (n - 0.5) / 255.0, 1.0);
}
`;

export class Engine {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{width?:number,height?:number,dpr?:number}} [fixed] render at a fixed
   *   size (for offscreen cards) instead of following the canvas's CSS size
   */
  constructor(canvas, fixed = null) {
    this.canvas = canvas;
    this.fixed = fixed;
    this.dpr = 1;
    this.dprCap = 2;
    this.rows = 10;
    this.strip = null;
    this.override = null;
    this.paused = false;
    this.speed = 0;          // glyph-pixels per second (scaled by rows/10 into LEDs/s)
    this.speedCur = 0;
    this.direction = -1;     // -1: text moves left, +1: text moves right
    this.stepped = false;
    this.afterglow = false;
    this.glow = 0.6;
    this.shape = 0;
    this.mode = 0;           // 0 mono, 1 rainbow, 2 native
    this.tint = [1, 0.2, 0.15].map(toLinear);
    this.tintCur = this.tint.slice();
    this.bright = 1;
    this.brightCur = 1;
    this.present = 0;
    this.presentCur = 0;
    this.pulse = 0; this.beat = 0; this.up = [0, 0]; // reactive inputs (see reactive.js)
    this.rect = { x: 0, y: 0, w: 1, h: 1 };
    this.rectCur = { x: 0, y: 0, w: 1, h: 1 };
    this.angle = 0;          // degrees
    this.angleCur = 0;
    this.rectRate = 9;       // how quickly the panel rect follows its target (1/s)
    this.angleRate = 7;      // how quickly the panel rotates toward its target (1/s)
    this.X = null;           // text left edge position on the display (LEDs)
    this.enterFromEdge = true;
    this.dwell = 'enter';    // enter | hold | exit (short messages slide in, hold, slide out)
    this.holdUntil = 0;
    this.stepAcc = 0;
    this.grab = null;        // { vel } while the user drags the strip
    this.flingVel = null;    // LEDs/s while a thrown strip settles back to cruise
    this.cols = 0;
    this.pitch = 1;
    this.PX = 1;
    this.buf = null;         // Uint8 sqrt-encoded upload buffer
    this.lin = null;         // Float32 linear values (after afterglow)
    this.glowBuf = null;
    this.time = 0;
    this.last = 0;
    this.raf = 0;
    this.onFrame = null;
    this.dirty = true;
    this.slowFrames = 0; this.frameCount = 0; this.frameWindow = 0;
    this.stats = { fps: 0, frames: 0, acc: 0 };
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.stop(); }, false);
    this.canvas.addEventListener('webglcontextrestored', () => { this.gl = null; if (this._initGL()) { this.resize(); this.dirty = true; this.start(); } }, false);
    // Probe on a throwaway canvas: if the shader cannot compile here, the real
    // canvas is never touched by WebGL and the 2D fallback can still claim it.
    if (this._probeGL() && this._initGL()) { /* WebGL */ } else this._init2D();
    this.resize();
  }

  // ------------------------------------------------------------- public knobs
  setStrip(strip) { this.strip = strip; this.dirty = true; }
  setRows(rows) {
    if (rows === this.rows) return;
    this.rows = rows;
    this._scaleOnCols = true; // the grid re-fits next frame: scale X instead of re-centring
    this.dirty = true;
  }
  setRect(x, y, w, h, immediate = false) {
    this.rect = { x, y, w, h };
    if (immediate) this.rectCur = { x, y, w, h };
  }
  setAngle(deg, immediate = false) {
    if (immediate) { this.angle = deg; this.angleCur = deg; return; }
    const d = ((deg - this.angleCur) % 360 + 540) % 360 - 180; // shortest way round
    this.angle = deg + 360 * Math.round((this.angleCur + d - deg) / 360); // exact multiple of 360 away from deg
  }
  setSpeed(v) { this.speed = v; }
  setDirection(dir) { const d = dir < 0 ? -1 : 1; if (d !== this.direction) { this.direction = d; this.dwell = 'enter'; } }
  setStepped(v) { this.stepped = !!v; this.dirty = true; }
  setAfterglow(v) { this.afterglow = !!v; this.dirty = true; }
  setGlow(v) { this.glow = clamp(v, 0, 1); this.dirty = true; }
  setShape(s) { this.shape = s === 'square' ? 1 : 0; this.dirty = true; }
  setMode(m) { this.mode = m; this.dirty = true; }
  setRainbow(v) { this.setMode(v ? 1 : 0); }
  /** rgb in sRGB 0..1; converted to linear light. */
  setTint(rgb, immediate = false) { this.tint = rgb.map(toLinear); if (immediate) this.tintCur = this.tint.slice(); }
  setBrightness(b, immediate = false) { this.bright = b; if (immediate) this.brightCur = b; }
  setPresent(p, immediate = false) { this.present = p ? 1 : 0; if (immediate) this.presentCur = this.present; }
  setOverride(fn) { this.override = fn; this.dirty = true; }
  /** Live inputs from the senses: energy 0..1, beat impulse 0..1, physical up in screen coords (y down). */
  setReactive(pulse, beat, up) {
    if (Math.abs(pulse - this.pulse) > 0.003 || Math.abs(beat - this.beat) > 0.003 || Math.abs(up[0] - this.up[0]) + Math.abs(up[1] - this.up[1]) > 0.004) this.dirty = true;
    this.pulse = pulse; this.beat = beat; this.up = [up[0], up[1]];
  }
  resetPosition() { this.enterFromEdge = true; this.dwell = 'enter'; this.flingVel = null; }
  /** Brief power dip, like a controller re-configuring. */
  brownout(depth = 0.3) { this.brightCur = Math.min(this.brightCur, depth); }

  // Direct manipulation: the user grabs the strip and drags it.
  grabStart() { this.grab = { vel: 0 }; this.flingVel = null; }
  grabMove(dxDevicePx, vxDevicePxPerSec) {
    if (!this.grab || this.X === null) return;
    this.X += dxDevicePx / this.PX;
    this.grab.vel = vxDevicePxPerSec / this.PX;
    this.dirty = true;
  }
  grabEnd() {
    if (!this.grab) return;
    const v = clamp(this.grab.vel, -160 * this.rows / 10, 160 * this.rows / 10);
    this.grab = null;
    this.flingVel = Math.abs(v) > 2 ? v : null;
    this.dwell = 'enter';
  }

  get isWebGL() { return !!this.gl; }

  /** Snap every eased parameter to its target and draw one frame right now. */
  renderNow() {
    this.rectCur = { ...this.rect };
    this.angleCur = this.angle;
    this.tintCur = this.tint.slice();
    this.brightCur = this.bright;
    this.presentCur = this.present;
    this.speedCur = this.speed;
    this.dirty = true;
    this.last = performance.now() - 16;
    this.frame(performance.now());
  }

  start() {
    if (this.raf) return;
    this.last = performance.now();
    const loop = (now) => { this.raf = requestAnimationFrame(loop); this.frame(now); };
    this.raf = requestAnimationFrame(loop);
  }
  stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }

  resize() {
    const cssW = this.fixed ? this.fixed.width : (this.canvas.clientWidth || 1);
    const cssH = this.fixed ? this.fixed.height : (this.canvas.clientHeight || 1);
    // Cap the backing store so the fragment shader never runs over more than ~2.4 M pixels.
    const areaCap = Math.sqrt(2.4e6 / (cssW * cssH));
    const dpr = this.fixed ? (this.fixed.dpr || 1) : Math.max(1, Math.min(window.devicePixelRatio || 1, this.dprCap, areaCap));
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h || this.dpr !== dpr) {
      this.dpr = dpr;
      this.canvas.width = w;
      this.canvas.height = h;
      if (this.gl) this.gl.viewport(0, 0, w, h);
      this.dirty = true;
    }
  }

  // --------------------------------------------------------------- the frame
  frame(now) {
    const rawDt = (now - this.last) / 1000;
    const dt = clamp(rawDt, 0, 0.05);      // motion: never jump more than 50 ms worth
    const da = clamp(rawDt, 0, 0.25);      // eased parameters: follow real time even on slow frames
    this.last = now;
    this.time += dt;
    this._pace(rawDt);

    // Animated parameters ease toward their targets (exponential damping).
    const k = this.rectRate;
    const rc = this.rectCur, r = this.rect;
    rc.x = damp(rc.x, r.x, k, da); rc.y = damp(rc.y, r.y, k, da);
    rc.w = damp(rc.w, r.w, k, da); rc.h = damp(rc.h, r.h, k, da);
    this.angleCur = damp(this.angleCur, this.angle, this.angleRate, da);
    for (let i = 0; i < 3; i++) this.tintCur[i] = damp(this.tintCur[i], this.tint[i], 8, da);
    this.brightCur = damp(this.brightCur, this.bright, 14, da);
    this.presentCur = damp(this.presentCur, this.present, 5, da);
    this.speedCur = damp(this.speedCur, this.speed, 6, da);
    if (Math.abs(this.angle - this.angleCur) < 0.05) this.angleCur = this.angle;
    for (const key of ['x', 'y', 'w', 'h']) if (Math.abs(rc[key] - r[key]) < 0.05) rc[key] = r[key];
    const settled = Math.abs(this.angle - this.angleCur) < 0.3 &&
      Math.abs(rc.x - r.x) + Math.abs(rc.y - r.y) + Math.abs(rc.w - r.w) + Math.abs(rc.h - r.h) < 1;
    let animating = !settled ||
      Math.abs(this.brightCur - this.bright) > 0.002 || Math.abs(this.presentCur - this.present) > 0.002 ||
      Math.abs(this.tintCur[0] - this.tint[0]) + Math.abs(this.tintCur[1] - this.tint[1]) + Math.abs(this.tintCur[2] - this.tint[2]) > 0.002;

    // Layout: logical size swaps as the panel rotates. Pitch snaps to whole
    // device pixels once the panel has settled, so every LED is equally sharp.
    const dpr = this.dpr;
    const th = this.angleCur * Math.PI / 180;
    const s2 = Math.sin(th) ** 2;
    const lw = lerp(rc.w, rc.h, s2);
    const lh = lerp(rc.h, rc.w, s2);
    const rows = this.rows;
    const LW = lw * dpr, LH = lh * dpr;
    let PX = Math.max(1e-3, LH / rows);
    if (settled) PX = Math.max(2, Math.floor(PX));
    const cols = Math.max(1, Math.floor(LW / PX + 1e-6));
    if (cols !== this.cols || !this.buf || this.buf.length !== cols * rows * 4) {
      if (this.X !== null && this.cols) {
        if (this._scaleOnCols) this.X *= cols / this.cols;   // dot size changed: same relative position
        else this.X += (cols - this.cols) / 2;               // panel resized: keep the text centred
      }
      this._scaleOnCols = false;
      this.cols = cols;
      this.buf = new Uint8ClampedArray(cols * rows * 4);
      this.lin = new Float32Array(cols * rows * 4);
      this.glowBuf = new Float32Array(cols * rows * 4);
      this._texDirty = true;
      this.dirty = true;
    }
    if (PX !== this.PX) { this.PX = PX; this.dirty = true; }
    this.pitch = PX / dpr;
    this.lw = lw; this.lh = lh;
    let gox = (LW - cols * PX) / 2, goy = (LH - rows * PX) / 2;
    if (settled) { gox = Math.floor(gox); goy = Math.floor(goy); }
    this.gridOriginX = gox; this.gridOriginY = goy;

    // Motion of the text.
    const strip = this.strip;
    const kScale = rows / 10;
    let moved = false;
    if (this.override) {
      this.override(this.lin, cols, rows, this.time, dt);
      moved = true;
    } else if (strip && strip.widthLED > 0) {
      const wl = strip.widthLED;
      const gap = Math.max(8 * kScale, cols);
      const P = wl + gap;
      const fits = wl <= cols * 0.9;
      const dir = this.direction;
      if (this.enterFromEdge || this.X === null) {
        this.X = dir < 0 ? cols : -wl;
        this.enterFromEdge = false;
        this.dwell = 'enter';
      }
      let v = this.speedCur * kScale;
      if (this.speed <= 0 && !fits) v = Math.max(v, 4 * kScale); // never leave long text stuck
      const prevX = this.X;
      const Xc = (cols - wl) / 2;
      if (this.grab) {
        // position is driven by the finger
      } else if (this.flingVel !== null) {
        const target = (this.speed <= 0 && fits) ? 0 : v * dir;
        this.flingVel = damp(this.flingVel, target, 2.5, dt);
        this.X += this.flingVel * dt;
        if (Math.abs(this.flingVel - target) < 0.4) this.flingVel = null;
      } else if (this.paused) {
        // hold still
      } else if (this.speed <= 0 && fits) {
        this.X = damp(this.X, Xc, 8, dt);
        this.dwell = 'enter';
      } else if (fits) {
        this._dwellStep(dt, v, dir, wl, cols, Xc, kScale, P);
      } else {
        this.dwell = 'enter';
        if (this.stepped) {
          this.stepAcc += v * dt;
          const steps = Math.floor(this.stepAcc);
          if (steps > 0) { this.X += steps * dir; this.stepAcc -= steps; }
        } else {
          this.X += v * dt * dir;
        }
      }
      // Normalise into [cols - P, cols) so numbers stay small and the text wraps.
      this.X = cols - P + mod(this.X - (cols - P), P);
      const Xs = this.stepped ? Math.round(this.X) : this.X;
      moved = Xs !== this._lastXs || prevX !== this.X;
      this._lastXs = Xs;
      // With afterglow on, lin carries last frame's trails, so it must be re-sampled every frame.
      if (moved || this.dirty || this.afterglow) strip.fill(this.lin, cols, Xs, P);
    } else if (this.dirty || this.afterglow) {
      this.lin.fill(0);
    }

    // Afterglow: LEDs fade out instead of switching off.
    let glowing = false;
    if (this.afterglow) {
      const g = this.glowBuf, b = this.lin;
      const decay = Math.exp(-dt / 0.11);
      for (let i = 0; i < b.length; i++) {
        const p = g[i] * decay;
        if (b[i] >= p) g[i] = b[i]; else { g[i] = p < 0.5 ? 0 : p; b[i] = g[i]; if (g[i]) glowing = true; }
      }
    } else if (this.glowBuf) {
      this.glowBuf.set(this.lin);
    }

    const needDraw = this.dirty || moved || animating || glowing || this.mode === 1 || (this.grab !== null);
    if (needDraw) {
      // sqrt-encode for the 8-bit texture
      const b = this.buf, l = this.lin;
      for (let i = 0; i < l.length; i++) b[i] = Math.sqrt(l[i] * 255);

      // Transform: device px -> logical px (rotation about the rect centre).
      const cx = (rc.x + rc.w / 2) * dpr, cy = (rc.y + rc.h / 2) * dpr;
      const c = Math.cos(th), s = Math.sin(th);
      const tx = LW / 2 - (c * cx + s * cy);
      const ty = LH / 2 - (-s * cx + c * cy);
      this.mat = [c, -s, 0, s, c, 0, tx, ty, 1];
      if (this.gl) this._drawGL(cols, rows, PX); else this._draw2D(cols, rows, PX, c, s, cx, cy, LW, LH);
      this.dirty = false;
    }

    const st = this.stats; st.frames++; st.acc += dt;
    if (st.acc >= 1) { st.fps = st.frames / st.acc; st.frames = 0; st.acc = 0; }
    if (this.onFrame) this.onFrame(this);
  }

  // Short messages: slide in, hold centred, slide out, repeat.
  _dwellStep(dt, v, dir, wl, cols, Xc, kScale, P) {
    // Work in a wrap window centred on the hold position, so "past the centre"
    // and "approaching again" are unambiguous after the position wraps.
    const half = P / 2;
    this.X = Xc - half + mod(this.X - (Xc - half), P);
    const D = 6 * kScale; // easing distance in LEDs
    const toCenter = dir < 0 ? this.X - Xc : Xc - this.X; // >0 while approaching, <0 once past
    if (this.dwell === 'hold') {
      this.X = Xc;
      if (this.time >= this.holdUntil) this.dwell = 'exit';
      return;
    }
    if (this.dwell === 'enter' && toCenter < -0.5) this.dwell = 'exit';      // already past (fling, resize)
    else if (this.dwell === 'exit' && toCenter > 0.5) this.dwell = 'enter';  // wrapped: coming back in
    if (this.dwell === 'enter') {
      if (toCenter <= 0.02) {
        this.X = Xc; this.dwell = 'hold';
        const chars = Math.max(1, Math.round(wl / (6 * kScale)));
        this.holdUntil = this.time + clamp(1.2 + 0.18 * chars, 1.6, 4.5);
        return;
      }
      const f = clamp(toCenter / D, 0.12, 1);
      this.X += Math.min(v * Math.sqrt(f) * dt, toCenter) * dir;
    } else {
      const away = Math.max(0, -toCenter);
      const f = clamp(0.12 + away / D, 0, 1);
      this.X += v * f * dt * dir;
    }
  }

  // Adaptive resolution: if frames are consistently slow, lower the DPR cap (never raise it back).
  _pace(rawDt) {
    if (this.fixed || document.visibilityState !== 'visible' || rawDt <= 0 || rawDt > 0.5) return;
    this.frameCount++; this.frameWindow += rawDt;
    this.minDt = Math.min(this.minDt || 1, rawDt);
    // "Slow" is relative to the fastest frame seen (about the display's refresh period),
    // so a 30 Hz display or low-power mode does not look like a struggling GPU.
    if (rawDt > Math.max(0.028, 1.7 * (this.minDt || 0.016))) this.slowFrames++;
    if (this.frameWindow >= 2) {
      if (this.frameCount > 20 && this.slowFrames / this.frameCount > 0.4 && this.dprCap > 1.25) {
        this.dprCap = this.dprCap > 1.5 ? 1.5 : 1.25;
        this.resize();
      }
      this.frameCount = 0; this.slowFrames = 0; this.frameWindow = 0; this.minDt = 1;
    }
  }

  // ----------------------------------------------------------------- WebGL
  _probeGL() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl', { failIfMajorPerformanceCaveat: false }) || c.getContext('experimental-webgl');
      if (!gl) return false;
      const ok = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); const r = gl.getShaderParameter(sh, gl.COMPILE_STATUS); gl.deleteShader(sh); return r; };
      const good = ok(gl.VERTEX_SHADER, VERT) && ok(gl.FRAGMENT_SHADER, FRAG);
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return good;
    } catch (e) { return false; }
  }

  _initGL() {
    let gl = null;
    const attrs = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false, desynchronized: true };
    try {
      gl = this.canvas.getContext('webgl', attrs) || this.canvas.getContext('experimental-webgl', attrs);
    } catch (e) { gl = null; }
    if (!gl) return false;
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { console.warn('shader', gl.getShaderInfoLog(sh)); return null; }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT), fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return false;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn('link', gl.getProgramInfoLog(prog)); return false; }
    gl.useProgram(prog);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const u = {};
    for (const name of ['uTex', 'uGrid', 'uCanvas', 'uToLogical', 'uPitch', 'uGridOrigin', 'uTint', 'uMode', 'uGlow', 'uShape', 'uBright', 'uPresent', 'uTime', 'uPulse', 'uBeat', 'uTilt']) u[name] = gl.getUniformLocation(prog, name);
    gl.uniform1i(u.uTex, 0);
    gl.clearColor(0, 0, 0, 1);
    this.gl = gl; this.prog = prog; this.tex = tex; this.u = u; this.texW = 0; this.texH = 0;
    return true;
  }

  _drawGL(cols, rows, PX) {
    const gl = this.gl, u = this.u;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (this.texW !== cols || this.texH !== rows) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.buf);
      this.texW = cols; this.texH = rows;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, this.buf);
    }
    gl.uniform2f(u.uGrid, cols, rows);
    gl.uniform2f(u.uCanvas, this.canvas.width, this.canvas.height);
    gl.uniformMatrix3fv(u.uToLogical, false, this.mat);
    gl.uniform1f(u.uPitch, PX);
    gl.uniform2f(u.uGridOrigin, this.gridOriginX, this.gridOriginY);
    gl.uniform3f(u.uTint, this.tintCur[0], this.tintCur[1], this.tintCur[2]);
    gl.uniform1f(u.uMode, this.mode);
    gl.uniform1f(u.uGlow, this.glow);
    gl.uniform1f(u.uShape, this.shape);
    gl.uniform1f(u.uBright, this.brightCur);
    gl.uniform1f(u.uPresent, this.presentCur);
    gl.uniform1f(u.uTime, this.time);
    gl.uniform1f(u.uPulse, this.pulse);
    gl.uniform1f(u.uBeat, this.beat);
    // physical up (screen, y down) -> logical space: rotate by -angle
    const th2 = this.angleCur * Math.PI / 180, c2 = Math.cos(th2), s2 = Math.sin(th2);
    gl.uniform2f(u.uTilt, c2 * this.up[0] + s2 * this.up[1], -s2 * this.up[0] + c2 * this.up[1]);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // --------------------------------------------------------------- Canvas2D
  _init2D() {
    this.gl = null;
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    if (!this.ctx) {
      // The canvas already holds a WebGL context; swap in a fresh element for 2D.
      const fresh = this.canvas.cloneNode(false);
      this.canvas.replaceWith(fresh);
      this.canvas = fresh;
      this.ctx = fresh.getContext('2d', { alpha: false });
    }
    this.sprites = null;
  }

  _srgbTint() {
    return this.tintCur.map(v => Math.round(clamp(Math.pow(v, 1 / 2.2), 0, 1) * 255));
  }

  _buildSprites(PX) {
    const levels = 24;
    const size = Math.ceil(PX * 2.4);
    const sheet = document.createElement('canvas');
    sheet.width = size * levels; sheet.height = size;
    const c = sheet.getContext('2d');
    const [tr, tg, tb] = this._srgbTint();
    for (let i = 0; i < levels; i++) {
      const b = i / (levels - 1);
      const cx = i * size + size / 2, cy = size / 2;
      const R = PX * (this.shape ? 0.34 : 0.37);
      if (b > 0) {
        const g = c.createRadialGradient(cx, cy, R * 0.4, cx, cy, size / 2);
        g.addColorStop(0, `rgba(${tr},${tg},${tb},${(0.55 * b * this.glow).toFixed(3)})`);
        g.addColorStop(1, `rgba(${tr},${tg},${tb},0)`);
        c.fillStyle = g; c.fillRect(i * size, 0, size, size);
      }
      const dome = c.createRadialGradient(cx - R * 0.15, cy - R * 0.15, 0, cx, cy, R);
      const lit = (v, u) => Math.round(clamp(u + (v - u) * b, 0, 255));
      dome.addColorStop(0, `rgb(${lit(tr * 1.25 + 40, 12)},${lit(tg * 1.25 + 40, 12)},${lit(tb * 1.25 + 40, 12)})`);
      dome.addColorStop(1, `rgb(${lit(tr * 0.8, 9)},${lit(tg * 0.8, 9)},${lit(tb * 0.8, 9)})`);
      c.fillStyle = dome;
      c.beginPath();
      if (this.shape) c.rect(cx - R, cy - R, 2 * R, 2 * R); else c.arc(cx, cy, R, 0, Math.PI * 2);
      c.fill();
    }
    this.sprites = { sheet, size, levels, PX, key: this._spriteKey() };
  }
  _spriteKey() { return `${this._srgbTint().join(',')}|${this.shape}|${this.glow.toFixed(2)}`; }

  _draw2D(cols, rows, PX, c, s, cx, cy, LW, LH) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (!this.sprites || Math.abs(this.sprites.PX - PX) > PX * 0.04 || this.sprites.key !== this._spriteKey()) this._buildSprites(PX);
    const sp = this.sprites;
    // logical -> device: p = R(theta) * (l - L/2) + centre
    const e = cx - (c * LW / 2 - s * LH / 2);
    const f = cy - (s * LW / 2 + c * LH / 2);
    ctx.setTransform(c, s, -s, c, e, f);
    ctx.globalAlpha = clamp(this.brightCur, 0, 1);
    const lin = this.lin, ox = this.gridOriginX, oy = this.gridOriginY, size = sp.size, half = size / 2;
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        const i = (r * cols + col) * 4;
        const lum = (lin[i] * 0.2126 + lin[i + 1] * 0.7152 + lin[i + 2] * 0.0722) / 255;
        const level = Math.round(clamp(Math.pow(lum, 0.6), 0, 1) * (sp.levels - 1));
        if (level === 0 && this.presentCur > 0.5) continue; // presenting: true black between LEDs
        ctx.drawImage(sp.sheet, level * size, 0, size, size, ox + col * PX + PX / 2 - half, oy + r * PX + PX / 2 - half, size, size);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}
