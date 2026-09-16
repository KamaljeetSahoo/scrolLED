// videofs.js — true full screen on iPhone.
//
// Safari on iPhone refuses Element.requestFullscreen, so a web page can never
// hide the browser's bars. It does, however, let a <video> go full screen, which
// is why a playing video fills the whole phone with no chrome. So we feed the
// LED canvas into a hidden <video> with canvas.captureStream() and put that
// video into the native player. The sign keeps rendering and reacting to the
// music; iOS just shows it edge to edge.
//
// Two rules the native API imposes, and why the code is shaped this way:
//   1. webkitEnterFullscreen() must be called inside a user gesture, with no
//      await in front of it, so everything slow happens in prewarm() instead.
//   2. The video needs real dimensions first, so prewarm() waits for metadata.
// And one WebKit bug to respect: 181663, where a video fed by captureStream on
// iOS plays happily but never renders a frame. Feature detection returns true on
// exactly those devices, so prewarm() waits for proof that a frame arrived and
// reports itself unusable otherwise, leaving the caller to offer installing.

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export class VideoFullscreen {
  /** @param {HTMLCanvasElement} canvas the canvas whose pixels should go full screen */
  constructor(canvas) {
    this.canvas = canvas;
    this.video = null;
    this.stream = null;
    this.active = false;
    this.onChange = null;   // (active: boolean) => void
    this.warming = null;
    this.mirror = null;
    this.mirrorCtx = null;
    this.ready = false;   // a real frame has been seen coming out of the stream
    this.pump = 0;
    this._setActive = null;
  }

  /** True when this device can show a video full screen but not an element. */
  get supported() {
    if (!isIOS) return false;
    if (typeof this.canvas.captureStream !== 'function') return false;
    const v = document.createElement('video');
    return typeof v.webkitEnterFullscreen === 'function' || typeof v.webkitSetPresentationMode === 'function';
  }

  /**
   * Build the video and get it playing, so that enter() can be a single
   * synchronous call inside the user's tap. Safe to call repeatedly.
   */
  prewarm() {
    if (this.warming) return this.warming;
    if (!this.supported) return Promise.resolve(false);
    this.warming = (async () => {
      const v = document.createElement('video');
      // Muted + inline, or iOS refuses to autoplay it at all.
      v.muted = true; v.defaultMuted = true; v.volume = 0;
      v.playsInline = true; v.autoplay = true; v.controls = false; v.loop = true;
      v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
      v.setAttribute('aria-hidden', 'true');
      // It must be in the document and renderable; display:none would disqualify it.
      v.style.cssText = 'position:fixed;width:1px;height:1px;left:0;bottom:0;opacity:0.01;pointer-events:none;z-index:-1';
      document.body.appendChild(v);
      const setActive = (on) => {
        if (on === this.active) return;
        this.active = on;
        // If the page's frame loop is throttled behind the native player the
        // sign would freeze, so keep pushing frames on a timer as well.
        clearInterval(this.pump);
        this.pump = on ? setInterval(() => this.grabFrame(), 50) : 0;
        if (this.onChange) this.onChange(on);
      };
      this._setActive = setActive;
      v.addEventListener('webkitbeginfullscreen', () => setActive(true));
      v.addEventListener('webkitendfullscreen', () => setActive(false));
      v.addEventListener('webkitpresentationmodechanged', () => setActive(v.webkitPresentationMode === 'fullscreen'));
      // Capture from a mirror canvas rather than the WebGL one. A WebGL canvas
      // without preserveDrawingBuffer can hand back black frames, and turning
      // that on would cost every iPhone user frame rate for a feature most
      // never open. grabFrame() copies the live frame instead, at no cost
      // while this is idle.
      const mirror = document.createElement('canvas');
      this.mirror = mirror;
      this.mirrorCtx = mirror.getContext('2d', { alpha: false });
      this._sizeMirror();
      let stream;
      try { stream = mirror.captureStream(30); } catch (e) { v.remove(); this.warming = null; return false; }
      v.srcObject = stream;
      this.video = v; this.stream = stream;
      try { await v.play(); } catch (e) { /* it may still be playable full screen */ }
      if (v.readyState < 1) {
        await new Promise((done) => {
          const t = setTimeout(done, 2000);
          v.addEventListener('loadedmetadata', () => { clearTimeout(t); done(); }, { once: true });
        });
      }
      this.ready = await this._awaitFrame(v);
      return this.ready;
    })();
    return this.warming;
  }

  /** Resolve true only once the video has actually presented a frame. */
  _awaitFrame(v) {
    return new Promise((done) => {
      let settled = false;
      const finish = (ok) => { if (settled) return; settled = true; clearInterval(poll); clearTimeout(cap); done(ok); };
      const cap = setTimeout(() => finish(false), 3000);
      // The precise signal, where Safari offers it.
      if (typeof v.requestVideoFrameCallback === 'function') {
        try { v.requestVideoFrameCallback(() => finish(true)); } catch (e) { /* fall back to polling */ }
      }
      // Otherwise: real dimensions plus a clock that is actually advancing.
      const poll = setInterval(() => { if (v.videoWidth > 0 && v.currentTime > 0 && v.readyState >= 2) finish(true); }, 100);
    });
  }

  _sizeMirror() {
    // Cap the stream so encoding stays cheap on a phone, keeping the aspect.
    const src = this.canvas;
    const w = src.width || 2, h = src.height || 2;
    const scale = Math.min(1, 1280 / Math.max(w, h));
    const mw = Math.max(2, Math.round(w * scale)), mh = Math.max(2, Math.round(h * scale));
    if (this.mirror.width !== mw || this.mirror.height !== mh) { this.mirror.width = mw; this.mirror.height = mh; }
  }

  /**
   * Copy the current frame into the stream. Must be called straight after the
   * renderer draws, while the WebGL drawing buffer still holds the frame.
   * Cheap no-op unless the video path is in use.
   */
  grabFrame() {
    if (!this.mirrorCtx || !this.video) return;
    this._sizeMirror();
    try { this.mirrorCtx.drawImage(this.canvas, 0, 0, this.mirror.width, this.mirror.height); } catch (e) { /* ignore */ }
  }

  /** Enter the native player. MUST be called directly from a user gesture. */
  enter() {
    const v = this.video;
    if (!v || this.active || !this.ready) return false;
    try { if (v.paused) v.play().catch(() => {}); } catch (e) { /* ignore */ }
    try {
      if (typeof v.webkitEnterFullscreen === 'function') { v.webkitEnterFullscreen(); return true; }
      if (typeof v.webkitSetPresentationMode === 'function') { v.webkitSetPresentationMode('fullscreen'); return true; }
    } catch (e) { /* fall through */ }
    return false;
  }

  exit() {
    const v = this.video;
    if (!v || !this.active) return;
    try {
      if (typeof v.webkitExitFullscreen === 'function') v.webkitExitFullscreen();
      else if (typeof v.webkitSetPresentationMode === 'function') v.webkitSetPresentationMode('inline');
    } catch (e) { /* ignore */ }
  }

  /** Release the camera-less capture pipeline when the show is over. */
  teardown() {
    this.exit();
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    if (this.video) { this.video.srcObject = null; this.video.remove(); }
    clearInterval(this.pump); this.pump = 0;
    this.video = null; this.stream = null; this.active = false; this.warming = null;
    this.mirror = null; this.mirrorCtx = null; this.ready = false;
  }
}
