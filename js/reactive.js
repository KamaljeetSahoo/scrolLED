// reactive.js — the sign's senses. Listens to the microphone (bass energy and
// beats) and to the motion sensors (how hard the phone is moving, which way is
// up) and distils them into a few smooth numbers the renderer and UI can use:
//   level  0..1  how loud the bass is right now (normalised to the room)
//   beat   0..1  a short impulse on each detected beat, decaying
//   motion 0..1  how vigorously the phone is moving
//   pulse  0..1  max of the above, the one number most effects use
//   up     [x,y] physical "up" in screen coordinates (x right, y down)
// It also works out the physical orientation of the phone (0/90/180/270) with
// hysteresis, so the sign can stay upright when rotation lock is on.

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const decay = (v, dt, tau) => v * Math.exp(-dt / tau);
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export class Reactive {
  constructor() {
    this.level = 0; this.beat = 0; this.motion = 0; this.pulse = 0;
    this.up = [0, 0];
    this.micOn = false; this.motionOn = false;
    this.micWanted = false;
    this.onOrientation = null;   // (angleDeg) => void
    this.orientation = null;     // last reported physical orientation, or null
    // mic internals
    this.ctx = null; this.stream = null; this.analyser = null; this.bins = null;
    this.env = 0; this.peak = 40; this.avg = 0; this.lastBeat = 0;
    // motion internals
    this.gEst = null; this.motionEnv = 0; this.candidate = null; this.candSince = 0;
    this._onMotion = (e) => this._motion(e);
    this._now = performance.now();
  }

  // --------------------------------------------------------------- microphone
  get micSupported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && (window.AudioContext || window.webkitAudioContext)); }

  /** Must be called from a user gesture the first time. Resolves true if listening. */
  async startMic() {
    this.micWanted = true;
    if (this.micOn) return true;
    if (!this.micSupported) return false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.35;
      src.connect(analyser);
      this.ctx = ctx; this.stream = stream; this.analyser = analyser;
      this.bins = new Uint8Array(analyser.frequencyBinCount);
      this.env = 0; this.peak = 40; this.avg = 0;
      this.micOn = true;
      for (const t of stream.getAudioTracks()) t.addEventListener('ended', () => { if (this.micOn) this.stopMic(true); });
      return true;
    } catch (e) {
      this.micWanted = false;
      return false;
    }
  }

  stopMic(keepWanted = false) {
    if (!keepWanted) this.micWanted = false;
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null; this.stream = null; this.analyser = null; this.bins = null;
    this.micOn = false; this.level = 0; this.beat = 0;
  }

  /** Pause/resume around visibility changes. */
  suspend() { if (this.micOn) this.stopMic(true); }
  resume() { if (this.micWanted && !this.micOn) this.startMic().catch(() => {}); }

  // ------------------------------------------------------------------ motion
  get motionSupported() { return 'DeviceMotionEvent' in window; }
  get motionNeedsPermission() { return this.motionSupported && typeof DeviceMotionEvent.requestPermission === 'function'; }

  /** Start listening. On iOS this prompts, so call it from a tap when needed. */
  async startMotion() {
    if (this.motionOn) return 'granted';
    if (!this.motionSupported) return 'unavailable';
    try {
      if (this.motionNeedsPermission) {
        const res = await DeviceMotionEvent.requestPermission();
        if (res !== 'granted') return 'denied';
      }
      addEventListener('devicemotion', this._onMotion);
      this.motionOn = true;
      return 'granted';
    } catch (e) { return 'unavailable'; }
  }

  stopMotion() {
    removeEventListener('devicemotion', this._onMotion);
    this.motionOn = false; this.motion = 0; this.up = [0, 0]; this.gEst = null; this.candidate = null;
  }

  _screenAngle() {
    const a = (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle
      : (typeof window.orientation === 'number' ? window.orientation : 0);
    return ((a % 360) + 360) % 360;
  }

  _motion(e) {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x == null || g.y == null) return;
    const inv = isIOS ? -1 : 1;                      // iOS reports the opposite sign
    const ax = g.x * inv, ay = g.y * inv, az = (g.z || 0) * inv;
    const dt = Math.min(0.1, Math.max(0.001, (e.interval || 16) / 1000));
    if (!this.gEst) this.gEst = [ax, ay, az];
    const k = 1 - Math.exp(-dt / 0.25);             // gravity estimate: quick enough to follow a turn, slow enough to ignore a dance move
    const ge = this.gEst;
    ge[0] += (ax - ge[0]) * k; ge[1] += (ay - ge[1]) * k; ge[2] += (az - ge[2]) * k;

    // Movement energy: linear acceleration plus rotation rate.
    const lin = Math.hypot(ax - ge[0], ay - ge[1], az - ge[2]);
    let rot = 0;
    if (e.rotationRate && e.rotationRate.alpha != null) rot = Math.hypot(e.rotationRate.alpha || 0, e.rotationRate.beta || 0, e.rotationRate.gamma || 0);
    const energy = Math.max(clamp01(lin / 9), clamp01(rot / 260));
    this.motionEnv = Math.max(energy, this.motionEnv);

    // Physical up, in device frame, then in screen frame (y up).
    const mag = Math.hypot(ge[0], ge[1], ge[2]) || 1;
    const ux = ge[0] / mag, uy = ge[1] / mag, uz = ge[2] / mag;
    const sa = this._screenAngle();
    let sx, sy;
    if (sa === 90) { sx = -uy; sy = ux; }
    else if (sa === 180) { sx = -ux; sy = -uy; }
    else if (sa === 270) { sx = uy; sy = -ux; }
    else { sx = ux; sy = uy; }
    const flat = Math.abs(uz) > 0.82;              // lying on a table: no useful up
    this.up = flat ? [0, 0] : [sx, -sy];             // convert to screen coords (y down)

    // Orientation with hysteresis: the dominant axis must win clearly and hold.
    if (flat) { this.candidate = null; return; }
    const margin = 0.33;
    let cand = null;
    if (Math.abs(sx) > Math.abs(sy) + margin) cand = sx > 0 ? 90 : 270;
    else if (Math.abs(sy) > Math.abs(sx) + margin) cand = sy > 0 ? 0 : 180;
    if (cand === null) return;
    const now = performance.now();
    if (cand !== this.candidate) { this.candidate = cand; this.candSince = now; return; }
    if (now - this.candSince < 250 || cand === this.orientation) return;
    this.orientation = cand;
    if (this.onOrientation) this.onOrientation(cand);
  }

  // ------------------------------------------------------------------ update
  /** Advance envelopes. Call once per rendered frame. */
  update(dt) {
    dt = Math.min(0.1, Math.max(0, dt));
    if (this.micOn && this.analyser) {
      this.analyser.getByteFrequencyData(this.bins);
      let bass = 0;
      for (let i = 1; i <= 6; i++) bass += this.bins[i];
      bass /= 6;
      this.peak = Math.max(40, bass, decay(this.peak, dt, 4));
      this.env = Math.max(bass, decay(this.env, dt, 0.25));
      this.level = clamp01(this.env / this.peak);
      const avg = this.avg;
      this.avg += (bass - avg) * (1 - Math.exp(-dt / 1.2));
      const t = performance.now();
      if (bass > avg * 1.35 + 10 && bass > 48 && t - this.lastBeat > 240) { this.lastBeat = t; this.beat = 1; }
      else this.beat = decay(this.beat, dt, 0.18);
    } else {
      this.level = decay(this.level, dt, 0.3);
      this.beat = decay(this.beat, dt, 0.18);
    }
    this.motionEnv = decay(this.motionEnv, dt, 0.35);
    this.motion = clamp01(this.motionEnv);
    this.pulse = Math.max(this.level, this.motion * 0.75);
    return this;
  }
}
