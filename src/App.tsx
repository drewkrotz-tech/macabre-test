import { forwardRef, useEffect, useRef, useState } from 'react';
import {
  startGeofencing,
  stopGeofencing,
  requestPermissions,
  distanceMeters,
  setSites,
  getDebugLog,
} from './geofencing';
import { SINISTER_SITES as FALLBACK_SITES, SinisterSite } from './locations';

// ---------- Production server URL ----------
const API_BASE = 'https://api.sinistertrivia.com';

// ---------- Live site fetch ----------
// The server's /sites endpoint returns approved locales. Each site has the
// shape { id, title, shortDescription, fullDescription, category, state,
// coords:{lat,lng}, photoUrl, submitter, verified, approvedAt }.
//
// The app's SinisterSite type uses `imageUrl`, so we map photoUrl -> imageUrl
// here. We also fill imageCredit with the submitter handle for attribution.
async function fetchLiveSites(): Promise<SinisterSite[]> {
  try {
    const res = await fetch(`${API_BASE}/sites`, {
      method: 'GET',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.sites)) return [];
    return data.sites.map((s: any): SinisterSite => ({
      id: s.id,
      title: s.title,
      shortDescription: s.shortDescription,
      fullDescription: s.fullDescription,
      category: s.category,
      state: s.state || 'Unknown',
      coords: s.coords,
      imageUrl: s.photoUrl || s.imageUrl || '',
      imageCredit: s.submitter ? `@${s.submitter}` : 'Sinister Locations',
    }));
  } catch (err) {
    console.warn('[app] Failed to fetch live sites; using bundled fallback.', err);
    return [];
  }
}

// ---------- External links ----------
const INSTAGRAM_URL = 'https://www.instagram.com/sinisterdrew/';
const YOUTUBE_URL   = 'https://www.youtube.com/@sinistervids71';

// ---------- Colors ----------
const BLUE = '#3FA9FF';
const WHITE = '#FFFFFF';
const SUBMIT_RED = '#FF3B3B';
const FIRE_CORE = '#FFB347';
const FIRE_BRIGHT = '#FF6B1A';
const FIRE_DEEP = '#D43A0A';
const SINISTER_RED = '#C12B2B';

// ---------- Sound playback (Web Audio synthesis) ----------
// We synthesize sounds in the browser instead of bundling mp3 files. Two cues:
//   forward (open menu): a low wooden thud / creak — short downward pitch
//                        sweep with bandpass filter for a cracked-wood feel
//   back    (run home):  a chain-rattle whoosh — filtered white noise burst
//                        with a quick decay envelope
// AudioContext is lazy-created on first use (browsers block AudioContext
// until a user gesture) and reused across plays to avoid setup stutter.
let _audioCtx: AudioContext | null = null;
function getAudioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!_audioCtx) {
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    _audioCtx = new Ctor();
  }
  if (_audioCtx.state === 'suspended') {
    _audioCtx.resume().catch(() => {});
  }
  return _audioCtx;
}

function playForward() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    // Soft "tick" — a short triangle wave around 880 Hz with a fast attack
    // and ~60ms decay. Quiet and unobtrusive, like a UI blip.
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(880, now);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.09);
  } catch { /* silent */ }
}

function playBack() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    // Soft "pop" — a sine wave that sweeps downward from 600 Hz to 300 Hz
    // over ~80 ms. Reads as a "step back" / "close" cue without being harsh.
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, now);
    osc.frequency.exponentialRampToValueAtTime(300, now + 0.08);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.22, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.14);
  } catch { /* silent */ }
}

// Single slide audio instance — Web Audio API implementation.
// HTMLAudioElement.volume is IGNORED on iOS WebView, which is why the
// slide sound was deafening on iPhone despite volume=0.105. Web Audio's
// GainNode honors volume on iOS. Pre-decoded AudioBuffer also gives
// instant playback (no decode-on-play delay) and reliable firing on
// every scroll — the previous symptom of "delayed and inconsistent" is
// HTMLAudio's mid-decode play() calls being dropped.
//
// Falls back to HTMLAudioElement if Web Audio fails to init (older
// browsers, very locked-down WebViews).
const SLIDE_VOLUME = 0.05;
let _slideAudioCtx: AudioContext | null = null;
let _slideAudioBuffer: AudioBuffer | null = null;
let _slideAudioGain: GainNode | null = null;
let _slideAudioInitStarted = false;
let _slideAudio: HTMLAudioElement | null = null; // fallback only
function ensureSlideAudio() {
  if (_slideAudioInitStarted) return;
  _slideAudioInitStarted = true;
  // Try Web Audio path first.
  try {
    const Ctx: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (Ctx) {
      _slideAudioCtx = new Ctx();
      _slideAudioGain = _slideAudioCtx.createGain();
      _slideAudioGain.gain.value = SLIDE_VOLUME;
      _slideAudioGain.connect(_slideAudioCtx.destination);
      // Fetch + decode the asset URL into a buffer for instant playback.
      fetch(slideSound1)
        .then(r => r.arrayBuffer())
        .then(ab => _slideAudioCtx!.decodeAudioData(ab))
        .then(buf => { _slideAudioBuffer = buf; })
        .catch(() => { /* silent — fallback below covers it */ });
    }
  } catch { /* silent */ }
  // HTMLAudio fallback (only used if Web Audio path fails).
  try {
    _slideAudio = new Audio(slideSound1);
    _slideAudio.preload = 'auto';
    _slideAudio.volume = SLIDE_VOLUME;
  } catch { /* silent */ }
}
// Tracks whether we've played the priming silent buffer through the slide
// audio chain. iOS's first start(0) after AudioContext resume can ignore
// the GainNode for one frame (loud first scroll). The first call to
// playSlide primes the audio path with a silent buffer and skips actually
// playing the real sound — by the second scroll, iOS has established the
// gain stage and the real sound plays at the correct volume.
let _slidePrimed = false;
function playSlide() {
  try {
    ensureSlideAudio();
    if (!_slideAudioCtx || !_slideAudioBuffer || !_slideAudioGain) {
      return;
    }
    if (_slideAudioCtx.state === 'suspended') {
      _slideAudioCtx.resume().catch(() => { /* silent */ });
    }
    const src = _slideAudioCtx.createBufferSource();
    src.buffer = _slideAudioBuffer;
    src.connect(_slideAudioGain);
    src.start(0);
  } catch { /* silent */ }
}

// Single button click audio instance — Web Audio API for instant, reliable
// firing on iOS. Same pattern as the slide sound. HTMLAudio fallback kept
// for older WebViews. Volume at 0.20 honored by GainNode.
const BUTTON_VOLUME = 0.20;
let _buttonAudioCtx: AudioContext | null = null;
let _buttonAudioBuffer: AudioBuffer | null = null;
let _buttonAudioGain: GainNode | null = null;
let _buttonAudioInitStarted = false;
let _buttonAudio: HTMLAudioElement | null = null; // fallback only
function ensureButtonAudio() {
  if (_buttonAudioInitStarted) return;
  _buttonAudioInitStarted = true;
  try {
    const Ctx: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (Ctx) {
      _buttonAudioCtx = new Ctx();
      _buttonAudioGain = _buttonAudioCtx.createGain();
      _buttonAudioGain.gain.value = BUTTON_VOLUME;
      _buttonAudioGain.connect(_buttonAudioCtx.destination);
      fetch(buttonSound)
        .then(r => r.arrayBuffer())
        .then(ab => _buttonAudioCtx!.decodeAudioData(ab))
        .then(buf => { _buttonAudioBuffer = buf; })
        .catch(() => { /* silent */ });
    }
  } catch { /* silent */ }
  try {
    _buttonAudio = new Audio(buttonSound);
    _buttonAudio.preload = 'auto';
    _buttonAudio.volume = BUTTON_VOLUME;
  } catch { /* silent */ }
}
function playButton() {
  try {
    ensureButtonAudio();
    if (_buttonAudioCtx && _buttonAudioBuffer && _buttonAudioGain) {
      if (_buttonAudioCtx.state === 'suspended') {
        _buttonAudioCtx.resume().catch(() => { /* silent */ });
      }
      const src = _buttonAudioCtx.createBufferSource();
      src.buffer = _buttonAudioBuffer;
      src.connect(_buttonAudioGain);
      src.start(0);
      return;
    }
    if (_buttonAudio) {
      _buttonAudio.currentTime = 0;
      void _buttonAudio.play();
    }
  } catch { /* silent */ }
}

// Single back navigation audio instance — Web Audio API for instant, reliable
// firing on iOS. Same pattern as button/slide. HTMLAudio fallback kept.
const BACK_VOLUME = 0.20;
let _backAudioCtx: AudioContext | null = null;
let _backAudioBuffer: AudioBuffer | null = null;
let _backAudioGain: GainNode | null = null;
let _backAudioInitStarted = false;
let _backAudio: HTMLAudioElement | null = null; // fallback only
function ensureBackAudio() {
  if (_backAudioInitStarted) return;
  _backAudioInitStarted = true;
  try {
    const Ctx: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (Ctx) {
      _backAudioCtx = new Ctx();
      _backAudioGain = _backAudioCtx.createGain();
      _backAudioGain.gain.value = BACK_VOLUME;
      _backAudioGain.connect(_backAudioCtx.destination);
      fetch(backSound)
        .then(r => r.arrayBuffer())
        .then(ab => _backAudioCtx!.decodeAudioData(ab))
        .then(buf => { _backAudioBuffer = buf; })
        .catch(() => { /* silent */ });
    }
  } catch { /* silent */ }
  try {
    _backAudio = new Audio(backSound);
    _backAudio.preload = 'auto';
    _backAudio.volume = BACK_VOLUME;
  } catch { /* silent */ }
}
function playBackSound() {
  try {
    ensureBackAudio();
    if (_backAudioCtx && _backAudioBuffer && _backAudioGain) {
      if (_backAudioCtx.state === 'suspended') {
        _backAudioCtx.resume().catch(() => { /* silent */ });
      }
      const src = _backAudioCtx.createBufferSource();
      src.buffer = _backAudioBuffer;
      src.connect(_backAudioGain);
      src.start(0);
      return;
    }
    if (_backAudio) {
      _backAudio.currentTime = 0;
      void _backAudio.play();
    }
  } catch { /* silent */ }
}

// Single bell audio instance — Web Audio API for instant, reliable firing
// on iOS. Same pattern as button/back/slide. HTMLAudio fallback kept.
const BELL_VOLUME = 0.30;
let _bellAudioCtx: AudioContext | null = null;
let _bellAudioBuffer: AudioBuffer | null = null;
let _bellAudioGain: GainNode | null = null;
let _bellAudioInitStarted = false;
let _bellAudio: HTMLAudioElement | null = null; // fallback only
function ensureBellAudio() {
  if (_bellAudioInitStarted) return;
  _bellAudioInitStarted = true;
  try {
    const Ctx: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (Ctx) {
      _bellAudioCtx = new Ctx();
      _bellAudioGain = _bellAudioCtx.createGain();
      _bellAudioGain.gain.value = BELL_VOLUME;
      _bellAudioGain.connect(_bellAudioCtx.destination);
      fetch(bellSound)
        .then(r => r.arrayBuffer())
        .then(ab => _bellAudioCtx!.decodeAudioData(ab))
        .then(buf => { _bellAudioBuffer = buf; })
        .catch(() => { /* silent */ });
    }
  } catch { /* silent */ }
  try {
    _bellAudio = new Audio(bellSound);
    _bellAudio.preload = 'auto';
    _bellAudio.volume = BELL_VOLUME;
  } catch { /* silent */ }
}
function playBell() {
  try {
    ensureBellAudio();
    if (_bellAudioCtx && _bellAudioBuffer && _bellAudioGain) {
      if (_bellAudioCtx.state === 'suspended') {
        _bellAudioCtx.resume().catch(() => { /* silent */ });
      }
      const src = _bellAudioCtx.createBufferSource();
      src.buffer = _bellAudioBuffer;
      src.connect(_bellAudioGain);
      src.start(0);
      return;
    }
    if (_bellAudio) {
      _bellAudio.currentTime = 0;
      void _bellAudio.play();
    }
  } catch { /* silent */ }
}

// ---------- Categories ----------
// Tile border colors: red is the new default for "blue" categories, since
// blue against the fire effect was hard to read. Hauntings and Cults remain
// white to break up the visual rhythm in the 2-col grid.
const TILE_RED = '#FF3B3B';

// Cell background images (35mm filmstrip frames on home). Each category
// has a representative image. Submit a Locale uses the seventh image.
import cellCrime      from './assets/cell-crime.jpg';
import cellHaunting   from './assets/cell-haunting.jpg';
import cellCult       from './assets/cell-cult.jpg';
import cellKiller     from './assets/cell-killer.jpg';
import cellFilm       from './assets/cell-film.jpg';
import cellHistorical from './assets/cell-historical.jpg';
import cellSubmit     from './assets/cell-submit.jpg';

// Slide sound effect — a single short sound that plays on every cell
// advance. Using one sound instead of rotating through three avoids
// overlap problems on fast scrolls (we just stop and restart the same
// instance, guaranteed to never overlap with itself).
import slideSound1 from './assets/slide1.mp3';

// Button click sound — plays on every navigation tap (cells, submit,
// social bar, back buttons). Single Audio instance, volume kept low.
import buttonSound from './assets/button.mp3';

// Back navigation sound — plays on Run Home / Back button taps. Distinct
// from the forward button click so back navigation has its own audio cue.
import backSound from './assets/back.mp3';

// Bell sound — plays when the user submits a new location (the form's
// Submit button). A celebratory cue distinct from the regular click.
import bellSound from './assets/bell.mp3';

type CategoryKey = 'crime' | 'film' | 'haunting' | 'cult' | 'killer' | 'historical';
const CATEGORIES: { key: CategoryKey; label: string; gridIndex: number; cascadeOrder: number; borderColor: string; image: string }[] = [
  { key: 'crime',      label: 'True Crime',     gridIndex: 0, cascadeOrder: 0, borderColor: TILE_RED, image: cellCrime      },
  { key: 'film',       label: 'Film Locations', gridIndex: 1, cascadeOrder: 5, borderColor: TILE_RED, image: cellFilm       },
  { key: 'haunting',   label: 'Hauntings',      gridIndex: 2, cascadeOrder: 1, borderColor: WHITE,    image: cellHaunting   },
  { key: 'cult',       label: 'Cults',          gridIndex: 3, cascadeOrder: 4, borderColor: WHITE,    image: cellCult       },
  { key: 'killer',     label: 'Serial Killers', gridIndex: 4, cascadeOrder: 2, borderColor: TILE_RED, image: cellKiller     },
  { key: 'historical', label: 'Historical',     gridIndex: 5, cascadeOrder: 3, borderColor: TILE_RED, image: cellHistorical },
];

const CATEGORY_COLOR: Record<CategoryKey, string> = {
  crime:      '#FF3B3B',
  film:       '#FF9D2E',
  haunting:   '#3FA9FF',
  cult:       '#34D058',
  killer:     '#A45CFF',
  historical: '#FFD93B',
};

// ---------- Cascade timing ----------
const RAMP_SEC = 0.5;
const N = 6;
const ACTIVE_SEC = RAMP_SEC * (N + 1);
const PAUSE_SEC = 2.0;
const TOTAL_SEC = ACTIVE_SEC + PAUSE_SEC;
function pct(seconds: number) { return (seconds / TOTAL_SEC) * 100; }

// ---------- Embers ----------
const EMBERS: { left: number; size: number; duration: number; delay: number; sway: number }[] = [
  { left: 4,  size: 4, duration: 6.5, delay: 0,    sway: 18 },
  { left: 12, size: 3, duration: 8.0, delay: 1.2,  sway: -22 },
  { left: 19, size: 5, duration: 5.5, delay: 2.5,  sway: 14 },
  { left: 27, size: 2, duration: 7.5, delay: 0.8,  sway: -16 },
  { left: 34, size: 4, duration: 6.0, delay: 3.0,  sway: 20 },
  { left: 42, size: 3, duration: 8.5, delay: 1.8,  sway: -12 },
  { left: 49, size: 5, duration: 5.8, delay: 4.0,  sway: 22 },
  { left: 56, size: 2, duration: 7.0, delay: 0.4,  sway: -18 },
  { left: 63, size: 4, duration: 6.8, delay: 2.2,  sway: 16 },
  { left: 71, size: 3, duration: 7.8, delay: 3.6,  sway: -20 },
  { left: 78, size: 5, duration: 5.6, delay: 1.4,  sway: 14 },
  { left: 85, size: 2, duration: 8.2, delay: 2.8,  sway: -22 },
  { left: 91, size: 4, duration: 6.4, delay: 0.6,  sway: 18 },
  { left: 96, size: 3, duration: 7.2, delay: 4.2,  sway: -14 },
];

// ---------- Inject keyframes ----------
// Fire pulse intensity HALVED:
//   - Scale swing: 1.0 -> 1.18 (was 1.35)
//   - Opacity swing: 0.85 -> 0.95 (was 0.9 -> 1.0)
//   - Brightness swing: 1.0 -> 1.18 (was 1.35)
//   - Flicker opacity range tightened 0.78-0.92 (was 0.7-1.0)
function buildStyleCss() {
  let css = `@import url('https://fonts.bunny.net/css?family=jolly-lodger:400');\n`;

  CATEGORIES.forEach((cat) => {
    const T = cat.cascadeOrder;
    const startPct = pct(T * RAMP_SEC);
    const peakPct  = pct((T + 1) * RAMP_SEC);
    const endPct   = pct((T + 2) * RAMP_SEC);
    const c = cat.borderColor;
    const dim    = `0 0 0 transparent`;
    const bright = `0 0 32px ${c}ee, 0 0 60px ${c}aa, 0 0 90px ${c}66, inset 0 0 22px ${c}77`;
    css += `
@keyframes sinister-pulse-${cat.key} {
  0%, ${startPct}%  { box-shadow: ${dim}; }
  ${peakPct}%       { box-shadow: ${bright}; }
  ${endPct}%, 100%  { box-shadow: ${dim}; }
}
`;
  });

  css += `
@keyframes sinister-fire-pulse {
  0%, 100% {
    transform: scaleY(1);
    opacity: 0.85;
    filter: blur(2px) brightness(1);
  }
  50% {
    transform: scaleY(1.18);
    opacity: 0.95;
    filter: blur(2.5px) brightness(1.18);
  }
}
@keyframes sinister-fire-flicker {
  0%, 100% { opacity: 0.78; }
  25%      { opacity: 0.92; }
  55%      { opacity: 0.84; }
  80%      { opacity: 0.92; }
}
@keyframes sinister-ember {
  0%   { transform: translate(0, 0) scale(0.6); opacity: 0; }
  10%  { opacity: 1; }
  60%  { transform: translate(calc(var(--sway) * 0.6), -55vh) scale(1); opacity: 0.85; }
  100% { transform: translate(var(--sway), -100vh) scale(0.4); opacity: 0; }
}

/* Tile / button press feedback — applied via .sinister-pressable class.
   On tap, the element scales down slightly and brightens, giving a
   tangible "pushed" feel. Combined with the inline transition timing on
   the style object, this happens fast enough to feel responsive. */
.sinister-pressable:active {
  transform: scale(0.96);
  filter: brightness(1.4);
}

/* Slow size-pulse on filmstrip cell titles — grows from 1x to ~1.08x and
   back over 3.5s. Subtle, just enough to feel "alive" without being a
   distraction. Each cell uses the same animation so they all pulse in
   sync; if we want them staggered later, add per-cell delay. */
@keyframes sinister-cell-title-pulse {
  0%, 100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.08);
  }
}

/* ---------- Title glitch effect ----------
   The .sinister-glitch class produces a broken-signal / VHS glitch look
   on its text content. The element's data-text attribute is duplicated
   into two pseudo-elements that overlay the original text in red and
   cyan with horizontal slice clipping, mimicking chromatic aberration
   that strobes randomly. The main text occasionally jitters in position.

   Long quiet stretches between glitch bursts (most of the keyframe
   timeline = no offset) so it reads as "occasional malfunction" rather
   than constantly broken. Tweak by changing the offset/clip values. */
.sinister-glitch {
  position: relative;
  display: inline-block;
}
.sinister-glitch::before,
.sinister-glitch::after {
  content: attr(data-text);
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  pointer-events: none;
}
.sinister-glitch::before {
  /* Red channel — offset right, clip-pathed to thin horizontal slices */
  color: #ff2a4a;
  text-shadow: none;
  animation: sinister-glitch-red 4.2s infinite steps(1);
  z-index: 2;
  mix-blend-mode: screen;
}
.sinister-glitch::after {
  /* Cyan channel — offset left, different clip rhythm */
  color: #00f7ff;
  text-shadow: none;
  animation: sinister-glitch-cyan 4.2s infinite steps(1);
  z-index: 1;
  mix-blend-mode: screen;
}
@keyframes sinister-glitch-red {
  0%, 100% { transform: translate(0, 0); clip-path: inset(0 0 0 0); opacity: 0; }
  /* Burst cluster around 4-7% — a quick triple flash */
  3%  { transform: translate(6px, 0);  clip-path: inset(15% 0 65% 0); opacity: 0.95; }
  4%  { transform: translate(-5px, 1px); clip-path: inset(70% 0 5% 0); opacity: 0.95; }
  5%  { transform: translate(7px, -1px); clip-path: inset(35% 0 35% 0); opacity: 0.95; }
  6%  { transform: translate(-4px, 2px); clip-path: inset(5% 0 80% 0); opacity: 0.95; }
  7%  { transform: translate(0, 0); clip-path: inset(0 0 0 0); opacity: 0; }
  /* Quiet stretch */
  37% { transform: translate(6px, 0); clip-path: inset(45% 0 25% 0); opacity: 0.95; }
  38% { transform: translate(-7px, 1px); clip-path: inset(20% 0 70% 0); opacity: 0.95; }
  39% { transform: translate(5px, -2px); clip-path: inset(60% 0 15% 0); opacity: 0.95; }
  40% { transform: translate(0, 0); clip-path: inset(0 0 0 0); opacity: 0; }
  /* Major burst at 70-74% — most aggressive */
  70% { transform: translate(8px, 1px); clip-path: inset(50% 0 20% 0); opacity: 1; }
  71% { transform: translate(-6px, -2px); clip-path: inset(10% 0 75% 0); opacity: 1; }
  72% { transform: translate(7px, 0);   clip-path: inset(80% 0 0 0);   opacity: 1; }
  73% { transform: translate(-7px, 2px); clip-path: inset(25% 0 50% 0); opacity: 1; }
  74% { transform: translate(0, 0); clip-path: inset(0 0 0 0); opacity: 0; }
}
@keyframes sinister-glitch-cyan {
  0%, 100% { transform: translate(0, 0); clip-path: inset(0 0 0 0); opacity: 0; }
  3%  { transform: translate(-6px, 1px); clip-path: inset(60% 0 20% 0); opacity: 0.9; }
  4%  { transform: translate(5px, 0);    clip-path: inset(10% 0 75% 0); opacity: 0.9; }
  5%  { transform: translate(-7px, -1px); clip-path: inset(40% 0 30% 0); opacity: 0.9; }
  6%  { transform: translate(4px, 2px);  clip-path: inset(75% 0 5% 0); opacity: 0.9; }
  7%  { transform: translate(0, 0); clip-path: inset(0 0 0 0); opacity: 0; }
  37% { transform: translate(-6px, 0);   clip-path: inset(20% 0 60% 0); opacity: 0.9; }
  38% { transform: translate(7px, 1px);  clip-path: inset(65% 0 10% 0); opacity: 0.9; }
  39% { transform: translate(-5px, -1px); clip-path: inset(40% 0 35% 0); opacity: 0.9; }
  40% { transform: translate(0, 0); clip-path: inset(0 0 0 0); opacity: 0; }
  70% { transform: translate(-8px, -1px); clip-path: inset(30% 0 50% 0); opacity: 1; }
  71% { transform: translate(6px, 2px);   clip-path: inset(70% 0 10% 0); opacity: 1; }
  72% { transform: translate(-7px, 0);    clip-path: inset(0 0 80% 0);   opacity: 1; }
  73% { transform: translate(8px, -2px);  clip-path: inset(45% 0 30% 0); opacity: 1; }
  74% { transform: translate(0, 0); clip-path: inset(0 0 0 0); opacity: 0; }
}
/* Main-layer jitter — bigger nudges and more frames synced to the
   glitch bursts so the whole element feels like it's tearing apart. */
@keyframes sinister-glitch-jitter {
  0%, 2%, 8%, 36%, 41%, 69%, 75%, 100% { transform: translate(0, 0) skewX(0deg); }
  3%  { transform: translate(-2px, 0) skewX(-3deg); }
  4%  { transform: translate(2px, 1px) skewX(2deg); }
  5%  { transform: translate(-1px, 0) skewX(-1deg); }
  6%  { transform: translate(2px, -1px) skewX(3deg); }
  37% { transform: translate(3px, 0) skewX(2deg); }
  38% { transform: translate(-2px, 1px) skewX(-3deg); }
  39% { transform: translate(2px, 0) skewX(1deg); }
  70% { transform: translate(-3px, 0) skewX(-4deg); }
  71% { transform: translate(2px, -1px) skewX(3deg); }
  72% { transform: translate(-2px, 1px) skewX(-2deg); }
  73% { transform: translate(3px, 0) skewX(4deg); }
}
.sinister-glitch {
  animation: sinister-glitch-jitter 4.2s infinite steps(1);
}

/* Cell focus states — the centered cell is bright and full opacity, all
   other visible cells fade dim and dark so the user knows which one
   they're about to click. 200ms ease so transitions between states are
   smooth as cells scroll through the viewport. */
[data-cell="1"][data-focus="center"] {
  opacity: 1;
  filter: brightness(1);
  transition: opacity 200ms ease-out, filter 200ms ease-out;
}
[data-cell="1"][data-focus="off"] {
  opacity: 0.55;
  filter: brightness(0.4);
  transition: opacity 200ms ease-out, filter 200ms ease-out;
}

/* View transition — every screen wraps in .sinister-view-enter, which
   re-triggers this animation each time the view changes (we key the
   wrapper on view.name so React swaps the DOM node). The effect is a
   quick fade-up + slight scale-up so the new screen "morphs" into
   existence rather than cutting in. Tuned short (240ms) so navigation
   still feels snappy, not floaty. */
@keyframes sinister-view-enter {
  0% {
    opacity: 0;
    transform: translateY(14px) scale(0.985);
    filter: blur(6px);
  }
  60% {
    opacity: 1;
    filter: blur(0px);
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1);
    filter: blur(0px);
  }
}
.sinister-view-enter {
  animation: sinister-view-enter 240ms ease-out both;
  /* will-change hint so the browser allocates a GPU layer for the duration
     of the animation. Without this, big screens with the fire effect
     behind them can drop frames mid-animation. */
  will-change: opacity, transform, filter;
}
`;

  return css;
}

if (typeof document !== 'undefined' && !document.getElementById('sinister-styles')) {
  const s = document.createElement('style');
  s.id = 'sinister-styles';
  s.textContent = buildStyleCss();
  document.head.appendChild(s);
}

function titleCase(s: string) {
  return s.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// ---------- "BY SINISTER" with reversed final R ----------
// Previous attempts used inline-block + negative margin to fight the parent's
// letter-spacing. Flaky — the margin needed depended on font width, the flipped
// glyph's own width, AND the letter-spacing, all of which are hard to predict.
//
// New approach: render every letter individually inside a flex row. No
// letter-spacing on the parent at all (we use `gap` instead), so each letter
// occupies exactly its glyph width with a known gap to its neighbors. The
// reversed R is just another flex item — same gap as everything else, no
// negative margin, no kerning fight.
function BySinister() {
  const letters = 'BY SINISTER'.split('');
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '0.32em' }}>
      {letters.map((ch, i) => {
        const isLastR = i === letters.length - 1;
        // Render the space character as a fixed-width spacer so flex gap doesn't
        // double up around it. Otherwise each side of the space adds gap, making
        // "BY  SINISTER" with double spacing.
        if (ch === ' ') {
          return <span key={i} style={{ width: '0.3em', display: 'inline-block' }} />;
        }
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              transform: isLastR ? 'scaleX(-1)' : undefined,
            }}
          >
            {ch}
          </span>
        );
      })}
    </span>
  );
}

// ---------- US states (alphabetical) ----------
// All 50 + DC. Empty states are still shown in the picker so the layout is
// stable as content fills in. The state value stored on each site comes from
// the server's reverse-geocode of lat/lng on submit.
const US_STATES: string[] = [
  'Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut',
  'Delaware','District of Columbia','Florida','Georgia','Hawaii','Idaho','Illinois',
  'Indiana','Iowa','Kansas','Kentucky','Louisiana','Maine','Maryland','Massachusetts',
  'Michigan','Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada',
  'New Hampshire','New Jersey','New Mexico','New York','North Carolina','North Dakota',
  'Ohio','Oklahoma','Oregon','Pennsylvania','Rhode Island','South Carolina',
  'South Dakota','Tennessee','Texas','Utah','Vermont','Virginia','Washington',
  'West Virginia','Wisconsin','Wyoming',
];

// ---------- View state ----------
// Drilldown: home -> stateList(category) -> category(category+state) -> detail
type View =
  | { name: 'home' }
  | { name: 'stateList'; category: CategoryKey }
  | { name: 'category'; category: CategoryKey; state: string }
  | { name: 'detail'; site: SinisterSite }
  | { name: 'submit' }
  | { name: 'about' };

export default function App() {
  const [view, setView] = useState<View>({ name: 'home' });
  const [currentLocation, setCurrentLocation] = useState<{ lat: number; lng: number } | null>(null);
  // Tracks whether to show the "Enable Always Location" modal. Shown once
  // on the second app launch (iOS only escalates "While Using" -> "Always"
  // on a re-prompt, never on first ask). Persisted decision in localStorage
  // so we never nag a user who has already accepted or declined.
  const [showAlwaysModal, setShowAlwaysModal] = useState(false);
  // Sites are loaded from the server at startup. While the network call is
  // pending, we use the bundled FALLBACK_SITES so the app isn't empty.
  // After the fetch completes, `sites` is replaced with the live data.
  const [sites, setSitesState] = useState<SinisterSite[]>(FALLBACK_SITES);
  const [sitesLoaded, setSitesLoaded] = useState(false);

  // Eagerly start decoding all audio buffers + prime gain chains on first touch
  useEffect(() => {
    try { ensureSlideAudio(); } catch { /* silent */ }
    try { ensureButtonAudio(); } catch { /* silent */ }
    try { ensureBackAudio(); } catch { /* silent */ }
    try { ensureBellAudio(); } catch { /* silent */ }
    let primed = false;
    const primeOnFirstTouch = () => {
      if (primed) return;
      primed = true;
      const ctxs: Array<{ ctx: AudioContext | null; gain: GainNode | null }> = [
        { ctx: _slideAudioCtx, gain: _slideAudioGain },
        { ctx: _buttonAudioCtx, gain: _buttonAudioGain },
        { ctx: _backAudioCtx, gain: _backAudioGain },
        { ctx: _bellAudioCtx, gain: _bellAudioGain },
      ];
      for (const { ctx, gain } of ctxs) {
        if (!ctx || !gain) continue;
        try {
          if (ctx.state === 'suspended') ctx.resume().catch(() => { /* silent */ });
          const sr = ctx.sampleRate;
          const silent = ctx.createBuffer(1, Math.floor(sr * 0.05), sr);
          const primer = ctx.createBufferSource();
          primer.buffer = silent;
          primer.connect(gain);
          primer.start(0);
        } catch { /* silent */ }
      }
      try { _slidePrimed = true; } catch { /* silent */ }
      window.removeEventListener('pointerdown', primeOnFirstTouch);
      window.removeEventListener('touchstart', primeOnFirstTouch);
    };
    window.addEventListener('pointerdown', primeOnFirstTouch, { passive: true });
    window.addEventListener('touchstart', primeOnFirstTouch, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', primeOnFirstTouch);
      window.removeEventListener('touchstart', primeOnFirstTouch);
    };
  }, []);

  // Scroll-bleed fix: every time the view changes, snap the page back to the
  // top. Without this, scrolling deep into a state list and then hitting Run
  // Home leaves the home screen already scrolled because the document body
  // is the scroll container shared across all views.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }
  }, [view.name]);

  // Initial site load from the server. The geofencing module gets the same
  // list so it can register the closest 20 as native geofences.
  useEffect(() => {
    (async () => {
      const live = await fetchLiveSites();
      // If the server returned at least one site, use the live list.
      // Otherwise fall back to the bundled test data so the app isn't empty
      // (this matters during development when the server is unreachable).
      const next = live.length > 0 ? live : FALLBACK_SITES;
      setSitesState(next);
      setSites(next); // hand to geofencing module
      setSitesLoaded(true);
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        // Sites are handed to the geofencing module by the live-fetch effect
        // above; we don't need to set them here.
        const perm = await requestPermissions();
        await startGeofencing((lat, lng) => setCurrentLocation({ lat, lng }));

        // One-time "Enable Always Location" upsell. iOS NEVER escalates
        // permission on the first prompt — it always offers "While Using"
        // first, then the user has to either re-prompt or go to Settings
        // to choose "Always". We show this modal on the 2nd launch only,
        // and only if the user actually granted While-Using (no point
        // asking if they denied outright).
        try {
          const KEY_LAUNCHES = 'sinister.launchCount';
          const KEY_DECIDED = 'sinister.alwaysDecided';
          const launches = parseInt(localStorage.getItem(KEY_LAUNCHES) || '0', 10) + 1;
          localStorage.setItem(KEY_LAUNCHES, String(launches));
          const alreadyDecided = localStorage.getItem(KEY_DECIDED) === '1';
          const grantedWhileInUse = perm?.location === 'whileInUse';
          if (launches >= 2 && !alreadyDecided && grantedWhileInUse) {
            // Defer slightly so the home screen has a chance to render first.
            setTimeout(() => setShowAlwaysModal(true), 1200);
          }
        } catch { /* localStorage unavailable — skip */ }
      } catch (err: any) { try { (window as any).__bootError = String(err?.message || err); console.error('[BOOT-ERR]', err); alert('BOOT ERROR: ' + (err?.message || err)); } catch {} }    })();

    // Web-geolocation fallback. Runs in parallel to the native geofencing
    // init above. On iOS TestFlight builds, the native bg-geolocation plugin
    // can throw silently during requestPermissions() and never trigger the
    // iOS permission prompt — leaving currentLocation null forever and
    // disabling the Submit Locale button. navigator.geolocation works
    // reliably in the iOS WebView and uses the standard iOS prompt.
    let webGeoWatchId: number | null = null;
    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      // First fix: try to get a quick position so the form can light up
      // immediately if the user has already granted permission.
      navigator.geolocation.getCurrentPosition(
        (pos) => setCurrentLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => { /* user denied or timeout — silent */ },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
      );
      // Then keep it fresh so the gpsReadout updates as the user moves.
      try {
        webGeoWatchId = navigator.geolocation.watchPosition(
          (pos) => setCurrentLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
          () => { /* silent */ },
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }
        );
      } catch { /* silent */ }
    }

    // Notification deep-link handler. The geofencing module dispatches this
    // window event when the user taps a "you're near {site}" notification.
    // We look up the site by id and jump straight to the detail view.
    function handleOpenSite(e: Event) {
      const ce = e as CustomEvent<{ siteId: string }>;
      const siteId = ce.detail?.siteId;
      if (!siteId) return;
      const site = sites.find(s => s.id === siteId);
      if (site) setView({ name: 'detail', site });
    }
    window.addEventListener('sinister:open-site', handleOpenSite);

    return () => {
      stopGeofencing();
      window.removeEventListener('sinister:open-site', handleOpenSite);
      if (webGeoWatchId !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
        try { navigator.geolocation.clearWatch(webGeoWatchId); } catch { /* silent */ }
      }
    };
  }, [sites]);

  // Centralized navigation helpers so sound playback is consistent and we
  // never forget to play the right sound on a transition.
  function goStateList(key: CategoryKey) {
    playButton();
    setView({ name: 'stateList', category: key });
  }
  function goCategoryState(key: CategoryKey, state: string) {
    playButton();
    setView({ name: 'category', category: key, state });
  }
  function goDetail(site: SinisterSite) {
    playButton();
    setView({ name: 'detail', site });
  }
  function goSubmit() {
    playButton();
    setView({ name: 'submit' });
  }
  function goAbout() {
    playButton();
    setView({ name: 'about' });
  }
  function goHome() {
    playBackSound();
    setView({ name: 'home' });
  }
  function goStateListBack(key: CategoryKey) {
    playBackSound();
    setView({ name: 'stateList', category: key });
  }
  // Step back from detail to the locale list (e.g. Virginia hauntings),
  // not all the way to the state picker. The site carries its own state
  // so we can reconstruct the locale-list view from it.
  function goLocaleListBack(key: CategoryKey, state: string) {
    playBackSound();
    setView({ name: 'category', category: key, state });
  }

  // Pick the rendered view based on current state. We assemble it into a
  // local variable rather than returning directly so we can wrap the result
  // in a keyed animation container below.
  let viewElement: JSX.Element;
  let viewKey: string;
  if (view.name === 'detail') {
    viewKey = `detail:${view.site.id}`;
    viewElement = (
      <DetailView
        site={view.site}
        currentLocation={currentLocation}
        onBack={() => goLocaleListBack(view.site.category as CategoryKey, view.site.state)}
      />
    );
  } else if (view.name === 'category') {
    const filtered = sites.filter(s => s.category === view.category && s.state === view.state);
    const cat = CATEGORIES.find(c => c.key === view.category);
    viewKey = `category:${view.category}:${view.state}`;
    viewElement = (
      <CategoryView
        label={`${view.state} · ${cat?.label || titleCase(view.category)}`}
        color={CATEGORY_COLOR[view.category]}
        sites={filtered}
        currentLocation={currentLocation}
        onSelectSite={goDetail}
        onBack={() => goStateListBack(view.category)}
      />
    );
  } else if (view.name === 'stateList') {
    const cat = CATEGORIES.find(c => c.key === view.category);
    viewKey = `stateList:${view.category}`;
    viewElement = (
      <StateListView
        sites={sites}
        category={view.category}
        categoryLabel={cat?.label || titleCase(view.category)}
        color={CATEGORY_COLOR[view.category]}
        onSelectState={(state) => goCategoryState(view.category, state)}
        onBack={goHome}
      />
    );
  } else if (view.name === 'submit') {
    viewKey = 'submit';
    viewElement = <SubmitView currentLocation={currentLocation} onBack={goHome} />;
  } else if (view.name === 'about') {
    viewKey = 'about';
    viewElement = <AboutView onBack={goHome} />;
  } else {
    viewKey = 'home';
    viewElement = (
      <HomeView
        sites={sites}
        onSelectCategory={goStateList}
        onSubmit={goSubmit}
        onAbout={goAbout}
      />
    );
  }

  // Set the document body to the app's black background once on mount.
  // Now that appBg uses a transparent background (so the fixed FireEffect
  // can show through), the html/body need to provide the dark fallback
  // color directly to avoid white flashes during navigation/animation.
  useEffect(() => {
    const prevBodyBg = document.body.style.backgroundColor;
    const prevHtmlBg = document.documentElement.style.backgroundColor;
    document.body.style.backgroundColor = '#000000';
    document.documentElement.style.backgroundColor = '#000000';
    return () => {
      document.body.style.backgroundColor = prevBodyBg;
      document.documentElement.style.backgroundColor = prevHtmlBg;
    };
  }, []);

  // Lock document scroll while on the home view (the home view is a fixed
  // overlay sized to the viewport — page scroll would just expose blank
  // space at the bottom). On any other view, restore normal scrolling so
  // long content like the state list and submit form can be read.
  useEffect(() => {
    const isHome = viewKey === 'home';
    document.body.style.overflow = isHome ? 'hidden' : '';
    document.documentElement.style.overflow = isHome ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
      document.documentElement.style.overflow = '';
    };
  }, [viewKey]);

  // The key forces React to unmount + remount the wrapper on every view
  // change, which re-fires the sinister-view-enter CSS animation.
  // FireEffect is rendered at THIS level — outside the keyed wrapper —
  // because the wrapper's CSS transform creates a containing block and
  // would break position:fixed for the fire layers, making them scroll
  // with the page instead of staying anchored to the viewport.
  return (
    <>
      <FireEffect />
      <div key={viewKey} className="sinister-view-enter">
        {viewElement}
      </div>
      {showAlwaysModal && (
        <AlwaysLocationModal
          onEnable={async () => {
            // Re-prompting via addWatcher with requestPermissions:true is
            // what gives iOS the chance to escalate to Always. The user
            // still has to choose Always from the iOS dialog — we just
            // give them the opportunity.
            try {
              localStorage.setItem('sinister.alwaysDecided', '1');
            } catch { /* ignore */ }
            setShowAlwaysModal(false);
            try {
              await requestPermissions();
            } catch { /* silent */ }
          }}
          onDismiss={() => {
            try {
              localStorage.setItem('sinister.alwaysDecided', '1');
            } catch { /* ignore */ }
            setShowAlwaysModal(false);
          }}
        />
      )}
    </>
  );
}

// ---------- Always Location upgrade modal ----------
// Shown once on the second app launch, only if the user accepted While-Using
// on the first launch. iOS won't escalate to Always without a re-prompt,
// and re-prompting blindly is rude. This explains why we want it before
// triggering the iOS dialog.
function AlwaysLocationModal({ onEnable, onDismiss }: {
  onEnable: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.82)',
        backdropFilter: 'blur(4px)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          backgroundColor: BLACK,
          border: `2px solid ${BLUE}`,
          borderRadius: 18,
          padding: 24,
          maxWidth: 380,
          width: '100%',
          boxShadow: `0 0 36px ${BLUE}88, inset 0 0 22px ${BLUE}33`,
          color: BONE,
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <div style={{
          fontFamily: '"Jolly Lodger", system-ui, serif',
          fontSize: 32,
          color: '#FFFFFF',
          textShadow: `0 0 14px ${BLUE}cc`,
          textAlign: 'center',
          marginBottom: 12,
          lineHeight: 1,
        }}>
          Drive-by Alerts
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.55, margin: '0 0 18px', textAlign: 'center', color: BONE }}>
          For The Dread Directory to ping you when you drive past a sinister location — even with the app closed — iOS needs <strong>Always</strong> location permission.
        </p>
        <p style={{ fontSize: 12, lineHeight: 1.5, margin: '0 0 22px', textAlign: 'center', color: '#9b9b9b' }}>
          On the next prompt, choose <strong>"Change to Always Allow"</strong>. You can change this anytime in Settings.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button
            type="button"
            onClick={onEnable}
            style={{
              backgroundColor: 'transparent',
              border: `2px solid ${BLUE}`,
              borderRadius: 14,
              color: '#FFFFFF',
              padding: '14px',
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: '0.15em',
              fontFamily: 'inherit',
              cursor: 'pointer',
              boxShadow: `0 0 14px ${BLUE}66`,
            }}
          >
            ENABLE ALWAYS
          </button>
          <button
            type="button"
            onClick={onDismiss}
            style={{
              backgroundColor: 'transparent',
              border: `1.5px solid ${GRAY_MID}`,
              borderRadius: 14,
              color: GRAY_MID,
              padding: '12px',
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '0.15em',
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            NOT NOW
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Fire effect ----------
function FireEffect() {
  return (
    <div style={S.fireWrap} aria-hidden="true">
      <div style={S.fireBaseGlow} />
      <div style={S.fireHotCore} />
      {EMBERS.map((e, i) => (
        <div
          key={i}
          style={{
            ...S.ember,
            left: `${e.left}%`,
            width: e.size,
            height: e.size,
            ['--sway' as any]: `${e.sway}px`,
            animation: `sinister-ember ${e.duration}s linear ${e.delay}s infinite`,
          }}
        />
      ))}
    </div>
  );
}

// ---------- Bottom social bar ----------
function SocialBar({ onAbout, flow }: { onAbout: () => void; flow?: boolean }) {
  function openExternal(url: string) {
    playButton();
    window.open(url, '_blank', 'noopener,noreferrer');
  }
  return (
    <div style={flow ? S.socialBarFlow : S.socialBar}>
      <button style={S.socialBtn} onClick={() => openExternal(INSTAGRAM_URL)}>
        <span style={S.socialIcon}>📷</span>
        <span style={S.socialLabel}>Instagram</span>
      </button>
      <button style={S.socialBtn} onClick={() => openExternal(YOUTUBE_URL)}>
        <span style={S.socialIcon}>▶️</span>
        <span style={S.socialLabel}>YouTube</span>
      </button>
      <button style={S.socialBtn} onClick={onAbout}>
        <span style={S.socialIcon}>ℹ️</span>
        <span style={S.socialLabel}>About</span>
      </button>
    </div>
  );
}

// ---------- HOME ----------
function HomeView({ sites, onSelectCategory, onSubmit, onAbout }: {
  sites: SinisterSite[];
  onSelectCategory: (key: CategoryKey) => void;
  onSubmit: () => void;
  onAbout: () => void;
}) {
  const counts: Record<string, number> = {};
  for (const s of sites) counts[s.category] = (counts[s.category] || 0) + 1;
  const ordered = [...CATEGORIES].sort((a, b) => a.gridIndex - b.gridIndex);

  // Filmstrip with looping: render 3 copies of the cell sequence stacked.
  // Start scrolled to the middle copy. When the user scrolls into the top
  // or bottom copy, silently jump back to the equivalent position in the
  // middle copy — the user perceives an infinite loop.
  type Entry = { id: string; kind: 'cat'; key: CategoryKey; label: string; image: string; count: number };
  const baseSequence: Entry[] = ordered.map((cat, i) => ({
    id: `cat-${cat.key}-${i}`,
    kind: 'cat' as const,
    key: cat.key,
    label: cat.label,
    image: cat.image,
    count: counts[cat.key] || 0,
  }));
  // 3 stacked copies. Each cell prefixed with its copy index for unique React keys.
  const cellsLooped: Entry[] = [0, 1, 2].flatMap((copy) =>
    baseSequence.map(e => ({ ...e, id: `c${copy}-${e.id}` }))
  );

  // Each cell is 200 tall + 24 gap = 224 stride. baseSequence length × stride
  // = the height of one full copy of the sequence.
  const CELL_STRIDE = 248 + 16;
  const sequenceLength = baseSequence.length;
  const oneCopyHeight = sequenceLength * CELL_STRIDE;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Refs to the two sprocket columns flanking the strip — used to slide
  // the holes vertically in sync with the cells so the whole assembly
  // moves together like a real filmstrip being pulled through a gate.
  const sprocketLeftRef = useRef<HTMLDivElement | null>(null);
  const sprocketRightRef = useRef<HTMLDivElement | null>(null);

  // On mount: scroll to the start of the middle copy so the user has equal
  // looping room above and below.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = oneCopyHeight;
  }, [oneCopyHeight]);

  // Loop handler + strict one-cell-per-gesture scrolling. Native scrolling
  // can let users fly past multiple cells on a fast flick; instead we
  // intercept the gesture and advance exactly ONE cell per swipe / wheel
  // tick. This makes the strip feel like a detent wheel that always wants
  // to settle on the next cell, regardless of how hard you flick.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    let lastFocusedEl: HTMLElement | null = null;
    let isAnimating = false;
    let wheelLockUntil = 0;
    let touchStartY = 0;
    let touchStartScroll = 0;

    const updateFocus = () => {
      const viewportCenter = el.scrollTop + el.clientHeight / 2;
      const cells = el.querySelectorAll<HTMLElement>('[data-cell="1"]');
      let bestEl: HTMLElement | null = null;
      let bestDist = Infinity;
      cells.forEach(c => {
        const cellCenter = c.offsetTop + c.offsetHeight / 2;
        const dist = Math.abs(cellCenter - viewportCenter);
        if (dist < bestDist) { bestDist = dist; bestEl = c; }
      });
      cells.forEach(c => {
        c.setAttribute('data-focus', c === bestEl ? 'center' : 'off');
      });
      lastFocusedEl = bestEl;
    };

    // Translate the two sprocket columns vertically in lockstep with the
    // cell scroll position. Modulo by the hole-pattern stride (28px = hole
    // height 14 + gap 14) so the translation visually loops forever — the
    // user just sees endless sprocket holes pulling past as the strip
    // advances, like real film through a projector gate.
    const SPROCKET_STRIDE = 28;
    const updateSprockets = () => {
      const offset = -(el.scrollTop % SPROCKET_STRIDE);
      const transform = `translateY(${offset}px)`;
      if (sprocketLeftRef.current) sprocketLeftRef.current.style.transform = transform;
      if (sprocketRightRef.current) sprocketRightRef.current.style.transform = transform;
    };

    // Animate scroll to a target position over ~280ms with ease-out. Loop
    // teleport happens AFTER this completes, never during, so visual stays
    // smooth.
    const animateTo = (target: number) => {
      isAnimating = true;
      const start = el.scrollTop;
      const distance = target - start;
      const duration = 280;
      const startTime = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - startTime) / duration);
        // ease-out cubic
        const eased = 1 - Math.pow(1 - t, 3);
        el.scrollTop = start + distance * eased;
        updateFocus();
        updateSprockets();
        if (t < 1) {
          raf = requestAnimationFrame(step);
        } else {
          isAnimating = false;
          // Post-animation: do loop teleport if we drifted too far.
          const top = el.scrollTop;
          if (top < oneCopyHeight * 0.5) el.scrollTop = top + oneCopyHeight;
          else if (top > oneCopyHeight * 1.5) el.scrollTop = top - oneCopyHeight;
          updateFocus();
          updateSprockets();
        }
      };
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(step);
    };

    // Advance exactly one cell in the given direction (1 = next/down,
    // -1 = previous/up). Used for both wheel ticks and swipes.
    const advanceOneCell = (dir: 1 | -1) => {
      if (isAnimating) return;
      // Fire the slide sound here — one sound per advance, guaranteed.
      // Single Audio instance auto-stops itself when restarted, so back-to-
      // back advances never produce overlapping audio.
      playSlide();
      const target = el.scrollTop + dir * CELL_STRIDE;
      animateTo(target);
    };

    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < 5) return;
      e.preventDefault();
      const now = performance.now();
      if (now < wheelLockUntil) return;
      wheelLockUntil = now + 320; // one wheel tick at a time
      advanceOneCell(e.deltaY > 0 ? 1 : -1);
    };
    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0]?.clientY ?? 0;
      touchStartScroll = el.scrollTop;
    };
    const onTouchMove = (e: TouchEvent) => {
      // Block native scrolling — we'll handle the advance on touchend
      // so the user can't free-scroll past multiple cells.
      e.preventDefault();
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (isAnimating) return;
      const endY = e.changedTouches[0]?.clientY ?? touchStartY;
      const delta = touchStartY - endY;
      // Threshold: 25px of swipe = advance one cell. Below threshold,
      // snap back to the current cell.
      if (Math.abs(delta) > 25) {
        advanceOneCell(delta > 0 ? 1 : -1);
      } else {
        // Snap back to where we started — no advance.
        animateTo(touchStartScroll);
      }
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });

    // Initial focus pass.
    setTimeout(() => { updateFocus(); updateSprockets(); }, 0);

    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      cancelAnimationFrame(raf);
    };
  }, [oneCopyHeight]);

  const handleClick = (e: Entry) => {
    onSelectCategory(e.key);
  };

  return (
    <div style={S.appBg}>
      <div style={S.homeReelLayout}>
        {/* All three pieces — title, strip, social bar — sit in this
            wrapper which is vertically centered on screen. */}
        <div style={S.homeReelGroup}>
          <div style={S.homeFilmHeader}>
            <div style={S.titleStackThe}>THE</div>
            <div style={S.titleStackTop} className="sinister-glitch" data-text="Dread">Dread</div>
            <div style={S.titleStackBottom} className="sinister-glitch" data-text="Directory">Directory</div>
            <div style={S.bySinister}><BySinister /></div>
          </div>

          <div style={S.homeReelCenter}>
            <div style={S.filmstripOuter}>
              <SprocketColumn ref={sprocketLeftRef} side="left" />
              <SprocketColumn ref={sprocketRightRef} side="right" />
              <div ref={scrollRef} style={S.filmstripWrap}>
                <div style={S.filmstripFrames}>
                {cellsLooped.map((entry) => (
                  <button
                    key={entry.id}
                    data-cell="1"
                    className="sinister-pressable"
                    onClick={() => handleClick(entry)}
                    style={{
                      ...S.filmFrame,
                      backgroundImage: `url(${entry.image})`,
                    }}
                  >
                    <div style={S.filmFrameOverlay} />
                    <div style={S.filmFrameContent}>
                      <div style={S.filmFrameLabel}>{entry.label}</div>
                      <div style={S.filmFrameCount}>
                        {entry.count === 1 ? '1 Location' : `${entry.count} Locations`}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

      {/* Social bar pinned to viewport bottom — outside the centered group */}
      {/* Submit a Locale button — fixed above the social bar, always visible.
          This is the primary call-to-action for getting new locales contributed
          so it must never be hidden by scrolling away from a cell. */}
      <button
        className="sinister-pressable"
        onClick={onSubmit}
        style={S.submitFixedButton}
      >
        <span style={S.submitFixedButtonText}>Submit a Location</span>
      </button>

      <SocialBar onAbout={onAbout} />
    </div>
  );
}

// ---------- Sprocket column (filmstrip edge) ----------
// Renders the perforated holes down one side of the filmstrip. Each hole is
// its own div in a flex column so they're proper rectangles (not gradient
// stripes). The hole interiors are transparent — the fire glow + embers
// show through them while the dark column around them stays opaque.
const SprocketColumn = forwardRef<HTMLDivElement, { side: 'left' | 'right' }>(function SprocketColumn({ side }, ref) {
  // Render plenty of hole divs so the column visually fills any height
  // we can throw at it. Excess holes are clipped by sprocketCol's
  // overflow: hidden. Each hole is a rectangular cutout with rounded
  // corners against the dark "film material" background of the column,
  // matching the reference image exactly.
  const holes = Array.from({ length: 250 });
  return (
    <div
      ref={ref}
      style={{
        ...S.sprocketCol,
        ...(side === 'left'
          ? { left: 0 }
          : { right: 0 }),
      }}
    >
      {holes.map((_, i) => (
        <div key={i} style={S.sprocketHole} />
      ))}
    </div>
  );
});


// ---------- STATE LIST (drilldown step between category and locale list) ----------
function StateListView({ sites, category, categoryLabel, color, onSelectState, onBack }: {
  sites: SinisterSite[];
  category: CategoryKey;
  categoryLabel: string;
  color: string;
  onSelectState: (state: string) => void;
  onBack: () => void;
}) {
  // Count how many sites in this category live in each state. States with
  // zero are still rendered (visually dimmed) so users see all 50 entries.
  const counts: Record<string, number> = {};
  for (const s of sites) {
    if (s.category === category) counts[s.state] = (counts[s.state] || 0) + 1;
  }

  return (
    <div style={S.appBg}>
      <header style={S.header}>
        <button
          onClick={onBack}
          style={{ ...S.backButton, border: `2px solid ${BLUE}`, boxShadow: `0 0 12px ${BLUE}66`, color: color }}
        >
          ← Run Home
        </button>
        <div style={{
          ...S.categoryViewTitle,
          color: color,
          textShadow: `0 0 14px ${color}cc, 0 0 28px ${color}66`,
        }}>{categoryLabel}</div>
        <div style={S.stateListHint}>Choose a state</div>
      </header>

      {/* Filmstrip layout — 2 cells per row, each a 35mm-aspect frame with
          Jolly Lodger name + count centered. Sprocket columns flank both
          edges of the strip like the home filmstrip. */}
      <div style={S.stateFilmstripOuter}>
        <SprocketColumn side="left" />
        <SprocketColumn side="right" />
        <div style={S.stateFilmstripGrid}>
          {US_STATES.map((state) => {
            const count = counts[state] || 0;
            const empty = count === 0;
            return (
              <button
                key={state}
                onClick={() => onSelectState(state)}
                className="sinister-pressable"
                style={{
                  ...S.stateFilmCell,
                  opacity: empty ? 0.55 : 1,
                  filter: empty ? 'grayscale(0.5)' : 'none',
                }}
              >
                <div style={S.stateFilmCellName}>
                  <span style={empty ? undefined : {
                    display: 'inline-block',
                    animation: 'sinister-cell-title-pulse 3.5s ease-in-out infinite',
                    transformOrigin: 'center center',
                  }}>{state}</span>
                </div>
                <div style={S.stateFilmCellCount}>
                  {count === 1 ? '1 Location' : `${count} Locations`}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}


function AboutView({ onBack }: { onBack: () => void }) {
  // Geofencing debug log viewer — accessed via a labeled button below.
  // We tried hidden 5-tap and long-press patterns; iOS WebView interferes
  // with both. A plain visible button is unambiguous and reliable.
  const [showDebug, setShowDebug] = useState(false);
  const [debugLines, setDebugLines] = useState<string[]>([]);
  function openDebug() {
    setDebugLines(getDebugLog());
    setShowDebug(true);
  }
  return (
    <div style={S.appBg}>
      <header style={S.header}>
        <button
          onClick={onBack}
          style={{ ...S.backButton, border: `2px solid ${WHITE}`, boxShadow: `0 0 12px ${WHITE}66`, color: WHITE }}
        >
          ← Run Home
        </button>
        <div
          style={{ ...S.categoryViewTitle, color: WHITE, textShadow: `0 0 14px ${WHITE}cc` }}
        >
          About
        </div>
      </header>

      <div style={S.aboutBody}>
        <p style={S.aboutPara}>
          <b>Sinister Locations</b> is a field guide to the macabre — historic crimes, hauntings, horror film locations,
          cults, serial killers, and unsettling history hiding all around you. The app pings you when you're near a site
          worth knowing about.
        </p>
        <p style={S.aboutPara}>
          Part of the Sinister family — alongside Sinister Trivia and the Sinister Vids YouTube channel.
        </p>
        <p style={S.aboutPara}>
          User submissions require an on-site photo and GPS verification. Approved entries are credited to the submitter
          permanently.
        </p>
        <div style={{ marginTop: 24 }}>
          <button
            style={{ ...S.aboutLinkBtn, border: `2px solid ${WHITE}`, color: WHITE }}
            onClick={() => { playForward(); window.open(INSTAGRAM_URL, '_blank', 'noopener,noreferrer'); }}
          >
            📷 Follow on Instagram
          </button>
          <button
            style={{ ...S.aboutLinkBtn, border: `2px solid ${WHITE}`, color: WHITE, marginTop: 12 }}
            onClick={() => { playForward(); window.open(YOUTUBE_URL, '_blank', 'noopener,noreferrer'); }}
          >
            ▶️ Subscribe on YouTube
          </button>
          <button
            style={{ ...S.aboutLinkBtn, border: `2px solid ${BLUE}`, color: BLUE, marginTop: 12 }}
            onClick={openDebug}
          >
            🔍 View Geofencing Log
          </button>
        </div>
      </div>
      {showDebug && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setShowDebug(false)}
          style={{
            position: 'fixed', inset: 0, backgroundColor: 'rgba(0, 0, 0, 0.92)',
            zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              backgroundColor: BLACK, border: `2px solid ${WHITE}`, borderRadius: 14,
              padding: 16, maxWidth: 480, width: '100%', maxHeight: '80vh',
              display: 'flex', flexDirection: 'column', gap: 10,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 12, color: WHITE, fontWeight: 700, letterSpacing: '0.15em' }}>GEOFENCING LOG</div>
              <button
                type="button"
                onClick={() => setShowDebug(false)}
                style={{ background: 'transparent', border: 'none', color: WHITE, fontSize: 18, cursor: 'pointer', padding: 4 }}
              >×</button>
            </div>
            <div style={{
              fontFamily: 'Menlo, monospace', fontSize: 10, color: BONE,
              backgroundColor: '#111', padding: 10, borderRadius: 8,
              overflow: 'auto', flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              border: '1px solid #2a2a2a',
            }}>
              {debugLines.length === 0 ? '(empty — no events logged yet)' : debugLines.join('\n')}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => setDebugLines(getDebugLog())}
                style={{
                  flex: 1, background: 'transparent', border: `1.5px solid ${WHITE}`,
                  color: WHITE, padding: '10px', borderRadius: 10, fontSize: 11,
                  fontWeight: 700, letterSpacing: '0.15em', fontFamily: 'inherit', cursor: 'pointer',
                }}
              >REFRESH</button>
              <button
                type="button"
                onClick={() => {
                  try {
                    const txt = debugLines.join('\n');
                    if (navigator.clipboard) navigator.clipboard.writeText(txt);
                  } catch { /* ignore */ }
                }}
                style={{
                  flex: 1, background: 'transparent', border: `1.5px solid ${WHITE}`,
                  color: WHITE, padding: '10px', borderRadius: 10, fontSize: 11,
                  fontWeight: 700, letterSpacing: '0.15em', fontFamily: 'inherit', cursor: 'pointer',
                }}
              >COPY</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- CATEGORY ----------
function CategoryView({ label, color, sites, currentLocation, onSelectSite, onBack }: {
  label: string;
  color: string;
  sites: SinisterSite[];
  currentLocation: { lat: number; lng: number } | null;
  onSelectSite: (s: SinisterSite) => void;
  onBack: () => void;
}) {
  // Search box: case-insensitive substring match against title, short
  // description, and full description. Trims whitespace so trailing spaces
  // don't kill matches. Empty query = show all.
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const filtered = q
    ? sites.filter(s =>
        s.title.toLowerCase().includes(q) ||
        s.shortDescription.toLowerCase().includes(q) ||
        s.fullDescription.toLowerCase().includes(q)
      )
    : sites;

  return (
    <div style={S.appBg}>
      <header style={S.header}>
        <button
          onClick={onBack}
          style={{ ...S.backButton, border: `2px solid ${BLUE}`, boxShadow: `0 0 12px ${BLUE}66`, color: color }}
        >
          ← Run Home
        </button>
        <div style={{
          ...S.categoryViewTitle,
          color: color,
          textShadow: `0 0 14px ${color}cc, 0 0 28px ${color}66`,
        }}>{label}</div>
      </header>

      {/* Search — only shown when there's at least one site to filter. With
          zero sites the search box would just confuse, and with 1-2 sites
          it's overkill. Threshold can be tuned later. */}
      {sites.length >= 1 && (
        <div style={S.searchWrap}>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, city, or keyword..."
            style={S.searchInput}
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              style={S.searchClear}
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {sites.length === 0 ? (
        <div style={S.emptyState}>
          No sites in this state for this category yet.
          <div style={S.emptyStateSub}>Be the first to add one — tap "Submit a Location" on the home screen.</div>
        </div>
      ) : filtered.length === 0 ? (
        <div style={S.emptyState}>
          No sites match "{query}".
          <div style={S.emptyStateSub}>Try a different keyword.</div>
        </div>
      ) : (
        <div style={S.sitesContainer}>
          {filtered.map((site) => {
            const distM = currentLocation ? distanceMeters(currentLocation.lat, currentLocation.lng, site.coords.lat, site.coords.lng) : null;
            const distMi = distM ? (distM / 1609.34).toFixed(1) : null;
            return (
              <button
                key={site.id}
                onClick={() => onSelectSite(site)}
                style={{
                  ...S.siteCard,
                  border: `2px solid ${BLUE}`,
                  boxShadow: `0 0 22px ${BLUE}77, 0 0 42px ${BLUE}33, inset 0 0 14px ${BLUE}22`,
                }}
              >
                <div style={{ ...S.siteCardImage, backgroundImage: `url(${site.imageUrl})` }} />
                <div style={S.siteCardBody}>
                  <div style={{ ...S.siteCardCategory, color: color, textShadow: `0 0 10px ${color}` }}>
                    {titleCase(site.category)}
                  </div>
                  <div style={S.siteCardTitle}>{site.title}</div>
                  <div style={S.siteCardDesc}>{site.shortDescription}</div>
                  {distMi && <div style={{ ...S.siteCardDistance, color: color }}>{distMi} mi from you</div>}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- DETAIL ----------
function DetailView({ site, currentLocation, onBack }: {
  site: SinisterSite;
  currentLocation: { lat: number; lng: number } | null;
  onBack: () => void;
}) {
  const color = CATEGORY_COLOR[site.category as CategoryKey] || WHITE;
  const distM = currentLocation ? distanceMeters(currentLocation.lat, currentLocation.lng, site.coords.lat, site.coords.lng) : null;
  const distMi = distM ? (distM / 1609.34).toFixed(1) : null;
  const handleDirections = () => {
    playForward();
    // Smart cross-platform directions opener:
    //   1. Try `geo:` scheme — iOS/Android show an "open with..." picker so
    //      the user lands in their preferred maps app (Apple Maps, Google Maps,
    //      Waze, etc.). Browsers ignore this scheme.
    //   2. Fall back to a Google Maps web URL — works in every browser, opens
    //      Google Maps app on phones if it's installed (universal link).
    const lat = site.coords.lat;
    const lng = site.coords.lng;
    const label = encodeURIComponent(site.title);
    const geoUrl = `geo:${lat},${lng}?q=${lat},${lng}(${label})`;
    const webUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;

    // Try the geo: scheme first. If the device supports it, the OS handles
    // navigation. If not (e.g. desktop browser), the assignment fails silently
    // and we hit the timeout to open the web fallback in a new tab.
    let opened = false;
    try {
      window.location.href = geoUrl;
      opened = true;
    } catch { /* will fall through */ }

    // 600ms is enough for iOS/Android to switch apps. If we're still on this
    // page after that, the geo: scheme wasn't handled — pop the web URL.
    setTimeout(() => {
      if (document.hasFocus && document.hasFocus()) {
        window.open(webUrl, '_blank', 'noopener,noreferrer');
      }
    }, 600);
    void opened;
  };
  return (
    <div style={S.appBg}>
      <header style={S.header}>
        <button
          onClick={onBack}
          style={{ ...S.backButton, border: `2px solid ${BLUE}`, boxShadow: `0 0 12px ${BLUE}66`, color: color }}
        >
          ← Back
        </button>
      </header>
      <div style={{
        ...S.heroImage,
        backgroundImage: `url(${site.imageUrl})`,
        border: `2px solid ${BLUE}`,
        boxShadow: `0 0 28px ${BLUE}66, inset 0 -50px 80px ${BLACK}`,
      }} />
      <div style={S.detailBody}>
        <div style={{ ...S.detailCategory, color: color, textShadow: `0 0 12px ${color}` }}>
          {titleCase(site.category)}
        </div>
        <div style={{ ...S.detailTitle, textShadow: `0 0 18px ${color}88` }}>{site.title}</div>
        {distMi && <div style={{ ...S.detailDistance, color: color }}>📍 {distMi} mi from you</div>}
        <div style={{ ...S.detailDivider, backgroundColor: BLUE, boxShadow: `0 0 12px ${BLUE}` }} />
        <div style={S.detailDescription}>
          {site.fullDescription.split('\n\n').map((para, i) => <p key={i} style={S.detailPara}>{para}</p>)}
        </div>
        <button
          onClick={handleDirections}
          style={{
            ...S.directionsButton,
            border: `2px solid ${BLUE}`,
            color: color,
            boxShadow: `0 0 22px ${BLUE}77, inset 0 0 14px ${BLUE}22`,
            textShadow: `0 0 10px ${color}`,
          }}
        >
          Get Directions →
        </button>
        <div style={S.imageCredit}>Photo: {site.imageCredit}</div>
      </div>
    </div>
  );
}

// ---------- SUBMIT ----------
// Short Description field REMOVED. The server's `shortDescription` parameter is
// derived from the first ~150 chars of the full description so the existing
// /sites/submit endpoint still gets a value (it requires shortDescription).
function SubmitView({ currentLocation, onBack }: {
  currentLocation: { lat: number; lng: number } | null;
  onBack: () => void;
}) {
  const [title, setTitle] = useState('');
  const [fullDesc, setFullDesc] = useState('');
  const [category, setCategory] = useState<CategoryKey>('crime');
  const [submitter, setSubmitter] = useState('');
  const [locMode, setLocMode] = useState<'gps' | 'manual'>('gps');
  const [manualLat, setManualLat] = useState('');
  const [manualLng, setManualLng] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  // Local GPS fix triggered by a user tap on this form. iOS WebView grants
  // geolocation permission much more reliably when the request comes from a
  // user gesture than from a useEffect at app launch, so this gives users a
  // way to recover even if the parent's auto-init never fired.
  const [gpsLocation, setGpsLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [gpsRequesting, setGpsRequesting] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);

  // Effective GPS location: prefer the form's locally-fetched fix (most
  // recent, user-initiated) and fall back to the app-level currentLocation.
  const effectiveGps = gpsLocation || currentLocation;

  function pinLatLng(): { lat: number; lng: number } | null {
    if (locMode === 'gps') return effectiveGps;
    const lat = parseFloat(manualLat);
    const lng = parseFloat(manualLng);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
  }

  function requestGpsNow() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsError('Geolocation not available on this device.');
      return;
    }
    setGpsRequesting(true);
    setGpsError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setGpsRequesting(false);
      },
      (err) => {
        setGpsRequesting(false);
        if (err.code === err.PERMISSION_DENIED) {
          setGpsError('Location permission denied. Enable in Settings → The Dread Directory → Location, or use Enter Coords.');
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          setGpsError('GPS unavailable right now. Try again or use Enter Coords.');
        } else if (err.code === err.TIMEOUT) {
          setGpsError('GPS timed out. Try again or use Enter Coords.');
        } else {
          setGpsError('Could not get location. Try again or use Enter Coords.');
        }
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  }

  const pin = pinLatLng();
  const titleOk     = title.trim().length >= 3 && title.trim().length <= 120;
  const fullOk      = fullDesc.trim().length >= 20 && fullDesc.trim().length <= 1000;
  const submitterOk = submitter.trim().length >= 2 && submitter.trim().length <= 30;
  const photoOk     = !!photoFile;
  const locOk       = pin !== null;
  const allValid = titleOk && fullOk && submitterOk && photoOk && locOk;

  function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setPhotoFile(f);
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoPreview(URL.createObjectURL(f));
  }

  // Derive a short description from the full description: first sentence,
  // capped at 150 chars and a min of 10 (server requirement).
  function deriveShort(full: string): string {
    const trimmed = full.trim();
    const firstSentence = trimmed.split(/(?<=[.!?])\s+/)[0] || trimmed;
    let s = firstSentence.length > 150 ? firstSentence.slice(0, 147) + '...' : firstSentence;
    if (s.length < 10) s = trimmed.slice(0, 150); // fallback: first 150 chars of full
    return s;
  }

  async function handleSubmit() {
    if (!allValid || !pin) return;
    playBell();
    setSubmitting(true);
    setErrorMsg(null);

    let captureCoords = effectiveGps;
    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      try {
        const pos: GeolocationPosition = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true, timeout: 8000, maximumAge: 0,
          });
        });
        captureCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      } catch { /* fall back */ }
    }

    try {
      const fd = new FormData();
      fd.append('photo', photoFile as Blob);
      fd.append('title', title.trim());
      fd.append('shortDescription', deriveShort(fullDesc));
      fd.append('fullDescription', fullDesc.trim());
      fd.append('category', category);
      fd.append('lat', String(pin.lat));
      fd.append('lng', String(pin.lng));
      fd.append('submitter', submitter.trim());
      if (captureCoords) {
        fd.append('captureLat', String(captureCoords.lat));
        fd.append('captureLng', String(captureCoords.lng));
      }
      const res = await fetch(`${API_BASE}/sites/submit`, { method: 'POST', body: fd });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Server responded ${res.status} ${txt}`);
      }
      const data = await res.json();
      setSuccessMsg(`Thanks, ${submitter.trim()}! Your submission is in review.${data.verified ? ' (Verified on-site 📍)' : ''}`);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Submission failed. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (successMsg) {
    return (
      <div style={S.appBg}>
        <div style={S.homeContentCentered}>
          <div style={S.titleStackTop}>Sinister</div>
          <div style={S.titleStackBottom}>Locations</div>
          <div style={S.bySinister}><BySinister /></div>
          <div style={{ ...S.emptyState, marginTop: 30 }}>
            <div style={{ fontSize: 16, color: BONE, marginBottom: 16, letterSpacing: '0.05em' }}>
              🩸 {successMsg}
            </div>
          </div>
          <div style={{ padding: '0 20px', width: '100%', boxSizing: 'border-box' }}>
            <button
              onClick={onBack}
              style={{
                ...S.directionsButton,
                border: `2px solid ${BLUE}`,
                color: '#FFFFFF',
                boxShadow: `0 0 22px ${BLUE}77, inset 0 0 14px ${BLUE}22`,
              }}
            >
              Run Home
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={S.appBg}>
      <header style={S.header}>
        <button
          onClick={onBack}
          style={{ ...S.backButton, border: `2px solid ${BLUE}`, boxShadow: `0 0 12px ${BLUE}66`, color: '#FFFFFF' }}
        >
          ← Run Home
        </button>
        <div style={{ ...S.categoryViewTitle, color: '#FFFFFF', textShadow: `0 0 14px #FFFFFFcc` }}>
          Submit a Location
        </div>
      </header>

      <div style={S.formBody}>
        <p style={S.formIntro}>
          All fields required. Photos must be taken on-site with your camera — verifies you've actually been there.
        </p>

        <Field label="Location Name" valid={titleOk}>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)}
                 placeholder="e.g. The Cavalier Hotel" maxLength={120} style={S.input} />
        </Field>

        <Field label="Description" valid={fullOk} hint="20-1000 characters — the full story">
          <textarea value={fullDesc} onChange={(e) => setFullDesc(e.target.value)}
                    placeholder="When, who, what happened — the whole story."
                    maxLength={1000} rows={6} style={{ ...S.input, ...S.textarea }} />
        </Field>

        <Field label="Category" valid={true}>
          <select value={category} onChange={(e) => setCategory(e.target.value as CategoryKey)}
                  style={{ ...S.input, color: CATEGORY_COLOR[category] }}>
            {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </Field>

        <Field label="Location" valid={locOk} hint={locMode === 'gps' ? 'Uses your current GPS' : 'Enter coordinates manually'}>
          <div style={S.locModeRow}>
            <button type="button" onClick={() => setLocMode('gps')}
                    style={{ ...S.locModeBtn, border: `1.5px solid ${locMode === 'gps' ? BLUE : '#444'}`, color: locMode === 'gps' ? BLUE : BONE }}>
              Use Current
            </button>
            <button type="button" onClick={() => setLocMode('manual')}
                    style={{ ...S.locModeBtn, border: `1.5px solid ${locMode === 'manual' ? BLUE : '#444'}`, color: locMode === 'manual' ? BLUE : BONE }}>
              Enter Coords
            </button>
          </div>
          {locMode === 'gps' && (
            <div style={S.gpsReadout}>
              {effectiveGps ? (
                `📍 ${effectiveGps.lat.toFixed(5)}, ${effectiveGps.lng.toFixed(5)}`
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
                  <button type="button" onClick={requestGpsNow} disabled={gpsRequesting}
                          style={{ ...S.locModeBtn, border: `1.5px solid ${BLUE}`, color: BLUE, opacity: gpsRequesting ? 0.6 : 1 }}>
                    {gpsRequesting ? 'Getting location…' : '📍 Get my location'}
                  </button>
                  {gpsError && <div style={{ color: '#ff6b6b', fontSize: 13 }}>{gpsError}</div>}
                </div>
              )}
            </div>
          )}
          {locMode === 'manual' && (
            <div style={S.manualRow}>
              <input type="text" inputMode="text" value={manualLat} onChange={(e) => setManualLat(e.target.value)}
                     placeholder="Latitude  (e.g. 36.8534)" style={{ ...S.input, flex: 1, minWidth: 0 }} />
              <input type="text" inputMode="text" value={manualLng} onChange={(e) => setManualLng(e.target.value)}
                     placeholder="Longitude  (e.g. -75.9760)" style={{ ...S.input, flex: 1, minWidth: 0 }} />
            </div>
          )}
        </Field>

        <Field label="Photo (taken on-site)" valid={photoOk} hint="Camera only — no gallery uploads">
          <input ref={fileRef} type="file" accept="image/*" capture="environment"
                 onChange={handlePhotoChange} style={{ display: 'none' }} />
          <button type="button" onClick={() => fileRef.current?.click()}
                  style={{ ...S.photoBtn, border: `2px solid ${BLUE}`, color: '#FFFFFF', boxShadow: `0 0 14px ${BLUE}66` }}>
            {photoFile ? 'Retake Photo' : 'Take Photo'}
          </button>
          {photoPreview && <img src={photoPreview} alt="preview" style={S.photoPreview} />}
        </Field>

        <Field label="Your Handle" valid={submitterOk} hint="2-30 characters — credited on the entry if approved">
          <input type="text" value={submitter} onChange={(e) => setSubmitter(e.target.value)}
                 placeholder="e.g. drew" maxLength={30} style={S.input} />
        </Field>

        {errorMsg && <div style={S.errorBox}>⚠ {errorMsg}</div>}

        <button type="button" onClick={handleSubmit} disabled={!allValid || submitting}
          style={{
            ...S.submitFinalBtn,
            border: `2px solid ${allValid ? SUBMIT_RED : '#444'}`,
            color: allValid ? '#FFFFFF' : '#666',
            boxShadow: allValid ? `0 0 22px ${SUBMIT_RED}88, inset 0 0 14px ${SUBMIT_RED}33` : 'none',
            cursor: allValid && !submitting ? 'pointer' : 'not-allowed',
            opacity: submitting ? 0.6 : 1,
          }}>
          {submitting ? 'Submitting…' : 'Submit'}
        </button>
      </div>
    </div>
  );
}

function Field({ label, valid, hint, children }: {
  label: string; valid: boolean; hint?: string; children: React.ReactNode;
}) {
  return (
    <div style={S.field}>
      <div style={S.fieldLabelRow}>
        <span style={S.fieldLabel}>{label}</span>
        <span style={{ ...S.fieldStatus, color: valid ? '#7CFFB2' : '#666' }}>{valid ? '✓' : '•'}</span>
      </div>
      {children}
      {hint && <div style={S.fieldHint}>{hint}</div>}
    </div>
  );
}

// ---------- Style constants ----------
const BLACK = '#0A0A0A';
const BONE = '#F0EBE0';
const GRAY_DARK = '#141414';
const GRAY_MID = '#3A3A3A';

const S: Record<string, React.CSSProperties> = {
  appBg: {
    minHeight: '100vh',
    width: '100%',
    maxWidth: '100vw',
    overflowX: 'hidden',
    backgroundColor: 'transparent',
    color: BONE,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    position: 'relative',
  },

  fireWrap: { position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0 },
  fireBaseGlow: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    // Full viewport height so the glow reaches up to the top of the screen
    // with the embers rising through it the whole way.
    height: '100vh',
    transformOrigin: 'bottom center',
    background: `
      radial-gradient(ellipse 90% 70% at 50% 100%, ${FIRE_BRIGHT}ee 0%, ${FIRE_BRIGHT}66 20%, ${FIRE_DEEP}44 40%, transparent 75%),
      linear-gradient(to top, ${FIRE_BRIGHT}99 0%, ${FIRE_DEEP}44 25%, ${FIRE_DEEP}22 55%, transparent 90%)
    `,
    animation: `sinister-fire-pulse 2.4s ease-in-out infinite`,
    // Halved intensity — embers (separate layer) stay unchanged.
    opacity: 0.5,
  },
  fireHotCore: {
    position: 'absolute',
    left: '15%', right: '15%', bottom: 0,
    height: '70vh',
    background: `
      radial-gradient(ellipse 70% 50% at 50% 100%, ${FIRE_CORE}ff 0%, ${FIRE_BRIGHT}99 20%, ${FIRE_DEEP}44 50%, transparent 80%)
    `,
    animation: `sinister-fire-flicker 1.7s ease-in-out infinite`,
    filter: 'blur(4px)',
    mixBlendMode: 'screen',
    opacity: 0.5,
  },
  ember: {
    position: 'absolute',
    bottom: -10,
    backgroundColor: FIRE_CORE,
    borderRadius: '50%',
    boxShadow: `0 0 10px ${FIRE_CORE}, 0 0 20px ${FIRE_BRIGHT}`,
    willChange: 'transform, opacity',
  },

  homeContentCentered: {
    position: 'relative',
    zIndex: 1,
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '40px 0 100px',
    boxSizing: 'border-box',
  },

  titleStackThe: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.32em',
    color: SINISTER_RED,
    textShadow: `0 0 8px ${SINISTER_RED}88`,
    marginBottom: 6,
    textAlign: 'center',
  },
  titleStackTop: {
    fontSize: 84,
    fontWeight: 400,
    fontFamily: '"Jolly Lodger", system-ui, serif',
    color: '#FFFFFF',
    letterSpacing: '0.04em',
    lineHeight: 0.92,
    textShadow: `0 0 20px #FFFFFF, 0 0 40px #FFFFFFaa, 2px 2px 0 ${BLACK}`,
    textAlign: 'center',
  },
  titleStackBottom: {
    fontSize: 84,
    fontWeight: 400,
    fontFamily: '"Jolly Lodger", system-ui, serif',
    color: '#FFFFFF',
    letterSpacing: '0.04em',
    lineHeight: 0.92,
    marginTop: 4,
    textShadow: `0 0 20px #FFFFFF, 0 0 40px #FFFFFFaa, 2px 2px 0 ${BLACK}`,
    textAlign: 'center',
  },
  bySinister: {
    marginTop: 8,
    marginBottom: 6,
    fontSize: 11,
    // letter-spacing intentionally NOT set here — BySinister uses flex `gap`
    // internally to space letters. Setting letter-spacing would double up.
    fontWeight: 700,
    color: SINISTER_RED,
    textShadow: `0 0 8px ${SINISTER_RED}88`,
  },

  // ---------- Filmstrip home layout ----------
  homeFilmHeader: {
    position: 'relative',
    zIndex: 2,
    paddingTop: 8,
    paddingBottom: 0,
    marginTop: 60,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
  },
  titleSideBySide: {
    fontSize: 56,
    fontWeight: 400,
    fontFamily: '"Jolly Lodger", system-ui, serif',
    color: '#FFFFFF',
    letterSpacing: '0.02em',
    lineHeight: 1,
    textShadow: `0 0 16px #FFFFFF, 0 0 32px #FFFFFFaa, 2px 2px 0 ${BLACK}`,
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'center',
    flexWrap: 'wrap',
  },

  // The filmstrip is a 3-column grid: sprocket | frames | sprocket. The
  // outer dark "film" border continues into both sprocket columns so the
  // overall shape reads as one piece of physical film.
  // Each piece of the home view is fixed-positioned independently so the
  // bright cell can land at exact viewport center. Title at top, strip
  // centered, social bar at bottom (rendered separately).
  homeReelLayout: {
    position: 'fixed',
    inset: 0,
    zIndex: 2,
    pointerEvents: 'none', // children re-enable
    boxSizing: 'border-box',
  },
  // Title block — fixed at top of viewport.
  homeReelGroup: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    pointerEvents: 'auto',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  // The strip — fixed and translated so its CENTER aligns to viewport center.
  // This is what guarantees the bright cell sits at exact screen-center.
  homeReelCenter: {
    position: 'fixed',
    top: '50%',
    left: 0,
    right: 0,
    transform: 'translateY(-50%)',
    pointerEvents: 'auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  filmstripWrap: {
    position: 'relative',
    height: '100%',
    flexShrink: 0,
    flexGrow: 0,
    overflowY: 'scroll',
    overflowX: 'hidden',
    scrollbarWidth: 'none',
    backgroundColor: 'transparent',
    border: 'none',
    width: '100%',
    boxSizing: 'border-box',
    // Disable browser pan so our touch handler controls advance precisely
    // (one cell per swipe, regardless of swipe speed).
    touchAction: 'none',
  },
  // Outer reel container — wraps the scroll wrap + sprocket overlays
  // and is what the feathered mask is applied to (so cells AND sprockets
  // fade together at top and bottom of the viewport).
  filmstripOuter: {
    position: 'relative',
    width: '100%',
    maxWidth: 480,
    height: 776,
    flexShrink: 0,
    flexGrow: 0,
    margin: '0 14px',
    boxSizing: 'border-box',
    maskImage: 'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,1) 30%, rgba(0,0,0,1) 70%, transparent 100%)',
    WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,1) 30%, rgba(0,0,0,1) 70%, transparent 100%)',
  },

  // ---------- State filmstrip layout ----------
  // Like the home filmstrip but a 2-column grid of cells. Sprocket columns
  // flank both edges. Cells use a 35mm aspect ratio; each shows a state
  // name + location count centered with the Jolly Lodger font.
  stateFilmstripOuter: {
    position: 'relative',
    width: '100%',
    maxWidth: 480,
    margin: '12px auto 80px',
    boxSizing: 'border-box',
    paddingLeft: 34,
    paddingRight: 34,
  },
  stateFilmstripGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 10,
    backgroundColor: 'rgba(20, 14, 10, 0.92)',
    padding: '12px 10px',
    boxSizing: 'border-box',
  },
  stateFilmCell: {
    position: 'relative',
    width: '100%',
    aspectRatio: '4 / 3',
    // Semi-transparent dark gray with a faint warm tint so the cell looks
    // like a film frame being backlit by something orange behind it.
    backgroundColor: 'rgba(40, 28, 20, 0.55)',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: 8,
    overflow: 'hidden',
    cursor: 'pointer',
    fontFamily: 'inherit',
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'transform 80ms ease-out, filter 120ms ease-out',
    boxSizing: 'border-box',
    // Inset orange glow — concentrated in the middle of the cell, fading
    // toward the edges. Two layered shadows: a wider amber halo and a
    // tighter hot-orange core. Makes the cell look like it's lit from
    // behind by a warm projector lamp.
    boxShadow:
      'inset 0 0 28px rgba(255, 140, 50, 0.35), inset 0 0 60px rgba(255, 90, 20, 0.18)',
  },
  stateFilmCellName: {
    fontFamily: '"Jolly Lodger", system-ui, serif',
    fontSize: 28,
    fontWeight: 400,
    lineHeight: 1,
    color: '#FFFFFF',
    letterSpacing: '0.04em',
    textAlign: 'center',
    padding: '0 6px',
    textShadow: '0 0 10px rgba(0,0,0,0.85), 1px 1px 0 #000',
  },
  stateFilmCellCount: {
    fontFamily: '"Jolly Lodger", system-ui, serif',
    fontSize: 18,
    fontWeight: 400,
    lineHeight: 1,
    marginTop: 6,
    letterSpacing: '0.05em',
    textAlign: 'center',
    color: '#FFFFFF',
    textShadow: '0 0 8px rgba(0,0,0,0.85), 1px 1px 0 #000',
  },
  // Non-fixed version of the social bar for use inside the grouped flow
  // layout on the home view. Shares all child styling with the fixed
  // bar but lives in normal document flow.
  socialBarFlow: {
    position: 'relative',
    zIndex: 2,
    display: 'flex',
    justifyContent: 'center',
    gap: 8,
    padding: '0 12px',
    boxSizing: 'border-box',
    width: '100%',
    maxWidth: 480,
  },
  sprocketCol: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 32,
    // Dark "film material" — matches the brownish-black border of the
    // reference filmstrip image. Slightly transparent so the fire glow
    // tints it warm at the bottom of the screen.
    backgroundColor: 'rgba(20, 14, 10, 0.92)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 10,
    gap: 14,
    overflow: 'hidden',
    zIndex: 2,
  },
  sprocketHole: {
    width: 18,
    height: 14,
    // Light cream/tan interior matching the reference image's hole color.
    backgroundColor: '#e8d9bd',
    borderRadius: 3,
    flexShrink: 0,
    boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.5)',
  },
  filmstripFrames: {
    backgroundColor: '#0a0a0a',
    padding: '0 34px',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  filmFrame: {
    position: 'relative',
    width: '100%',
    height: 248,
    minHeight: 248,
    maxHeight: 248,
    backgroundColor: '#000',
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    fontFamily: 'inherit',
    cursor: 'pointer',
    padding: 0,
    border: '1px solid #1a1a1a',
    borderRadius: 14,
    overflow: 'hidden',
    transition: 'transform 80ms ease-out, filter 120ms ease-out',
    flexShrink: 0,
    flexGrow: 0,
    boxSizing: 'border-box',
  },
  filmFrameOverlay: {
    position: 'absolute',
    inset: 0,
    background: 'linear-gradient(to bottom, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.4) 50%, rgba(0,0,0,0.75) 100%)',
    pointerEvents: 'none',
    borderRadius: 14,
  },
  // Center label both axes inside the cell. Label is bigger now (48px
  // Jolly Lodger) so it reads from across the room.
  filmFrameContent: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '12px',
    textAlign: 'center',
  },
  filmFrameLabel: {
    fontSize: 48,
    fontFamily: '"Jolly Lodger", system-ui, serif',
    color: '#FFFFFF',
    letterSpacing: '0.04em',
    lineHeight: 1,
    textShadow: '0 0 14px #000, 0 0 24px rgba(0,0,0,0.85), 1px 1px 0 #000, 2px 2px 6px rgba(0,0,0,0.9)',
    // Slow pulse — grows to 1.08x and shrinks back over 3.5s. Centered
    // origin so it scales from the middle.
    animation: 'sinister-cell-title-pulse 3.5s ease-in-out infinite',
    transformOrigin: 'center center',
    display: 'inline-block', // needed for transform on text content
  },
  filmFrameCount: {
    fontSize: 12,
    letterSpacing: '0.24em',
    fontWeight: 700,
    color: '#FFFFFF',
    marginTop: 10,
    textShadow: '0 0 8px #000, 1px 1px 0 #000',
  },

  header: {
    backgroundColor: BLACK,
    // Use iOS safe-area inset to push the header below the status bar/notch
    // and add 18px more breathing room. Falls back to a flat 50px on browsers
    // without env() support.
    paddingTop: 'calc(env(safe-area-inset-top, 32px) + 18px)',
    paddingLeft: 16,
    paddingRight: 16,
    paddingBottom: 18,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    borderBottom: `1px solid ${GRAY_MID}`,
    position: 'relative',
    zIndex: 1,
  },
  backButton: { backgroundColor: 'transparent', padding: '10px 18px', fontSize: 12, fontWeight: 700, letterSpacing: '0.15em', cursor: 'pointer', alignSelf: 'flex-start', borderRadius: 14 },
  categoryViewTitle: {
    fontSize: 44,
    fontWeight: 400,
    letterSpacing: '0.03em',
    fontFamily: '"Jolly Lodger", system-ui, serif',
    lineHeight: 1,
    marginTop: 16,
  },

  categoryGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 14,
    padding: '0 32px',
    width: '100%',
    boxSizing: 'border-box',
  },

  // ---------- State list (drilldown) ----------
  stateListHint: {
    fontSize: 10,
    letterSpacing: '0.3em',
    color: GRAY_MID,
    fontWeight: 700,
    marginTop: 8,
  },
  stateList: {
    position: 'relative',
    zIndex: 1,
    padding: '14px 20px 80px',
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 10,
  },
  stateRow: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    color: BONE,
    fontFamily: 'inherit',
    cursor: 'pointer',
    padding: '12px 14px',
    borderRadius: 12,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    justifyContent: 'center',
    textAlign: 'left',
    minHeight: 60,
  },
  stateRowName: {
    fontSize: 14,
    fontWeight: 600,
    letterSpacing: '0.03em',
    color: '#FFFFFF',
    lineHeight: 1.2,
  },
  stateRowCount: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.18em',
    marginTop: 4,
  },
  categoryTile: {
    // Transparent — the fire effect glows through behind the tiles.
    backgroundColor: 'transparent',
    fontFamily: 'inherit',
    cursor: 'pointer',
    padding: '22px 14px',
    minHeight: 110,
    borderRadius: 18,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    // Smooth transition so the press animation (active state) feels physical.
    transition: 'transform 80ms ease-out, filter 120ms ease-out',
  },
  categoryTileLabel: {
    fontSize: 28,
    fontFamily: '"Jolly Lodger", system-ui, serif',
    color: '#FFFFFF',
    letterSpacing: '0.02em',
    lineHeight: 1.1,
    marginBottom: 8,
    textShadow: `0 0 12px #FFFFFFaa`,
  },
  categoryTileCount: {
    fontSize: 11,
    letterSpacing: '0.2em',
    fontWeight: 700,
    color: '#FFFFFF',
  },

  submitButtonWrap: {
    padding: '20px 32px 0',
    width: '100%',
    boxSizing: 'border-box',
    display: 'flex',
    justifyContent: 'center',
  },
  submitButton: {
    width: '100%',
    padding: '18px',
    // Transparent — fire glows through. The red border + glow is what
    // identifies the button against the dark page.
    backgroundColor: 'transparent',
    color: '#FFFFFF',
    fontFamily: '"Jolly Lodger", system-ui, serif',
    fontSize: 32,
    letterSpacing: '0.04em',
    cursor: 'pointer',
    borderRadius: 18,
    textShadow: `0 0 12px #FFFFFFaa`,
    transition: 'transform 80ms ease-out, filter 120ms ease-out',
  },

  // Submit a Locale — fixed above the social bar so it's always visible.
  // Black fill with a glowing white outline matches the social bar buttons
  // and reads cleanly with the Jolly Lodger font.
  submitFixedButton: {
    position: 'fixed',
    left: '50%',
    bottom: 70,
    transform: 'translateX(-50%)',
    zIndex: 3,
    backgroundColor: 'transparent',
    border: `2px solid ${WHITE}`,
    color: WHITE,
    fontFamily: '"Jolly Lodger", system-ui, serif',
    fontSize: 26,
    letterSpacing: '0.04em',
    padding: '10px 28px',
    borderRadius: 12,
    cursor: 'pointer',
    boxShadow: `0 0 16px ${WHITE}aa, 0 0 32px ${WHITE}55, inset 0 0 12px rgba(255,255,255,0.15)`,
    textShadow: `0 0 10px ${WHITE}, 0 0 18px ${WHITE}88`,
  },
  // Inner span on the submit button so just the TEXT pulses (button frame
  // stays still). Same animation as filmstrip cell titles for consistency.
  submitFixedButtonText: {
    display: 'inline-block',
    animation: 'sinister-cell-title-pulse 3.5s ease-in-out infinite',
    transformOrigin: 'center center',
  },

  socialBar: {
    position: 'fixed',
    left: 0, right: 0,
    bottom: 14,
    zIndex: 2,
    display: 'flex',
    justifyContent: 'center',
    gap: 8,
    padding: '0 12px',
    boxSizing: 'border-box',
  },
  socialBtn: {
    flex: 1,
    maxWidth: 130,
    backgroundColor: 'rgba(0,0,0,0.45)',
    border: `1.5px solid ${WHITE}`,
    color: WHITE,
    fontFamily: 'inherit',
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.05em',
    padding: '10px 8px',
    borderRadius: 14,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    boxShadow: `0 0 10px ${WHITE}33`,
    backdropFilter: 'blur(2px)',
  },
  socialIcon: { fontSize: 14, lineHeight: 1 },
  socialLabel: { fontSize: 12 },

  aboutBody: {
    padding: '20px 24px 80px',
    position: 'relative',
    zIndex: 1,
    color: BONE,
    maxWidth: 600,
    margin: '0 auto',
  },
  aboutPara: { fontSize: 14, lineHeight: 1.6, marginBottom: 14 },
  aboutLinkBtn: {
    width: '100%',
    backgroundColor: 'transparent',
    padding: '14px',
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '0.15em',
    cursor: 'pointer',
    borderRadius: 14,
    fontFamily: 'inherit',
  },

  sitesContainer: { padding: '12px 16px 16px', display: 'flex', flexDirection: 'column', gap: 22, position: 'relative', zIndex: 1 },

  // ---------- Search box (top of locale list when 3+ sites) ----------
  searchWrap: {
    position: 'relative',
    zIndex: 1,
    margin: '14px 16px 0',
    display: 'flex',
    alignItems: 'center',
  },
  searchInput: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    color: BONE,
    border: `1.5px solid ${BLUE}`,
    borderRadius: 14,
    padding: '12px 40px 12px 16px',
    fontSize: 14,
    fontFamily: 'inherit',
    outline: 'none',
    boxShadow: `0 0 12px ${BLUE}33`,
  },
  searchClear: {
    position: 'absolute',
    right: 8,
    top: '50%',
    transform: 'translateY(-50%)',
    background: 'transparent',
    border: 'none',
    color: BONE,
    fontSize: 18,
    cursor: 'pointer',
    padding: '6px 10px',
    fontFamily: 'inherit',
  },
  siteCard: { backgroundColor: BLACK, padding: 0, cursor: 'pointer', textAlign: 'left', color: BONE, fontFamily: 'inherit', overflow: 'hidden', display: 'flex', flexDirection: 'column', borderRadius: 22 },
  siteCardImage: { width: '100%', height: 280, backgroundSize: 'cover', backgroundPosition: 'center' },
  siteCardBody: { padding: '16px 18px 22px' },
  siteCardCategory: { fontSize: 11, letterSpacing: '0.2em', fontWeight: 700, marginBottom: 8 },
  siteCardTitle: { fontSize: 32, fontWeight: 400, fontFamily: '"Jolly Lodger", system-ui, serif', marginBottom: 8, color: BONE, letterSpacing: '0.04em', lineHeight: 1.05 },
  siteCardDesc: { fontSize: 13, lineHeight: 1.5, color: '#BBB' },
  siteCardDistance: { fontSize: 11, marginTop: 12, fontWeight: 700, letterSpacing: '0.15em' },

  emptyState: {
    margin: '40px 32px',
    padding: '32px 20px',
    textAlign: 'center',
    color: GRAY_MID,
    fontSize: 13,
    letterSpacing: '0.05em',
    border: `1px dashed ${GRAY_MID}`,
    borderRadius: 14,
    position: 'relative',
    zIndex: 1,
  },
  emptyStateSub: { marginTop: 10, fontSize: 11, color: GRAY_MID },

  heroImage: { width: 'calc(100% - 32px)', height: 260, backgroundSize: 'cover', backgroundPosition: 'center', margin: '14px 16px', borderRadius: 18, boxSizing: 'border-box', position: 'relative', zIndex: 1 },
  detailBody: { padding: '8px 20px 40px', position: 'relative', zIndex: 1 },
  detailCategory: { fontSize: 12, letterSpacing: '0.2em', fontWeight: 700, marginBottom: 10 },
  detailTitle: { fontSize: 56, fontWeight: 400, fontFamily: '"Jolly Lodger", system-ui, serif', lineHeight: 1.05, marginBottom: 14, color: BONE, letterSpacing: '0.03em' },
  detailDistance: { fontSize: 13, fontWeight: 700, marginBottom: 18, letterSpacing: '0.15em' },
  detailDivider: { height: 2, margin: '18px 0', borderRadius: 2 },
  detailDescription: { fontSize: 15, lineHeight: 1.65, color: BONE },
  detailPara: { marginBottom: 16 },
  directionsButton: { width: '100%', backgroundColor: 'transparent', padding: '16px', fontSize: 14, fontWeight: 900, letterSpacing: '0.15em', cursor: 'pointer', marginTop: 18, fontFamily: 'inherit', borderRadius: 16 },
  imageCredit: { fontSize: 10, color: GRAY_MID, textAlign: 'center', marginTop: 18, letterSpacing: '0.15em' },

  formBody: { padding: '16px 20px 60px', display: 'flex', flexDirection: 'column', gap: 18, position: 'relative', zIndex: 1, maxWidth: '100%', overflowX: 'hidden', boxSizing: 'border-box' },
  formIntro: { fontSize: 12, color: GRAY_MID, lineHeight: 1.5, letterSpacing: '0.03em', textAlign: 'center', margin: '4px 0 8px' },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  fieldLabelRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' },
  fieldLabel: { fontSize: 11, color: BONE, letterSpacing: '0.2em', fontWeight: 700, textTransform: 'uppercase' },
  fieldStatus: { fontSize: 14, fontWeight: 900 },
  fieldHint: { fontSize: 10, color: GRAY_MID, letterSpacing: '0.05em', marginTop: 2 },
  input: {
    backgroundColor: GRAY_DARK,
    color: BONE,
    border: `1.5px solid ${GRAY_MID}`,
    borderRadius: 12,
    padding: '12px 14px',
    fontSize: 14,
    fontFamily: 'inherit',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
    wordBreak: 'break-word',
    overflowWrap: 'anywhere',
    minWidth: 0,
  },
  textarea: { resize: 'vertical', minHeight: 110, lineHeight: 1.5 },
  locModeRow: { display: 'flex', gap: 8 },
  locModeBtn: {
    flex: 1,
    backgroundColor: 'transparent',
    padding: '10px',
    fontSize: 12,
    fontFamily: 'inherit',
    fontWeight: 700,
    letterSpacing: '0.1em',
    borderRadius: 12,
    cursor: 'pointer',
  },
  gpsReadout: { fontSize: 12, color: BONE, fontFamily: 'Menlo, monospace', padding: '8px 4px' },
  manualRow: { display: 'flex', gap: 8 },
  photoBtn: {
    width: '100%',
    backgroundColor: 'transparent',
    padding: '14px',
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '0.15em',
    cursor: 'pointer',
    borderRadius: 14,
    fontFamily: 'inherit',
  },
  photoPreview: {
    width: '100%',
    maxHeight: 240,
    objectFit: 'cover',
    borderRadius: 14,
    marginTop: 10,
    border: `2px solid ${GRAY_MID}`,
  },
  errorBox: {
    backgroundColor: '#3A0F0F',
    color: '#FFB3B3',
    padding: '12px 14px',
    fontSize: 12,
    borderRadius: 10,
    border: '1px solid #5A1F1F',
    letterSpacing: '0.03em',
  },
  submitFinalBtn: {
    width: '100%',
    padding: '16px',
    backgroundColor: BLACK,
    fontSize: 14,
    fontWeight: 900,
    letterSpacing: '0.2em',
    fontFamily: 'inherit',
    borderRadius: 16,
    marginTop: 8,
  },
};
