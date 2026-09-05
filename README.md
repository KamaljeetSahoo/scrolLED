# scrolLED

**LED scroller for calling your friends out.** Type a message, pick a font and a colour, hit **Present**, hold your phone up. scrolLED turns the screen into a scrolling LED sign that looks like the real thing: hot-centred dots, glow that bleeds onto the neighbours, a faint bezel of unlit LEDs, and motion that is smooth to the sub-pixel.

It is a static PWA with no build step and no dependencies. Open it once and it works offline; add it to your home screen and it launches full screen.

## Features

- **Fonts**: an authentic 5×8 dot-matrix bitmap font (plus a bold cut) and six display fonts (Anton, Bungee, Orbitron, Abril Fatface, Pacifico, system sans) rasterized through the same LED pipeline. Emoji work too.
- **Colour**: eight LED colours, white, and rainbow. The whole UI re-tints to the colour you pick.
- **Speed**, **dot size** (four steps), **direction**, round or square LEDs, **Smooth** or classic **Stepped** motion, **Afterglow** phosphor trails, and three glow levels.
- **Present mode**: the UI disappears, the screen stays awake, and the sign fills the display. Hold the phone sideways and the sign rotates to match, even with rotation lock on (gravity sensing). Tap for a small overlay with exit, pause and rotate. The back button exits.
- **Grab the strip**: drag the text with your finger and throw it. It eases back to cruise speed.
- **Short messages dwell**: text that fits slides in, holds centred for a moment, and slides out. Long messages loop.
- **Beat** (opt-in, uses the microphone): the LEDs swell, the glow blooms and the colours punch on every bass hit. Turn it on with the Beat chip or the mic button in Present mode.
- **Motion**: tilt the phone and the highlight on each LED dome shifts like a real glossy LED catching the light; dance with it and the sign pulses with your movement.
- **Boot sequence**: the sign powers on with a self-test sweep, sparkles in the wordmark, runs an RGB colour test, and hands over to your message. Tap to fast-forward.
- **Share**: the URL hash carries the message and settings, so a link reproduces your sign. Where file sharing is supported, Share also attaches a rendered PNG card of the sign. Installed on Android, scrolLED appears in the system share sheet as a target too.
- **Installable PWA** with offline support and a light-touch "new version ready" prompt.

## How it renders

The message is drawn once at high resolution, then reduced to per-row prefix sums. Each frame, every LED asks "how much ink sits under my window right now?" and gets an exact box-filtered answer for any fractional scroll offset. That is what makes Smooth mode look like motion instead of flicker. A WebGL fragment shader draws the dots in linear light (sqrt-encoded texture, tone map, gamma, dither) with a 3×3 halo and a wide bloom; a Canvas2D sprite path is the fallback.

```
js/raster.js   message -> Strip (prefix sums), fonts
js/engine.js   frame loop, motion (dwell, stepping, grab/fling), WebGL + Canvas2D renderers
js/boot.js     power-on self-test choreography
js/reactive.js microphone (bass, beats) and motion (energy, tilt, orientation) senses
js/app.js      UI, state, present mode, gestures, PWA plumbing
js/font5x8.js  bitmap font (generated from tools/glyphs.json)
```

## Run it locally

Any static server works. For example:

```
npx serve .
```

Then open the printed URL. Service workers need `localhost` or HTTPS.

## Deploy to GitHub Pages

The repo ships a workflow at `.github/workflows/pages.yml` that deploys on every push to `master`.

1. In the repository go to **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Push to `master` (or run the workflow manually from the Actions tab).

The site then lives at `https://<user>.github.io/scrolLED/`. All paths are relative, so it also works from a custom domain or the repo root.

## Development tools

```
npm run check     # syntax + precache list sanity
npm run icons     # regenerate PNG icons (needs playwright)
npm run font      # rebuild js/font5x8.js from tools/glyphs.json
node tools/make-screenshots.mjs http://localhost:8080/   # manifest screenshots + OG image
```

When you change any file listed in `sw.js`, bump `VERSION` there so installed apps pick up the update.

## Licence

Code is MIT (see `LICENSE`). Bundled fonts are under the SIL Open Font License; see `fonts/OFL-*.txt`.
