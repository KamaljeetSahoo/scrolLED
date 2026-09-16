#!/usr/bin/env node
// Drive the real Reactive class with synthetic audio and print what it hears.
//
// The sign is meant for a loud party, and a loud party is the one place a
// loudness-based meter has nothing left to say: everything is loud all the time.
// This feeds js/reactive.js a made-up spectrum for a few rooms and reports the
// signals it produces, so "the mic response is not noticeable" can be traced to
// the ear or the eye rather than argued about.
//
// What to look for:
//   swing   how far level travels between the quiet part of a bar and a kick.
//           Near zero means the sign has nothing to react to, however good the
//           renderer is.
//   beats   kicks actually detected, against the number played.
//
// Usage: node tools/ear-test.mjs
import { Reactive } from '../js/reactive.js';

const BINS = 512;                 // analyser.frequencyBinCount at fftSize 1024
const FPS = 60, DT = 1 / FPS;
const KICK_EVERY = 0.5;           // 120bpm four-to-the-floor
const SECONDS = 12;

// A room is described by its steady music bed and how far a kick rises above it.
const ROOMS = [
  { name: 'bedroom, quiet',   bed: 18,  kick: 200, hats: 10 },
  { name: 'party, lively',    bed: 90,  kick: 225, hats: 45 },
  { name: 'club, loud',       bed: 165, kick: 245, hats: 80 },
  { name: 'club, compressed', bed: 200, kick: 250, hats: 120 },  // the hard case: almost no headroom
  { name: 'silence',          bed: 0,   kick: 0,   hats: 0 },
];

/** Byte spectrum for one frame: bass bed + a decaying kick + some upper content. */
function spectrum(room, t) {
  const since = t % KICK_EVERY;
  const env = room.kick ? Math.exp(-since / 0.08) : 0;          // kick transient, ~80ms
  const out = new Uint8Array(BINS);
  for (let i = 0; i < BINS; i++) {
    let v;
    if (i <= 6) v = room.bed + (room.kick - room.bed) * env;     // bass: bed, punched by the kick
    else if (i <= 40) v = room.bed * 0.7 + (room.kick - room.bed) * env * 0.35;
    else v = room.hats * (0.6 + 0.4 * Math.sin(t * 40 + i));     // hats / vocals / noise
    out[i] = Math.max(0, Math.min(255, Math.round(v)));
  }
  return out;
}

function run(room) {
  const r = new Reactive();
  // Stand in for the Web Audio analyser: same interface, our spectrum.
  let t = 0;
  r.micOn = true;
  r.bins = new Uint8Array(BINS);
  r.analyser = { frequencyBinCount: BINS, getByteFrequencyData: (into) => into.set(spectrum(room, t)) };

  // The beat refractory is wall-clock based, so give the simulation its own clock.
  const realNow = performance.now.bind(performance);
  performance.now = () => t * 1000;

  const levels = [], beats = [];
  let fired = 0, lastBeatVal = 0;
  const settle = 2;                                   // let the envelopes adapt to the room first
  for (let n = 0; n < SECONDS * FPS; n++) {
    t = n * DT;
    r.update(DT);
    if (t < settle) continue;
    levels.push(r.level);
    beats.push(r.beat);
    if (r.beat > 0.9 && lastBeatVal <= 0.9) fired++;
    lastBeatVal = r.beat;
  }
  performance.now = realNow;

  const lo = Math.min(...levels), hi = Math.max(...levels);
  const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
  const played = Math.floor((SECONDS - settle) / KICK_EVERY);
  return { lo, hi, mean, swing: hi - lo, fired, played, peakBeat: Math.max(...beats) };
}

console.log(`\nwhat the sign hears  (${SECONDS}s per room, a kick every ${KICK_EVERY}s)\n`);
console.log('  room                 level min   level max   swing   mean    kicks found');
let worst = 1;
for (const room of ROOMS) {
  const s = run(room);
  if (room.kick) worst = Math.min(worst, s.swing);
  const flag = room.kick && s.swing < 0.15 ? '  <-- nothing to see' : '';
  console.log(`  ${room.name.padEnd(20)} ${s.lo.toFixed(3).padStart(9)} ${s.hi.toFixed(3).padStart(11)} ${s.swing.toFixed(3).padStart(7)} ${s.mean.toFixed(3).padStart(7)} ${(s.fired + '/' + s.played).padStart(13)}${flag}`);
}
console.log(`\n  worst swing across the rooms with music playing: ${worst.toFixed(3)}`);
console.log('  the sign can only pulse as much as this number lets it.\n');

// Gates, so a change that quietly deafens the sign fails instead of just reading oddly.
let bad = 0;
const gate = (name, ok, detail) => { console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + detail : ''}`); if (!ok) bad++; };
const music = ROOMS.filter((r) => r.kick).map((r) => ({ room: r, s: run(r) }));
gate('every room keeps real dynamic range', music.every((m) => m.s.swing > 0.5),
  music.map((m) => `${m.room.name}=${m.s.swing.toFixed(2)}`).join(' '));
gate('kicks are found in every room', music.every((m) => m.s.fired >= m.s.played * 0.9),
  music.map((m) => `${m.room.name}=${m.s.fired}/${m.s.played}`).join(' '));
const quiet = run(ROOMS.find((r) => !r.kick));
gate('silence stays dark', quiet.fired === 0 && quiet.hi === 0, `beats=${quiet.fired} peak=${quiet.hi}`);
console.log(bad ? `\n${bad} check(s) failed\n` : '\nall checks passed\n');
process.exit(bad ? 1 : 0);
