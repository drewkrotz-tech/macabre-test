// @ts-ignore — Vite handles .ttf imports as URL strings
declare module '*.ttf' { const url: string; export default url; }
declare module '*.png' { const url: string; export default url; }

import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  startGeofencing,
  stopGeofencing,
  requestPermissions,
  distanceMeters,
  setSites,
} from './geofencing';
import LivingHellFontUrl from './assets/Living Hell.ttf';
import SlideMountUrl from './assets/slide-mount.png';

// Register the Living Hell font face once at module load.
if (typeof document !== 'undefined' && !document.getElementById('__livinghell-fontface')) {
  const style = document.createElement('style');
  style.id = '__livinghell-fontface';
  style.textContent = `@font-face { font-family: 'LivingHell'; src: url('${LivingHellFontUrl}') format('truetype'); font-display: block; }`;
  document.head.appendChild(style);
}
import { SINISTER_SITES as FALLBACK_SITES, SinisterSite } from './locations';

// ---------- Production server URL ----------
const API_BASE = 'https://api.sinistertrivia.com';

// ---------- Device identity (handle system) ----------
// Auto-generated stable id stored on first launch. Used to prove ownership of
// a claimed handle. Persists across app restarts; wipes on app reinstall.
// Storage: Capacitor Preferences on native, localStorage on web.
const DEVICE_ID_KEY = 'sinister_device_id';

function generateDeviceId(): string {
  // RFC4122-ish v4. Not cryptographic — server doesn't trust id alone, only
  // the (handle, deviceId) pair.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `device_${hex.slice(0, 8)}_${hex.slice(8, 16)}_${hex.slice(16, 24)}_${hex.slice(24, 32)}`;
}

async function readPersistent(key: string): Promise<string | null> {
  try {
    const cap = (window as any).Capacitor;
    if (cap?.isNativePlatform?.() && cap?.Plugins?.Preferences) {
      const { value } = await cap.Plugins.Preferences.get({ key });
      return value || null;
    }
  } catch { /* fall through */ }
  try { return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null; }
  catch { return null; }
}

async function writePersistent(key: string, value: string): Promise<void> {
  try {
    const cap = (window as any).Capacitor;
    if (cap?.isNativePlatform?.() && cap?.Plugins?.Preferences) {
      await cap.Plugins.Preferences.set({ key, value });
      return;
    }
  } catch { /* fall through */ }
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, value); }
  catch { /* silent */ }
}

async function getOrCreateDeviceId(): Promise<string> {
  const existing = await readPersistent(DEVICE_ID_KEY);
  if (existing && existing.length >= 8) return existing;
  const fresh = generateDeviceId();
  await writePersistent(DEVICE_ID_KEY, fresh);
  return fresh;
}

// ---------- Handle API client ----------
type HandleCheckResult = { available: boolean; reason?: string };
type HandleClaimResult = { ok: boolean; handle?: string; reason?: string; existingHandle?: string };

async function apiCheckHandle(handle: string): Promise<HandleCheckResult> {
  try {
    const res = await fetch(`${API_BASE}/handles/check/${encodeURIComponent(handle)}`);
    return await res.json();
  } catch { return { available: false, reason: 'network error' }; }
}

async function apiClaimHandle(handle: string, deviceId: string): Promise<HandleClaimResult> {
  try {
    const res = await fetch(`${API_BASE}/handles/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, deviceId }),
    });
    return await res.json();
  } catch { return { ok: false, reason: 'network error' }; }
}

async function apiGetMyHandle(deviceId: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/handles/me?deviceId=${encodeURIComponent(deviceId)}`);
    const data = await res.json();
    return data?.handle || null;
  } catch { return null; }
}

// ---------- Visit-claim API ----------
// POST /visits — server checks (handle, deviceId) ownership, verifies the
// reported lat/lng is within 100m of the site's coords, dedupes (one visit
// per handle per site), and records to visits.json. Returns:
//   { ok: true }                       on a fresh claim
//   { ok: true, alreadyClaimed: true } if the user previously claimed this site
//   { ok: false, code, ... }           otherwise (too_far, unknown_site, etc.)
type VisitClaimResult =
  | { ok: true; alreadyClaimed?: boolean }
  | { ok: false; code: string; distance?: number; message?: string };

async function apiClaimVisit(args: {
  handle: string;
  deviceId: string;
  siteId: string;
  lat: number;
  lng: number;
}): Promise<VisitClaimResult> {
  try {
    const res = await fetch(`${API_BASE}/visits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await res.json().catch(() => ({}));
    // 409 == already claimed; the server treats this as idempotent and so do we.
    if (res.status === 409 || data?.code === 'already_claimed') {
      return { ok: true, alreadyClaimed: true };
    }
    if (!res.ok) {
      return { ok: false, code: data?.code || `http_${res.status}`, distance: data?.distance, message: data?.error };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, code: 'network', message: err?.message || 'Network error' };
  }
}

// Returns the set of siteIds the handle has visited. Used at app startup
// to mark already-visited sites in DetailView without a per-detail roundtrip.
async function apiGetMyVisits(handle: string): Promise<Set<string>> {
  try {
    const res = await fetch(`${API_BASE}/visits/${encodeURIComponent(handle)}`);
    const data = await res.json();
    const ids = (data?.visits || []).map((v: any) => v.siteId).filter(Boolean);
    return new Set(ids);
  } catch { return new Set(); }
}

// ---------- Leaderboard + Badges API ----------
// The server exposes two leaderboard endpoints (top submitters and top
// visitors) plus a per-handle badges endpoint. All public, no auth.
//
// Leaderboards return a ranked list of { handle, count }. Badges returns
// a flat list of { id, label, kind, threshold? } for whatever the handle
// has earned.
type LeaderRow = { handle: string; count: number };
type BadgeRow = {
  id: string;
  label: string;
  kind: 'submitter' | 'visitor' | string;
  threshold?: number;
  category?: string;
  // Server-provided emoji or short symbol. Falls back to a generic star if
  // missing so older API responses still render. Using emojis keeps this
  // theme-able from the server without shipping new app assets.
  icon?: string;
};

async function apiLeaderboardSubmitters(limit = 25): Promise<LeaderRow[]> {
  try {
    const res = await fetch(`${API_BASE}/leaderboard/submitters?limit=${limit}`);
    const data = await res.json();
    const rows = data?.entries || data?.leaderboard || data?.rows || data?.results || [];
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

async function apiLeaderboardVisitors(limit = 25): Promise<LeaderRow[]> {
  try {
    const res = await fetch(`${API_BASE}/leaderboard/visitors?limit=${limit}`);
    const data = await res.json();
    const rows = data?.entries || data?.leaderboard || data?.rows || data?.results || [];
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

async function apiGetBadges(handle: string): Promise<{ badges: BadgeRow[]; submitCount: number; visitCount: number }> {
  try {
    const res = await fetch(`${API_BASE}/badges/${encodeURIComponent(handle)}`);
    const data = await res.json();
    const list = data?.badges || [];
    return {
      badges: Array.isArray(list) ? list : [],
      submitCount: typeof data?.submitCount === 'number' ? data.submitCount : 0,
      visitCount: typeof data?.visitCount === 'number' ? data.visitCount : 0,
    };
  } catch { return { badges: [], submitCount: 0, visitCount: 0 }; }
}

// ---------- Live site fetch ----------
// The server's /sites endpoint returns approved locales. Each site has the
// shape { id, title, shortDescription, fullDescription, category, state,
// coords:{lat,lng}, photoUrl, submitter, verified, approvedAt }.
//
// The app's SinisterSite type uses `imageUrl`, so we map photoUrl -> imageUrl
// here. We also fill imageCredit with the submitter handle for attribution.
//
// Submitter and approvedAt are passed through as extra fields on each site
// object so the detail page can render a "Submitted by @x · date" credit.
// These aren't in the base SinisterSite type imported from ./locations
// (which is the bundled-fallback shape), so we cast — at runtime the
// fields are present whenever the server returns them.
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
      // Pass-through fields for detail-page submitter credit. Optional —
      // legacy seeded sites may not have them; the detail page handles
      // both cases (shows "Submitted by Sinister" if submitter missing,
      // omits the date if approvedAt missing).
      submitter: s.submitter || null,
      approvedAt: s.approvedAt || null,
    } as SinisterSite & { submitter: string | null; approvedAt: string | null }));
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
// ---------- Audio system ----------
// ONE AudioContext for the whole app. All file-based sounds (slide, button,
// back, bell) and synth sounds (playForward, playPop, playSubDrop,
// playGhostWisp) share it, each with its own GainNode for volume control.
//
// History: the app used to create FIVE separate AudioContexts (one per
// sound family). Safari/WKWebView caps the number of contexts an app can
// create, so the 5th sometimes silently failed — that's what made
// "sometimes opening the app means no sound" non-deterministic. Single
// shared context fixes that.
//
// On iOS first-tap-silence:
//   iOS requires audio playback to happen inside a user-gesture handler
//   to unlock the AudioContext. The standard workaround is to play a
//   silent 1-sample buffer inside the first gesture so the first real
//   sound isn't sacrificed — but that "silent unlock buffer" was
//   instead silencing Drew's actual first tap (it occupied the slot the
//   real sound wanted). Per Drew's prior trivia app experience,
//   TestFlight may artificially silence the first audio play on cold
//   launch in a way production App Store builds don't. So we keep
//   things simple: just resume() the context on every use and on
//   foreground transitions. If iOS swallows the first sound on cold
//   launch in TestFlight, we live with it; production behavior may
//   differ.

let _audioCtx: AudioContext | null = null;
let _audioUnlockInstalled = false;

function getAudioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!_audioCtx) {
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    try {
      _audioCtx = new Ctor();
    } catch {
      return null;
    }
  }
  // resume() is a no-op if the context is already running. Safe to call
  // every time we hand out the context. Inside a real user gesture event
  // handler (which is where the play* functions are called from), this
  // is what unlocks iOS audio.
  if (_audioCtx.state === 'suspended') {
    _audioCtx.resume().catch(() => { /* silent */ });
  }
  return _audioCtx;
}

// Install a global lifecycle handler that resumes the AudioContext on
// every foreground transition (visibility / focus / pageshow). This
// keeps audio working when the user comes back to the app from the
// home screen, the lock screen, or a phone call.
//
// Importantly we do NOT play a silent buffer here. That was the previous
// approach and it was muting the user's first real sound by occupying
// the audio slot. Just resume() — that's enough for iOS.
function installAudioUnlock() {
  if (_audioUnlockInstalled || typeof window === 'undefined') return;
  _audioUnlockInstalled = true;

  const resumeOnReturn = () => {
    const ctx = _audioCtx;
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => { /* silent */ });
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resumeOnReturn();
  });
  window.addEventListener('focus', resumeOnReturn);
  window.addEventListener('pageshow', resumeOnReturn);
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

// Small rising pop — used when the map preview card slides up after a pin
// tap. Pitch sweeps up from 400 to 700 Hz over ~70ms with a quick attack
// and ~110ms exponential decay. Quieter than playBack so it sits as a
// subtle confirmation rather than a navigation cue. Mirroring the upward
// motion of the card with an upward pitch gesture makes the moment feel
// connected rather than arbitrary.
function playPop() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(400, now);
    osc.frequency.exponentialRampToValueAtTime(700, now + 0.07);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.16, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.11);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.13);
  } catch { /* silent */ }
}

// ---------- Bottom-bar / menu sounds ----------
// playSubDrop — deep bass thud for the bottom-bar pill buttons
// (Locations Near Me + the menu items in the More popup). Sine wave
// pitched from 140Hz down to 45Hz over 220ms. No high-frequency
// content, all weight, fits the "sinister/foreboding" tone the rest
// of the app sets. Uses the shared getAudioCtx() singleton so it
// inherits the same iOS resume/unlock flow that playButton/playPop
// already rely on.
function playSubDrop() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, now);
    osc.frequency.exponentialRampToValueAtTime(45, now + 0.18);
    gain.gain.setValueAtTime(0, now);
    // Bumped from 0.22 to 0.55 at Drew's request — Sub Drop was too quiet
    // against ambient room/phone-speaker noise. 0.55 sits comfortably below
    // 1.0 to leave headroom against any concurrent UI sounds (back/bell)
    // without clipping the iOS speaker.
    gain.gain.linearRampToValueAtTime(0.55, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.25);
  } catch { /* silent */ }
}

// playGhostWisp — rising bandpass-filtered noise burst for the More
// menu OPEN action specifically. Different from playSubDrop so that
// opening the menu sounds different from picking an item out of it,
// giving the user a small audible cue that something appeared rather
// than that they navigated. ~220ms of breathy whoosh sweeping from
// 600Hz up to 2.4kHz.
function playGhostWisp() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const dur = 0.22;
    const buf = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * dur)), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      // Sine envelope so the noise fades in and out smoothly
      const env = Math.sin(Math.PI * (i / data.length));
      data[i] = (Math.random() * 2 - 1) * env;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.setValueAtTime(600, now);
    filt.frequency.exponentialRampToValueAtTime(2400, now + 0.18);
    filt.Q.value = 4;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.55, now);
    src.connect(filt);
    filt.connect(gain);
    gain.connect(ctx.destination);
    src.start(now);
  } catch { /* silent */ }
}

// ---------- File-based sounds (slide / button / back / bell) ----------
// All four file-based sounds share the same _audioCtx (see top of audio
// section). Each gets its own decoded AudioBuffer + GainNode for volume
// control, but they all connect to the same destination — so we never
// hit iOS's per-app AudioContext cap.
//
// Each sound has an init function that fetches + decodes once. Init is
// idempotent. The play function fires synchronously inside the user's
// tap event so iOS doesn't drop the sample. If the context is suspended
// (post-background, etc.), we resume() and fire on the resolution.
//
// HTMLAudioElement fallbacks were dropped: on iOS WebView they ignore
// volume settings AND drop mid-decode play() calls. They were causing
// more bugs than they prevented.

const SLIDE_VOLUME = 0.05;
const BUTTON_VOLUME = 0.20;
const BACK_VOLUME = 0.20;
const BELL_VOLUME = 0.30;

interface FileSoundSlot {
  url: string;
  volume: number;
  buffer: AudioBuffer | null;
  gain: GainNode | null;
  // Raw ArrayBuffer fetched eagerly on app load, before any user gesture.
  // Fetching audio bytes does NOT require an AudioContext — only
  // decodeAudioData and playback do. Pre-fetching here means the first
  // tap doesn't race a network round trip.
  rawBytes: ArrayBuffer | null;
  fetchStarted: boolean;
  initStarted: boolean;
}

const _fileSounds: Record<'slide' | 'button' | 'back' | 'bell', FileSoundSlot> = {
  slide:  { url: slideSound1, volume: SLIDE_VOLUME,  buffer: null, gain: null, rawBytes: null, fetchStarted: false, initStarted: false },
  button: { url: buttonSound, volume: BUTTON_VOLUME, buffer: null, gain: null, rawBytes: null, fetchStarted: false, initStarted: false },
  back:   { url: backSound,   volume: BACK_VOLUME,   buffer: null, gain: null, rawBytes: null, fetchStarted: false, initStarted: false },
  bell:   { url: bellSound,   volume: BELL_VOLUME,   buffer: null, gain: null, rawBytes: null, fetchStarted: false, initStarted: false },
};

// Phase 1: fetch the raw audio bytes. Doesn't need AudioContext, can run
// at any time including app boot before any user gesture. Idempotent.
function prefetchFileSound(key: 'slide' | 'button' | 'back' | 'bell') {
  const slot = _fileSounds[key];
  if (slot.fetchStarted) return;
  slot.fetchStarted = true;
  fetch(slot.url)
    .then(r => r.arrayBuffer())
    .then(ab => { slot.rawBytes = ab; })
    .catch(() => { slot.fetchStarted = false; /* allow retry */ });
}

// Pre-fetch all four sound files at module load. By the time the user
// takes their first tap (which unlocks the AudioContext and decodes the
// already-fetched bytes), the network round trip is already done.
if (typeof window !== 'undefined') {
  // Defer slightly so we don't block React's initial render on these
  // four extra HTTP requests. setTimeout 0 puts them after first paint.
  setTimeout(() => {
    prefetchFileSound('slide');
    prefetchFileSound('button');
    prefetchFileSound('back');
    prefetchFileSound('bell');
  }, 0);
}

// Phase 2: decode the bytes into an AudioBuffer + create the GainNode.
// Requires AudioContext, runs lazily on first play (post-unlock).
function ensureFileSound(key: 'slide' | 'button' | 'back' | 'bell') {
  const slot = _fileSounds[key];
  if (slot.initStarted) return;
  // Make sure phase 1 has at least started — if for some reason the
  // module-load prefetch didn't run yet, kick it off.
  prefetchFileSound(key);
  const ctx = getAudioCtx();
  if (!ctx) return;
  // Need the raw bytes to decode. If they haven't arrived yet, leave
  // initStarted=false and try again on next play.
  if (!slot.rawBytes) return;
  slot.initStarted = true;
  try {
    slot.gain = ctx.createGain();
    slot.gain.gain.value = slot.volume;
    slot.gain.connect(ctx.destination);
    // decodeAudioData mutates the ArrayBuffer in some engines, so we
    // pass a copy and clear the original after decode.
    const bytesCopy = slot.rawBytes.slice(0);
    ctx.decodeAudioData(bytesCopy)
      .then(buf => {
        slot.buffer = buf;
        slot.rawBytes = null; // free the raw bytes once decoded
      })
      .catch(() => { slot.initStarted = false; /* allow retry */ });
  } catch { /* silent */ }
}

function playFileSound(key: 'slide' | 'button' | 'back' | 'bell') {
  const slot = _fileSounds[key];
  // Lazy-init the decode + gain chain on first call.
  ensureFileSound(key);
  const ctx = _audioCtx;
  if (!ctx || !slot.buffer || !slot.gain) return;
  const buffer = slot.buffer;
  const gain = slot.gain;
  const fire = () => {
    try {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(gain);
      src.start(0);
    } catch { /* silent */ }
  };
  // If the context is running, fire SYNCHRONOUSLY in the same tap event
  // so iOS doesn't drop the sample for being outside the user gesture.
  // Only defer via resume() if actually suspended.
  if (ctx.state === 'running') {
    fire();
  } else {
    ctx.resume().then(fire).catch(() => { /* silent */ });
  }
}

function playSlide()      { playFileSound('slide'); }
function playButton()     { playFileSound('button'); }
function playBackSound()  { playFileSound('back'); }
function playBell()       { playFileSound('bell'); }


// ---------- CategoryView scroll memory ----------
// CategoryView's filmstrip uses an internal scroll container (the
// overflowY-auto wrapper around the looping cells), which means
// window.scrollY ignores it. To preserve the user's position when they
// open a site → swipe back, we save scrollTop on tap-out and restore
// it on next CategoryView mount.
//
// Why a Map keyed by category+state instead of a single slot: during a
// swipe-back gesture CategoryView mounts TWICE in quick succession (once
// in the peek layer, once in the real wrapper). A single-slot value with
// timer-based clearing creates a race where the second mount can read
// either the saved value or null depending on subtle timing. With a Map
// keyed by category, the entry stays put across both mounts and is only
// overwritten the next time the user taps into a site from that same
// category. No timers, no races. Module-level so the saving component
// instance and the receiving component instance share the same storage.
const _categoryScrollMap: Map<string, number> = new Map();
// Flip to true and rebuild to get a torrent of diagnostic logs in
// Safari Web Inspector. Tags every save/restore/clear with the category
// key and scrollTop so you can see exactly which path fires when.
const _CAT_SCROLL_DEBUG = false;
function _catScrollLog(...args: unknown[]) {
  if (_CAT_SCROLL_DEBUG) console.log('[catScroll]', ...args);
}

// ---------- ListView drill-down memory ----------
// ListView has three internal levels (Categories -> States -> Sites)
// implemented as local component state, NOT separate views in the nav
// stack. That made the drill-down feel snappy but also meant tapping a
// site at level 3 -> swiping back from DetailView -> ListView would
// remount and reset to level 1 (Categories), losing the user's place.
//
// Same pattern as _categoryScrollMap: store the last-known level at
// module scope so the swipe-back-induced double remount of ListView
// (once in peek layer, once in real wrapper) both pick up the same
// value. Reset to top-level when ListView is opened fresh from outside
// (handled inside ListView itself via the back button at level 1).
type _ListLevelSnapshot =
  | { kind: 'categories' }
  | { kind: 'states'; category: CategoryKey }
  | { kind: 'sites'; category: CategoryKey; state: string };
let _listLevelMemory: _ListLevelSnapshot | null = null;
// Hook the swipe-back gesture uses to step ListView's internal drill-down
// back one level (sites -> states -> categories) instead of popping the
// nav stack and exiting to home. Set by ListView on mount, cleared on
// unmount. When non-null, returning true means "we handled it, don't pop
// the nav stack." Returning false means "I'm at the top level, please
// pop normally."
let _listSwipeBackHook: (() => boolean) | null = null;

// ---------- Toasts ----------
// Lightweight global toast system. Any component can call showToast(msg)
// and a small notification slides up from above the bottom bar for ~2.5
// seconds, then auto-dismisses. Used today for visit-claim success but
// any future "soft confirmation" can use it too.
//
// Why a custom event instead of context/props: keeps deeply-nested
// components (like DetailView's I'm Here button) decoupled from the App
// root. They just shout into the void; the App's Toast renderer listens.
type ToastTone = 'default' | 'success' | 'error';
type ToastDetail = { message: string; tone: ToastTone; durationMs: number };
const TOAST_EVENT = 'sinister:toast';
function showToast(message: string, tone: ToastTone = 'default', durationMs = 2500) {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent<ToastDetail>(TOAST_EVENT, {
      detail: { message, tone, durationMs },
    }));
  } catch { /* silent */ }
}

// ---------- Audio lifecycle ----------
// All audio lifecycle logic now lives in installAudioUnlock() at the top
// of the audio section. Single shared AudioContext means we only have to
// resume one thing on foreground/visibility/gesture events — no need for
// the previous wakeAllAudio() loop over multiple contexts.


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
  { key: 'historical', label: 'Grave Sites',    gridIndex: 5, cascadeOrder: 3, borderColor: TILE_RED, image: cellHistorical },
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

/* Skeleton loader pulse — shifts a lighter band across the placeholder
   rectangle, conveying "this is loading" without a spinner. */
@keyframes sinister-skeleton-pulse {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* Toast slide-in — small upward fade for the visit-success notification
   and any other showToast() calls. Fast, unobtrusive. */
@keyframes sinister-toast-in {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
.sinister-toast {
  animation: sinister-toast-in 200ms ease-out;
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

/* Spotlight pulse — gentle box-shadow + opacity breathing for the
   "Latest Submission" banner on the home page. Centered scale included
   so the badge breathes subtly without shifting the surrounding layout
   (it's absolutely positioned, so a 1.5% scale doesn't disturb anything).
   Slow 4.5s cycle so it reads as ambient rather than attention-grabbing. */
@keyframes sinister-spotlight-pulse {
  0%, 100% {
    box-shadow: 0 0 14px ${SINISTER_RED}33, 0 0 4px ${BLACK}99;
    transform: translateX(-50%) scale(1);
  }
  50% {
    box-shadow: 0 0 26px ${SINISTER_RED}66, 0 0 8px ${BLACK}99;
    transform: translateX(-50%) scale(1.015);
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

  // ---- Projector / slide-mount visual effects ----
  // Used by StateListView (the projector page). The grain is an SVG
  // turbulence pattern repeated and slowly offset; the flicker is a
  // black overlay whose opacity pulses unpredictably.
  css += `
/* Hide horizontal scrollbar on the slide filmstrip on WebKit */
.sinister-pressable::-webkit-scrollbar { display: none; }

/* Hide the iOS document scroll indicator on specific views only.
   Body gets data-view="detail" / "about" / "leaders" set by a small
   effect when those views mount, and reverts on unmount. The home
   filmstrip and other internal scroll containers are untouched
   because they aren't the document scroller.

   Belt-and-suspenders approach because iOS WKWebView's scroll
   indicator can appear via different paths depending on iOS version:
   - ::-webkit-scrollbar (older WebKit-style scrollbar)
   - ::-webkit-scrollbar-thumb / -track (the parts of the same)
   - scrollbar-width: none (Firefox and modern WebKit)
   - The native iOS overlay scrollbar (this is the thin grey one
     that briefly appears during scroll). It can't be hidden via
     CSS in all iOS versions, but recent versions DO honor
     scrollbar-width: none on the scrolling element. */
body[data-view="detail"]::-webkit-scrollbar,
body[data-view="about"]::-webkit-scrollbar,
body[data-view="leaders"]::-webkit-scrollbar,
body[data-view="detail"]::-webkit-scrollbar-thumb,
body[data-view="about"]::-webkit-scrollbar-thumb,
body[data-view="leaders"]::-webkit-scrollbar-thumb,
body[data-view="detail"]::-webkit-scrollbar-track,
body[data-view="about"]::-webkit-scrollbar-track,
body[data-view="leaders"]::-webkit-scrollbar-track,
html[data-view="detail"]::-webkit-scrollbar,
html[data-view="about"]::-webkit-scrollbar,
html[data-view="leaders"]::-webkit-scrollbar {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
  -webkit-appearance: none !important;
  background: transparent !important;
}
body[data-view="detail"],
body[data-view="about"],
body[data-view="leaders"],
html[data-view="detail"],
html[data-view="about"],
html[data-view="leaders"] {
  scrollbar-width: none !important;
  -ms-overflow-style: none !important;
}

/* Animated film grain — used inside the .projector-grain layer */
.projector-grain {
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.55 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");
  background-size: 180px 180px;
  animation: projector-grain-shift 600ms steps(8) infinite;
}
@keyframes projector-grain-shift {
  0%   { background-position: 0 0; }
  20%  { background-position: -40px 30px; }
  40%  { background-position: 30px -50px; }
  60%  { background-position: -60px 10px; }
  80%  { background-position: 50px 40px; }
  100% { background-position: 0 0; }
}

/* Subtle projector flicker — black overlay pulses opacity */
.projector-flicker {
  animation: projector-flicker-pulse 4.7s infinite;
  opacity: 0;
}
@keyframes projector-flicker-pulse {
  0%, 100% { opacity: 0; }
  3%   { opacity: 0.06; }
  4%   { opacity: 0; }
  47%  { opacity: 0.04; }
  48%  { opacity: 0; }
  73%  { opacity: 0.08; }
  74%  { opacity: 0; }
}

/* Drifting dust speckles — small bright dots that slowly move. Sells
   the projector beam by hinting at floating particles in the light. */
.projector-dust {
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400'><circle cx='30' cy='80' r='0.7' fill='%23fff' opacity='0.6'/><circle cx='120' cy='40' r='0.5' fill='%23fff' opacity='0.4'/><circle cx='220' cy='160' r='0.8' fill='%23fff' opacity='0.7'/><circle cx='340' cy='90' r='0.5' fill='%23fff' opacity='0.5'/><circle cx='80' cy='270' r='0.6' fill='%23fff' opacity='0.6'/><circle cx='180' cy='340' r='0.4' fill='%23fff' opacity='0.4'/><circle cx='290' cy='240' r='0.7' fill='%23fff' opacity='0.6'/><circle cx='370' cy='320' r='0.5' fill='%23fff' opacity='0.5'/></svg>");
  background-size: 400px 400px;
  animation: projector-dust-drift 22s linear infinite;
}
@keyframes projector-dust-drift {
  0%   { background-position: 0 0; }
  100% { background-position: 400px 200px; }
}

/* Vertical jitter line — sweeps down the projection occasionally,
   simulating a film frame skip / vertical sync glitch. */
.projector-jitter::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent 0%, rgba(255,200,150,0.6) 50%, transparent 100%);
  animation: projector-jitter-sweep 1.2s ease-in 0.4s 1;
  top: -10px;
}
@keyframes projector-jitter-sweep {
  0%   { top: -10px; opacity: 0; }
  10%  { opacity: 1; }
  90%  { opacity: 1; }
  100% { top: 110%; opacity: 0; }
}

/* Bright flash — random infrequent warm pulse, simulates a slide
   change overexposure or a projector lamp surge. */
.projector-flash {
  animation: projector-flash-pulse 11s infinite;
}
@keyframes projector-flash-pulse {
  0%, 100% { opacity: 0; }
  35%      { opacity: 0; }
  35.5%    { opacity: 0.18; }
  36%      { opacity: 0; }
  82%      { opacity: 0; }
  82.3%    { opacity: 0.12; }
  82.6%    { opacity: 0; }
}

/* Hide the filmstrip's WebKit scrollbar */
.projector-filmstrip::-webkit-scrollbar { display: none; }
.state-pager::-webkit-scrollbar { display: none; }

/* ===== Projected-image glitch =====
   Three image layers stacked behind the main image: red-shifted, cyan-shifted,
   and a vertical-offset jitter layer. Modeled on .sinister-glitch (the home
   title's chromatic-aberration effect) but applied to images via duplicate
   absolute layers instead of pseudo-elements/attr(data-text).
   Long quiet stretches with brief glitch bursts so it reads as occasional
   malfunction, matching the title's rhythm. */
.projector-glitch-red {
  animation: projector-glitch-red 4.2s infinite steps(1);
}
.projector-glitch-cyan {
  animation: projector-glitch-cyan 4.2s infinite steps(1);
}
.projector-glitch-jitter {
  animation: projector-glitch-jitter 4.2s infinite steps(1);
}
@keyframes projector-glitch-red {
  0%, 100%   { transform: translate(0, 0); clip-path: inset(0 0 0 0); opacity: 0; }
  3%         { transform: translate(3px, 0); clip-path: inset(15% 0 70% 0); opacity: 0.85; }
  3.5%       { transform: translate(3px, 0); clip-path: inset(60% 0 25% 0); opacity: 0.85; }
  4.2%       { transform: translate(0, 0); opacity: 0; }
  17%        { transform: translate(2px, 0); clip-path: inset(25% 0 55% 0); opacity: 0.85; }
  17.6%      { transform: translate(0, 0); opacity: 0; }
  31%        { transform: translate(4px, 0); clip-path: inset(40% 0 40% 0); opacity: 0.85; }
  31.6%      { transform: translate(0, 0); opacity: 0; }
  48%        { transform: translate(3px, 0); clip-path: inset(8% 0 70% 0); opacity: 0.85; }
  48.5%      { transform: translate(3px, 0); clip-path: inset(55% 0 22% 0); opacity: 0.85; }
  49.1%      { transform: translate(0, 0); opacity: 0; }
  68%        { transform: translate(2px, 1px); clip-path: inset(8% 0 78% 0); opacity: 0.85; }
  68.7%      { transform: translate(2px, 0); clip-path: inset(72% 0 12% 0); opacity: 0.85; }
  69.5%      { transform: translate(0, 0); opacity: 0; }
  84%        { transform: translate(3px, 0); clip-path: inset(35% 0 35% 0); opacity: 0.85; }
  84.6%      { transform: translate(0, 0); opacity: 0; }
}
@keyframes projector-glitch-cyan {
  0%, 100%   { transform: translate(0, 0); clip-path: inset(0 0 0 0); opacity: 0; }
  3%         { transform: translate(-3px, 0); clip-path: inset(60% 0 25% 0); opacity: 0.85; }
  3.5%       { transform: translate(-3px, 0); clip-path: inset(15% 0 70% 0); opacity: 0.85; }
  4.2%       { transform: translate(0, 0); opacity: 0; }
  17%        { transform: translate(-2px, 0); clip-path: inset(55% 0 25% 0); opacity: 0.85; }
  17.6%      { transform: translate(0, 0); opacity: 0; }
  31%        { transform: translate(-4px, 0); clip-path: inset(40% 0 40% 0); opacity: 0.85; }
  31.6%      { transform: translate(0, 0); opacity: 0; }
  48%        { transform: translate(-3px, 0); clip-path: inset(55% 0 22% 0); opacity: 0.85; }
  48.5%      { transform: translate(-3px, 0); clip-path: inset(8% 0 70% 0); opacity: 0.85; }
  49.1%      { transform: translate(0, 0); opacity: 0; }
  68%        { transform: translate(-2px, -1px); clip-path: inset(72% 0 12% 0); opacity: 0.85; }
  68.7%      { transform: translate(-2px, 0); clip-path: inset(8% 0 78% 0); opacity: 0.85; }
  69.5%      { transform: translate(0, 0); opacity: 0; }
  84%        { transform: translate(-3px, 0); clip-path: inset(35% 0 35% 0); opacity: 0.85; }
  84.6%      { transform: translate(0, 0); opacity: 0; }
}
@keyframes projector-glitch-jitter {
  0%, 100%   { transform: translate(0, 0); }
  3%         { transform: translate(0, 1px); }
  3.5%       { transform: translate(0, -1px); }
  4.2%       { transform: translate(0, 0); }
  31%        { transform: translate(0, 1px); }
  31.6%      { transform: translate(0, 0); }
  68%        { transform: translate(1px, 0); }
  68.7%      { transform: translate(-1px, 0); }
  69.5%      { transform: translate(0, 0); }
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
  | { name: 'category'; category: CategoryKey; state?: string }
  | { name: 'detail'; site: SinisterSite }
  | { name: 'submit' }
  | { name: 'about' }
  | { name: 'leaders' }
  | { name: 'badges'; handle: string }
  | { name: 'nearby' }
  | { name: 'list' };

export default function App() {
  const [view, _setViewRaw] = useState<View>({ name: 'home' });
  // Navigation history stack — every time setView is called, the previous
  // view gets pushed here so swipe-right can pop back to it. We also stash
  // the scroll position at navigation time so goBack() can restore it,
  // letting the user return exactly where they left off on long pages
  // (List View, Dread Leaders, CategoryView, etc.).
  type HistoryEntry = { view: View; scrollY: number };
  const _navHistory = useRef<HistoryEntry[]>([]);
  // Pending scroll restore — populated by goBack() and consumed by a
  // post-render effect once the new view has actually painted. We can't
  // scroll inside goBack itself because the new view's content isn't in
  // the DOM yet at that moment.
  const _pendingScrollRestore = useRef<number | null>(null);
  const setView = (next: View) => {
    const sy = (typeof window !== 'undefined')
      ? (window.scrollY || document.documentElement.scrollTop || 0)
      : 0;
    _setViewRaw((prev) => {
      if (JSON.stringify(prev) !== JSON.stringify(next)) {
        _navHistory.current.push({ view: prev, scrollY: sy });
        if (_navHistory.current.length > 50) _navHistory.current.shift();
      }
      return next;
    });
  };
  const goBack = () => {
    const stack = _navHistory.current;
    if (stack.length === 0) return;
    const entry = stack.pop()!;
    _pendingScrollRestore.current = entry.scrollY;
    _setViewRaw(entry.view);
  };
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

  // Identity: deviceId is auto-generated on first launch; handle is fetched
  // from the server (or null until the user claims one). Both passed to
  // SubmitView so it can attribute submissions and to future BadgesView.
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [handle, setHandle] = useState<string | null>(null);
  // Set of siteIds the current handle has already visited. Used by DetailView
  // to show the I'm Here button as already-claimed without re-hitting the
  // server. Loaded once on launch (after handle resolves) and updated locally
  // whenever the user successfully claims a new visit.
  const [visitedSiteIds, setVisitedSiteIds] = useState<Set<string>>(new Set());
  const markSiteVisited = (siteId: string) => {
    setVisitedSiteIds(prev => {
      if (prev.has(siteId)) return prev;
      const next = new Set(prev);
      next.add(siteId);
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const id = await getOrCreateDeviceId();
        if (cancelled) return;
        setDeviceId(id);
        const myHandle = await apiGetMyHandle(id);
        if (cancelled) return;
        if (myHandle) {
          setHandle(myHandle);
          // Load visit history so DetailView can show the visited state
          // immediately without a flash of the unclaimed button.
          const siteIds = await apiGetMyVisits(myHandle);
          if (cancelled) return;
          if (siteIds.size) setVisitedSiteIds(siteIds);
        }
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Audio system bootstrap. Installs the gesture-bound unlock listener
  // that flushes iOS's "audio requires user gesture" lock on first tap.
  // Sound buffers are fetched+decoded lazily on first play (NOT here)
  // because creating buffer-decode work tied to a still-suspended context
  // before any user gesture wastes effort and can race the unlock.
  // See the audio section at the top of the file for full architecture.
  useEffect(() => {
    try { installAudioUnlock(); } catch { /* silent */ }
  }, []);

  // ----- iOS-style swipe-back drag (ref-based) -----
  // We attach a ref to a wrapper div around the keyed view (see JSX below).
  // The drag handler mutates _dragWrapperRef.current.style.transform during
  // touchmove. On release: animate off-screen + goBack() if past 35% width
  // or quick flick, otherwise snap back.
  const _dragWrapperRef = useRef<HTMLDivElement | null>(null);
  // Wrapper for the previous view that peeks in from the left during a drag.
  // Only rendered while a drag is active (prevView !== null).
  const _prevWrapperRef = useRef<HTMLDivElement | null>(null);
  // The previous view, exposed to JSX so we can render it as a peek layer
  // during a swipe-back gesture. Set on drag start, cleared on drag end.
  const [prevView, setPrevView] = useState<View | null>(null);
  // Saved scroll position of the previous view — stored as a ref (not
  // state) so it updates SYNCHRONOUSLY alongside setPrevView. If we used
  // useState here, React would batch the two state updates and the peek
  // layer's first paint could happen with prevScrollY still at 0 before
  // the second update lands. On a 220ms swipe animation, that one paint
  // at 0 is what the user actually sees, defeating the whole fix. Refs
  // update immediately, so reading _prevScrollRef.current during render
  // gives us the right value on the very first paint of the peek layer.
  const _prevScrollRef = useRef<number>(0);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (view.name === 'home') return;
    // Disable swipe-back on the map view — the map's own pan/zoom gestures
    // would constantly fight the swipe handler. The map page provides an
    // explicit Back button instead.
    if (view.name === 'nearby') return;

    let startX = 0, startY = 0, startT = 0;
    let tracking = false;
    let axis: 'none' | 'h' | 'v' = 'none';
    let dragging = false;
    let currentDx = 0;
    const screenW = () => Math.max(window.innerWidth || 320, 320);

    const setX = (px: number, animate: boolean) => {
      const el = _dragWrapperRef.current;
      if (el) {
        el.style.transition = animate ? 'transform 240ms cubic-bezier(0.22, 0.61, 0.36, 1)' : 'none';
        el.style.transform = px === 0 ? '' : 'translateX(' + px + 'px)';
      }
      // Drive the previous-view peek layer in lockstep. At px=0 the prev
      // layer sits at -30% screenW (peeking from the left edge). At
      // px=screenW the prev layer sits at 0 (fully revealed).
      const prevEl = _prevWrapperRef.current;
      if (prevEl) {
        const w = screenW();
        const ratio = Math.min(1, Math.max(0, px / w));
        const peek = -0.3 * w + ratio * (0.3 * w);
        prevEl.style.transition = animate ? 'transform 240ms cubic-bezier(0.22, 0.61, 0.36, 1)' : 'none';
        prevEl.style.transform = 'translateX(' + peek + 'px)';
      }
    };

    const onStart = (e: TouchEvent) => {
      if (!e.touches || e.touches.length !== 1) return;
      const tch = e.touches[0];
      startX = tch.clientX;
      startY = tch.clientY;
      startT = Date.now();
      tracking = true;
      axis = 'none';
      dragging = false;
      currentDx = 0;
      // NOTE: prevView is NOT staged here. Touchstart fires on every tap
      // (including taps to scroll the page), and staging the peek layer
      // up-front caused it to render in the background during normal
      // page interaction. We now stage prevView only after axis-lock
      // confirms a horizontal drag - see onMove below.
    };

    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      if (!e.touches || e.touches.length !== 1) return;
      const tch = e.touches[0];
      const dx = tch.clientX - startX;
      const dy = tch.clientY - startY;

      if (axis === 'none') {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (Math.abs(dy) > Math.abs(dx)) {
          axis = 'v';
          tracking = false;
          return;
        }
        axis = 'h';
        dragging = true;
        // Check if ListView wants to handle this swipe internally (drill
        // back through its category/state/site levels instead of exiting
        // to home). If so, fire the hook now, abort the swipe gesture
        // entirely, and let ListView's normal re-render show the prior
        // level. No peek layer, no nav-stack pop. The hook returns true
        // when it handled it, false when ListView is at its top level
        // and wants to exit normally.
        if (_listSwipeBackHook && _listSwipeBackHook()) {
          tracking = false;
          dragging = false;
          axis = 'none';
          return;
        }
        // Now that the gesture has committed to horizontal, stage the
        // previous view so the peek layer mounts. This is the right
        // moment - we know the user wants to swipe back, and the layer
        // wasn't bleeding into normal page interaction beforehand.
        //
        // We also set document scroll to the saved position from the top
        // of the history stack RIGHT NOW, before goBack() fires later
        // (after the slide animation completes). The peek layer is fixed-
        // position and renders the previous view at scroll 0, but the
        // moment goBack() unmounts the current view and mounts the
        // previous one, that previous view's content lands inside the
        // normal document flow — and the document needs to already be at
        // the right scroll offset for the user to land where they were.
        // Setting it here, ~220ms before goBack runs, gives the document
        // plenty of time to settle without any visible flicker.
        const stack = _navHistory.current;
        if (stack.length > 0) {
          const top = stack[stack.length - 1];
          // Set the ref FIRST so any render triggered by setPrevView below
          // already sees the right scroll offset. Refs are synchronous;
          // state setters are not.
          _prevScrollRef.current = top.scrollY;
          setPrevView(top.view);
          // Stash the value so the restore effect can re-confirm it
          // after the new view mounts (handles the edge case where the
          // page hasn't laid out tall enough yet at this exact moment).
          _pendingScrollRestore.current = top.scrollY;
          if (typeof window !== 'undefined') {
            try {
              window.scrollTo({ top: top.scrollY, left: 0, behavior: 'auto' as ScrollBehavior });
            } catch { /* silent */ }
          }
        }
      }

      if (!dragging) return;
      currentDx = dx <= 0 ? Math.max(dx / 4, -40) : dx;
      setX(currentDx, false);
    };

    const finish = (shouldFire: boolean) => {
      if (shouldFire) {
        if (view.name === 'submit') {
          try {
            const inputs = Array.from(document.querySelectorAll('input, textarea')) as Array<HTMLInputElement | HTMLTextAreaElement>;
            const dirty = inputs.some((el) => (el.value && el.value.trim().length > 0));
            if (dirty && !window.confirm('Discard this submission and go back?')) {
              setX(0, true);
              return;
            }
          } catch { /* proceed */ }
        }
        // Fire back sound at commit time, BEFORE the 220ms slide-off
        // animation. Audio starts while the slide-off is animating, so by
        // the time goBack() triggers the heavy re-render the audio is
        // already playing smoothly. Firing it inside the setTimeout was
        // colliding with goBack's render work and causing the black flash.
        try { playBackSound(); } catch { /* silent */ }
        setX(screenW(), true);
        window.setTimeout(() => {
          const el = _dragWrapperRef.current;
          if (el) {
            el.style.transition = 'none';
            el.style.transform = '';
          }
          // Reset the prev-layer transform too so the next drag starts
          // from a known state if React keeps the node alive across
          // renders (it shouldn't, but defensively reset anyway).
          const prevEl = _prevWrapperRef.current;
          if (prevEl) {
            prevEl.style.transition = 'none';
            prevEl.style.transform = '';
          }
          goBack();
          // Tear down the peek layer — the new current view IS the old
          // prev view now, so we don't need a peek layer anymore.
          setPrevView(null);
        }, 220);
      } else {
        setX(0, true);
        // Snap-back finished — drop the peek layer after the animation.
        window.setTimeout(() => { setPrevView(null); }, 260);
      }
    };

    const onEnd = (e: TouchEvent) => {
      if (!tracking && !dragging) return;
      tracking = false;
      if (!dragging) return;
      dragging = false;
      const tch = (e.changedTouches && e.changedTouches[0]);
      const endX = tch ? tch.clientX : startX + currentDx;
      const dx = endX - startX;
      const dt = Date.now() - startT;
      const w = screenW();
      const distPass = dx >= w * 0.35;
      const flickPass = dt <= 300 && dx >= 80;
      finish(distPass || flickPass);
    };

    const onCancel = () => {
      if (!dragging) { tracking = false; return; }
      tracking = false;
      dragging = false;
      finish(false);
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    window.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onCancel);
    };
  }, [view]);

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
    // Skips the state-grid step entirely. Go directly to the location list
    // for the category with no state filter; the user can refine by state
    // (or anything else) using the search bar in CategoryView.
    playButton();
    setView({ name: 'category', category: key });
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
  // Note on sounds: these four nav functions (goAbout/goLeaders/goList/
  // goNearby) used to call playButton() at the top, but the only place
  // that invokes them is the HomeBottomBar — and that bar's onClick
  // handlers already play the correct Sub Drop / Ghost Wisp sound BEFORE
  // calling these. Leaving playButton() here meant both sounds played
  // simultaneously and the louder click drowned out Sub Drop. Sound is
  // now the bottom bar's responsibility, not these nav functions'.
  function goAbout() {
    setView({ name: 'about' });
  }
  function goLeaders() {
    setView({ name: 'leaders' });
  }
  function goList() {
    // Opening List View fresh from the menu should always start at the
    // top (Categories) level. The module-level _listLevelMemory exists
    // ONLY to preserve drill-down across the swipe-back-from-Detail
    // double mount — not across separate visits to the screen.
    _listLevelMemory = null;
    setView({ name: 'list' });
  }
  function goNearby() {
    setView({ name: 'nearby' });
  }
  function goHome() {
    playBackSound();
    setView({ name: 'home' });
  }
  function goStateListBack(key: CategoryKey) {
    // No state grid anymore. Back from detail returns to the unified
    // category list (all locations in that category, all states).
    playBackSound();
    setView({ name: 'category', category: key });
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
  // Pick the rendered view based on current state. Extracted into a helper
  // so we can call it for both the active view AND the previous view (when
  // a swipe-back is in progress and we need to render the peek layer).
  const buildViewLayer = (v: View): { key: string; element: JSX.Element } => {
    if (v.name === 'detail') {
      return {
        key: `detail:${v.site.id}`,
        element: (
          <DetailView
            site={v.site}
            currentLocation={currentLocation}
            handle={handle}
            deviceId={deviceId}
            alreadyVisited={visitedSiteIds.has(v.site.id)}
            onVisited={markSiteVisited}
            onBack={() => goLocaleListBack(v.site.category as CategoryKey, v.site.state)}
          />
        ),
      };
    } else if (v.name === 'category') {
      // Two modes: with v.state -> filter to that state only (legacy support
      // in case any code path still routes here with a state). Without
      // v.state -> show every location in the category across all states.
      // The CategoryView search bar lets the user refine by state name,
      // location title, or description.
      const filtered = v.state
        ? sites.filter(s => s.category === v.category && s.state === v.state)
        : sites.filter(s => s.category === v.category);
      const cat = CATEGORIES.find(c => c.key === v.category);
      const label = v.state
        ? `${v.state} · ${cat?.label || titleCase(v.category)}`
        : (cat?.label || titleCase(v.category));
      // scrollKey: stable identifier for THIS specific category+state.
      // Both the peek-layer mount and the real-wrapper mount of CategoryView
      // get the same key, so they read/write the same slot in the scroll-
      // memory Map. That's what makes scroll restoration deterministic
      // across the swipe-back gesture's double mount.
      const scrollKey = `category:${v.category}:${v.state || 'ALL'}`;
      return {
        key: scrollKey,
        element: (
          <CategoryView
            label={label}
            color={CATEGORY_COLOR[v.category]}
            sites={filtered}
            currentLocation={currentLocation}
            onSelectSite={goDetail}
            onSubmit={goSubmit}
            onBack={goHome}
            scrollKey={scrollKey}
          />
        ),
      };
    } else if (v.name === 'stateList') {
      const cat = CATEGORIES.find(c => c.key === v.category);
      return {
        key: `stateList:${v.category}`,
        element: (
          <StateListView
            sites={sites}
            category={v.category}
            categoryLabel={cat?.label || titleCase(v.category)}
            color={CATEGORY_COLOR[v.category]}
            onSelectState={(state) => goCategoryState(v.category, state)}
            onBack={goHome}
          />
        ),
      };
    } else if (v.name === 'submit') {
      return { key: 'submit', element: <SubmitView currentLocation={currentLocation} deviceId={deviceId} handle={handle} onHandleClaimed={setHandle} onBack={goHome} /> };
    } else if (v.name === 'about') {
      return { key: 'about', element: <AboutView onBack={goHome} /> };
    } else if (v.name === 'leaders') {
      return {
        key: 'leaders',
        element: (
          <LeadersView
            currentHandle={handle}
            onSelectHandle={(h) => setView({ name: 'badges', handle: h })}
            onBack={goHome}
          />
        ),
      };
    } else if (v.name === 'badges') {
      return {
        key: `badges:${v.handle}`,
        element: <BadgesView handle={v.handle} isMe={!!handle && handle.toLowerCase() === v.handle.toLowerCase()} onBack={goHome} />,
      };
    } else if (v.name === 'list') {
      return { key: 'list', element: <ListView sites={sites} currentLocation={currentLocation} onSelectSite={goDetail} onBack={goHome} /> };
    } else if (v.name === 'nearby') {
      return { key: 'nearby', element: <NearbyView sites={sites} currentLocation={currentLocation} onSelectSite={goDetail} onBack={goHome} /> };
    } else {
      return {
        key: 'home',
        element: (
          <HomeView
            sites={sites}
            onSelectCategory={goStateList}
            onSelectSite={goDetail}
            onSubmit={goSubmit}
            onAbout={goAbout}
            onLeaders={goLeaders}
            onList={goList}
            onNearby={goNearby}
          />
        ),
      };
    }
  };

  const { key: viewKey, element: viewElement } = buildViewLayer(view);
  // Build the prev layer only when a drag is staging it. Cleared on drag end.
  const prevLayer = prevView ? buildViewLayer(prevView) : null;

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

  // Scroll restore on swipe-back. When goBack() pops a history entry it
  // stashes the saved scrollY in _pendingScrollRestore. This effect fires
  // on the next render after the popped view has mounted, but the new
  // view's content may not be tall enough yet (data loaded async, images
  // streaming in, lazy effects running). A single double-rAF lands too
  // early in those cases and the page caps the scroll at whatever the
  // current content height allows — which is why users were seeing scroll
  // back to 0 even though the saved value was correct.
  //
  // We poll up to ~600ms checking whether the document is tall enough to
  // accommodate the target scroll, and only then commit. If after the
  // poll period the page still isn't tall enough, we scroll as far as we
  // can so the user lands as close to where they were as possible.
  //
  // On forward navigations there's no pending value, so this scrolls to
  // 0 — matching the normal "new screen starts at the top" expectation.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const target = _pendingScrollRestore.current;
    _pendingScrollRestore.current = null;

    if (target == null) {
      // Forward nav — go straight to top after one rAF for layout.
      requestAnimationFrame(() => {
        window.scrollTo({ top: 0, left: 0, behavior: 'auto' as ScrollBehavior });
      });
      return;
    }

    // Backward nav with a saved scroll position. Poll for the page to grow
    // tall enough, then commit. We require the document to be tall enough
    // that scrolling to `target` actually moves the viewport (not capped
    // at maxScroll < target).
    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 12; // ~12 frames * ~50ms = 600ms ceiling
    const tryRestore = () => {
      if (cancelled) return;
      attempts++;
      const doc = document.documentElement;
      const maxScroll = Math.max(0, doc.scrollHeight - window.innerHeight);
      // If the page is tall enough OR we've burned through our retries,
      // commit. Math.min ensures we never request a scroll past maxScroll
      // (which iOS Safari ignores and leaves us at 0).
      if (maxScroll >= target || attempts >= MAX_ATTEMPTS) {
        const safeTarget = Math.min(target, maxScroll);
        window.scrollTo({ top: safeTarget, left: 0, behavior: 'auto' as ScrollBehavior });
        return;
      }
      // Not tall enough yet — wait one more frame plus a tick.
      window.setTimeout(() => requestAnimationFrame(tryRestore), 50);
    };
    requestAnimationFrame(tryRestore);
    return () => { cancelled = true; };
  }, [viewKey]);

  // The key forces React to unmount + remount the wrapper on every view
  // change, which re-fires the sinister-view-enter CSS animation.
  // FireEffect is rendered at THIS level — outside the keyed wrapper —
  // because the wrapper's CSS transform creates a containing block and
  // would break position:fixed for the fire layers, making them scroll
  // with the page instead of staying anchored to the viewport.
  //
  // FireEffect render currently disabled — the embers + glow weren't
  // visible behind the opaque content on any screen, so we're skipping
  // the per-frame animation cost. Component, EMBERS array, keyframes,
  // and styles are all left in place; just re-add `<FireEffect />` here
  // to bring it back.
  return (
    <>
      {/* <FireEffect /> */}
      {/* Peek-from-left layer rendered as a SIBLING of the drag wrapper, NOT
          inside it. If it lived inside the wrapper, the wrapper's translateX
          during a swipe would drag the peek layer along with the current
          view - defeating the whole effect. As a fixed-position sibling the
          peek layer is independent of the wrapper's transform.
          Mounted only when prevLayer is non-null (a horizontal drag is in
          progress and the history stack has something to peek). */}
      {prevLayer && (
        <div
          ref={_prevWrapperRef}
          key={`prev-${prevLayer.key}`}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 1,
            transform: 'translateX(-30vw)',
            willChange: 'transform',
            pointerEvents: 'none',
            backgroundColor: '#0A0A0A',
            // Hide overflow on the wrapper itself so the inner shifted
            // content doesn't bleed into the wrapper's edges.
            overflow: 'hidden',
          }}
        >
          {/* Inner div that's shifted up by the saved scroll position. The
              peek layer mounts the previous view fresh (always rendered
              from the top), but visually we want the user to see the page
              where they LEFT it. Translating the content by -savedScroll
              makes the visible portion of the peek layer match where the
              user was scrolled when they navigated forward. We read the
              offset from a ref rather than state so the very first paint
              of the peek layer already has it applied — state setters
              would race against React's batch and let the layer paint
              once at scroll 0 before the correct value lands. */}
          <div style={{ transform: `translateY(-${_prevScrollRef.current}px)` }}>
            {prevLayer.element}
          </div>
        </div>
      )}
      <div ref={_dragWrapperRef} style={{ willChange: 'transform', position: 'relative', zIndex: 2, backgroundColor: '#0A0A0A' }}><div key={viewKey} className="sinister-view-enter">
        {viewElement}
      </div></div>
      {/* Global bottom bar — visible on every screen except the Map view
          and DetailView. The map page has its own back button + map controls
          so this bar would visually clutter and overlap interactive elements.
          DetailView is excluded because the page already has Get Directions
          + Claim Visit as its primary actions; layering the bottom bar on
          top makes the page feel busy and competes with those CTAs. */}
      {view.name !== 'nearby' && view.name !== 'detail' && (
        <HomeBottomBar
          onLeaders={goLeaders}
          onList={goList}
          onAbout={goAbout}
          onNearby={goNearby}
        />
      )}
      <ToastHost />
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

// ---------- Toast Host ----------
// Listens for showToast() events and renders a small dismissible
// notification above the bottom social bar. Auto-clears on a timer.
// Supports stacking (most recent on top) but caps the queue at 3 to
// avoid the screen filling up if something goes wild.
function ToastHost() {
  const [toasts, setToasts] = useState<Array<ToastDetail & { id: number }>>([]);

  useEffect(() => {
    let counter = 0;
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent<ToastDetail>).detail;
      if (!detail) return;
      const id = ++counter;
      const entry = { ...detail, id };
      setToasts((prev) => {
        const next = [...prev, entry];
        // Keep only the latest 3. If a 4th arrives, drop the oldest so
        // the user still sees the freshest update.
        return next.length > 3 ? next.slice(next.length - 3) : next;
      });
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, detail.durationMs || 2500);
    };
    window.addEventListener(TOAST_EVENT, onToast as EventListener);
    return () => window.removeEventListener(TOAST_EVENT, onToast as EventListener);
  }, []);

  if (toasts.length === 0) return null;
  return (
    <div style={S.toastWrap} className="sinister-toast-host">
      {toasts.map((t) => {
        const toneStyle =
          t.tone === 'success' ? S.toastSuccess :
          t.tone === 'error' ? S.toastError :
          S.toastDefault;
        return (
          <div
            key={t.id}
            style={{ ...S.toast, ...toneStyle }}
            className="sinister-toast"
          >
            {t.message}
          </div>
        );
      })}
    </div>
  );
}

// ---------- Skeleton Loaders ----------
// Animated placeholder rectangles shown while content is loading. Looks
// significantly more polished than a "Loading…" text label and increases
// perceived speed because users see the shape of the eventual content
// before it arrives.
//
// SkeletonRow renders a single horizontal pulsing block — used for list
// views (Dread Leaders, List View, Badges page).
// SkeletonCard is a slightly bigger variant used for card-shaped content.
function SkeletonRow({ height = 48, delay = 0 }: { height?: number; delay?: number }) {
  return (
    <div
      style={{
        height,
        width: '100%',
        background: 'linear-gradient(90deg, #1a1a1a 0%, #252525 50%, #1a1a1a 100%)',
        backgroundSize: '200% 100%',
        borderRadius: 10,
        marginBottom: 8,
        animation: `sinister-skeleton-pulse 1.4s ease-in-out infinite`,
        animationDelay: `${delay}ms`,
      }}
      aria-hidden="true"
    />
  );
}

// ---------- Bottom social bar ----------
// ---------- Home bottom bar ----------
// Replaces the old SocialBar on the home page. Three slots: Dread Leaders
// (top submitters/visitors leaderboard, scaffolded but not yet populated),
// List View (flat directory of all categories/states/locations, also
// scaffolded), and About. Instagram and YouTube links moved to AboutView
// where they already live, so users still have one tap to reach them.
function HomeBottomBar({ onLeaders, onList, onAbout, onNearby }: {
  onLeaders: () => void;
  onList: () => void;
  onAbout: () => void;
  onNearby: () => void;
}) {
  // Two pill buttons on the home page bottom bar: "Locations Near Me" (left)
  // opens the Map View (NearbyView), and "More" (right) opens a popup that
  // contains Dread Leaders, List View, and About. Submit a Location stays
  // unchanged above this bar.
  //
  // The More popup is anchored above the More button (right-aligned). It
  // closes when:
  //   - User taps any item in it (and navigates)
  //   - User taps the More button again
  //   - User taps anywhere outside (handled via a transparent overlay)
  const [moreOpen, setMoreOpen] = useState(false);
  const closeMore = () => setMoreOpen(false);

  return (
    <>
      {/* Backdrop — captures taps outside the popup so users can dismiss
          by tapping anywhere on the page, the same way iOS context menus
          and action sheets behave. Transparent so it doesn't darken the
          home view (the popup itself is what stands out). */}
      {moreOpen && (
        <div
          onClick={closeMore}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9,
            backgroundColor: 'transparent',
          }}
        />
      )}

      {/* Popup menu — anchored above the More button on the right side.
          Animated in via a CSS class so it doesn't pop in jarringly. */}
      {moreOpen && (
        <div style={S.moreMenuWrap} className="sinister-more-menu">
          <button
            style={S.moreMenuItem}
            onClick={() => { playSubDrop(); closeMore(); onLeaders(); }}
          >
            <span style={S.socialIcon}>👑</span>
            <span style={S.moreMenuLabel}>Dread Leaders</span>
          </button>
          <div style={S.moreMenuDivider} />
          <button
            style={S.moreMenuItem}
            onClick={() => { playSubDrop(); closeMore(); onList(); }}
          >
            <span style={S.socialIcon}>📜</span>
            <span style={S.moreMenuLabel}>List View</span>
          </button>
          <div style={S.moreMenuDivider} />
          <button
            style={S.moreMenuItem}
            onClick={() => { playSubDrop(); closeMore(); onAbout(); }}
          >
            <span style={S.socialIcon}>ℹ️</span>
            <span style={S.moreMenuLabel}>About</span>
          </button>
        </div>
      )}

      <div style={S.socialBar}>
        <button
          style={S.socialBtn}
          onClick={() => { playSubDrop(); onNearby(); }}
        >
          <span style={S.socialIcon}>📍</span>
          <span style={S.socialLabel}>Locations Near Me</span>
        </button>
        <button
          style={{ ...S.socialBtn, ...(moreOpen ? S.socialBtnActive : {}) }}
          onClick={() => {
            // OPEN plays the run-home/back sound; CLOSE plays Sub Drop
            // (matches the rest of the bottom bar). The asymmetry gives
            // the user an audible cue that "the menu just appeared" vs
            // "I'm dismissing the menu."
            if (moreOpen) playSubDrop();
            else playBackSound();
            setMoreOpen(v => !v);
          }}
        >
          <span style={S.socialIcon}>☰</span>
          <span style={S.socialLabel}>More</span>
        </button>
      </div>
    </>
  );
}

// ---------- Leaders (Dread Leaders leaderboard) ----------
// Two-tab leaderboard: Submitters (handles ranked by approved site count)
// and Visitors (handles ranked by verified visit count). Tapping any row
// drills into that handle's badge collection.
//
// Design choices:
//   - Submitters tab is the default since it represents earned content; the
//     visitor count lags until users start tagging in at sites.
//   - Tabs are local state (no routing) — switching is cheap and doesn't
//     warrant a new view in the back stack.
//   - We fetch both lists once on mount in parallel rather than lazy-load
//     per tab. The payload is tiny and switching tabs feels instant this way.
//   - The "View My Badges" pill at the top is shown only if a handle is
//     claimed; it's the most discoverable entry point to the badges screen
//     for users who don't appear on the leaderboard yet.
function LeadersView({ currentHandle, onSelectHandle, onBack }: {
  currentHandle: string | null;
  onSelectHandle: (handle: string) => void;
  onBack: () => void;
}) {
  // Hide the iOS document scroll indicator while this view is mounted.
  useEffect(() => {
    document.body.setAttribute('data-view', 'leaders');
    document.documentElement.setAttribute('data-view', 'leaders');
    return () => {
      if (document.body.getAttribute('data-view') === 'leaders') {
        document.body.removeAttribute('data-view');
      }
      if (document.documentElement.getAttribute('data-view') === 'leaders') {
        document.documentElement.removeAttribute('data-view');
      }
    };
  }, []);
  const [tab, setTab] = useState<'submitters' | 'visitors'>('submitters');
  const [submitters, setSubmitters] = useState<LeaderRow[] | null>(null);
  const [visitors, setVisitors] = useState<LeaderRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, v] = await Promise.all([
          apiLeaderboardSubmitters(50),
          apiLeaderboardVisitors(50),
        ]);
        if (cancelled) return;
        setSubmitters(s);
        setVisitors(v);
      } catch (err: any) {
        if (cancelled) return;
        setLoadError(err?.message || 'Could not load leaderboards');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const rows = tab === 'submitters' ? submitters : visitors;
  const unitLabel = tab === 'submitters' ? 'submissions' : 'visits';

  return (
    <div style={S.appBg}>
      <header style={S.header}>
        <div style={{ ...S.categoryViewTitle, color: WHITE, textShadow: `0 0 14px ${WHITE}cc` }}>
          Dread Leaders
        </div>
      </header>

      {/* Tab switcher — pill row, currentTab gets the white glow that the
          rest of the app uses to indicate active state. */}
      <div style={S.leaderTabs}>
        <button
          style={{ ...S.leaderTab, ...(tab === 'submitters' ? S.leaderTabActive : {}) }}
          onClick={() => { playSubDrop(); setTab('submitters'); }}
        >
          Submitters
        </button>
        <button
          style={{ ...S.leaderTab, ...(tab === 'visitors' ? S.leaderTabActive : {}) }}
          onClick={() => { playSubDrop(); setTab('visitors'); }}
        >
          Visitors
        </button>
      </div>

      {/* "View My Badges" entry point — only when the user has a claimed handle. */}
      {currentHandle && (
        <div style={{ padding: '0 20px', marginBottom: 8 }}>
          <button
            style={{ ...S.leaderMineBtn, border: `2px solid ${WHITE}`, color: WHITE }}
            onClick={() => { playSubDrop(); onSelectHandle(currentHandle); }}
          >
            🏅 View My Badges ({currentHandle})
          </button>
        </div>
      )}

      <div style={S.leaderBody}>
        {loadError && (
          <p style={{ ...S.aboutPara, color: '#d97a7a' }}>{loadError}</p>
        )}
        {!loadError && rows === null && (
          <div style={S.leaderList}>
            <SkeletonRow height={48} delay={0} />
            <SkeletonRow height={48} delay={120} />
            <SkeletonRow height={48} delay={240} />
            <SkeletonRow height={48} delay={360} />
            <SkeletonRow height={48} delay={480} />
          </div>
        )}
        {!loadError && rows !== null && rows.length === 0 && (
          <p style={S.aboutPara}>
            No {tab} yet. Be the first — {tab === 'submitters' ? 'submit a location' : 'tag in at a site'} to claim the top spot.
          </p>
        )}
        {!loadError && rows !== null && rows.length > 0 && (
          <div style={S.leaderList}>
            {rows.map((row, i) => {
              const isMe = !!currentHandle && currentHandle.toLowerCase() === row.handle.toLowerCase();
              return (
                <button
                  key={`${row.handle}:${i}`}
                  style={{ ...S.leaderRow, ...(isMe ? S.leaderRowMe : {}) }}
                  onClick={() => { playSubDrop(); onSelectHandle(row.handle); }}
                >
                  <span style={S.leaderRank}>{i + 1}</span>
                  <span style={S.leaderHandle}>{row.handle}{isMe ? ' (you)' : ''}</span>
                  <span style={S.leaderCount}>{row.count} {unitLabel}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Badges (per-handle collection) ----------
// Shows every badge a given handle has earned. Reachable from a row tap on
// LeadersView, or via the "View My Badges" pill on the same screen.
//
// Server response format (computed on each request, not stored):
//   { handle, badges: [{ id, label, kind, threshold?, category? }] }
//
// We bucket the badges into Submitter / Visitor / Other and render each
// group with a header. Empty handles get an encouraging empty state rather
// than a blank screen, since some users may visit this view with a handle
// that hasn't earned anything yet.
function BadgesView({ handle, isMe, onBack }: {
  handle: string;
  isMe: boolean;
  onBack: () => void;
}) {
  const [badges, setBadges] = useState<BadgeRow[] | null>(null);
  const [submitCount, setSubmitCount] = useState(0);
  const [visitCount, setVisitCount] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGetBadges(handle);
        if (cancelled) return;
        setBadges(data.badges);
        setSubmitCount(data.submitCount);
        setVisitCount(data.visitCount);
      } catch (e: any) {
        if (cancelled) return;
        setErr(e?.message || 'Could not load badges');
      }
    })();
    return () => { cancelled = true; };
  }, [handle]);

  // Bucket badges by kind so each section gets its own header. Submitter
  // tier badges have kind "submitter"; per-category "first" badges have
  // kind "submitter_category"/"visitor_category" — we group those alongside
  // the tier badges since they're all earned by submitting/visiting.
  // Anything truly unknown falls into "Other" so we never silently drop
  // server data.
  const isSubmitter = (k: string) => k === 'submitter' || k.startsWith('submitter_');
  const isVisitor = (k: string) => k === 'visitor' || k.startsWith('visitor_');
  const submitterBadges = (badges || []).filter(b => isSubmitter(b.kind));
  const visitorBadges = (badges || []).filter(b => isVisitor(b.kind));
  const otherBadges = (badges || []).filter(b => !isSubmitter(b.kind) && !isVisitor(b.kind));

  return (
    <div style={S.appBg}>
      <header style={S.header}>
        <div style={{ ...S.categoryViewTitle, color: WHITE, textShadow: `0 0 14px ${WHITE}cc` }}>
          {isMe ? 'My Badges' : `${handle}'s Badges`}
        </div>
      </header>
      <div style={S.leaderBody}>
        {!isMe && (
          <p style={{ ...S.aboutPara, fontSize: 13, opacity: 0.7 }}>
            Handle: <b>{handle}</b>
          </p>
        )}
        {/* Stats strip — shown once badges load. Gives a snapshot of the
            user's totals even before scanning the badge cards below. */}
        {badges !== null && (submitCount > 0 || visitCount > 0) && (
          <div style={S.badgeStats}>
            <div style={S.badgeStatCell}>
              <div style={{ ...S.badgeStatNum, color: SUBMIT_RED, textShadow: `0 0 10px ${SUBMIT_RED}88` }}>{submitCount}</div>
              <div style={S.badgeStatLabel}>Submitted</div>
            </div>
            <div style={S.badgeStatCell}>
              <div style={{ ...S.badgeStatNum, color: '#6ad06a', textShadow: '0 0 10px #6ad06a88' }}>{visitCount}</div>
              <div style={S.badgeStatLabel}>Visited</div>
            </div>
          </div>
        )}
        {err && <p style={{ ...S.aboutPara, color: '#d97a7a' }}>{err}</p>}
        {!err && badges === null && (
          <div style={{ marginTop: 12 }}>
            <SkeletonRow height={28} delay={0} />
            <div style={{ marginTop: 18 }}>
              <SkeletonRow height={92} delay={120} />
              <SkeletonRow height={92} delay={240} />
            </div>
          </div>
        )}
        {!err && badges !== null && badges.length === 0 && (
          <p style={S.aboutPara}>
            {isMe
              ? "You haven't earned any badges yet. Submit a location or tag in at a site to start your collection."
              : `${handle} hasn't earned any badges yet.`}
          </p>
        )}
        {!err && badges !== null && badges.length > 0 && (
          <>
            {submitterBadges.length > 0 && (
              <BadgeGroup title="Submitter" badges={submitterBadges} accent={SUBMIT_RED} />
            )}
            {visitorBadges.length > 0 && (
              <BadgeGroup title="Visitor" badges={visitorBadges} accent="#5a8f5a" />
            )}
            {otherBadges.length > 0 && (
              <BadgeGroup title="Special" badges={otherBadges} accent={WHITE} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Reusable badge group renderer. Keeps BadgesView's JSX readable when we
// add new categories of badges later (e.g. event-based or seasonal).
function BadgeGroup({ title, badges, accent }: {
  title: string;
  badges: BadgeRow[];
  accent: string;
}) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ ...S.badgeGroupTitle, color: accent, textShadow: `0 0 8px ${accent}88` }}>
        {title}
      </div>
      <div style={S.badgeGrid}>
        {badges.map((b) => (
          <div key={b.id} style={{ ...S.badgeCard, borderColor: `${accent}55`, boxShadow: `0 0 10px ${accent}33` }}>
            <div style={{ ...S.badgeIcon, color: accent, textShadow: `0 0 10px ${accent}` }}>{b.icon || '★'}</div>
            <div style={S.badgeLabel}>{b.label}</div>
            {b.threshold != null && (
              <div style={S.badgeMeta}>Tier: {b.threshold}+</div>
            )}
            {b.category && (
              <div style={S.badgeMeta}>{titleCase(b.category)}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- List View (placeholder) ----------
// Scaffolded page. Will become a flat scannable directory: every category
// expanded, every state inside it expanded, every location inside that.
// Useful for users who want to browse without the filmstrip-cell flow.
// ---------- List View ----------
// Flat directory of every approved site, grouped by category → state →
// sites. Lets users browse without going through the cascading filmstrip
// flow on the home page. Each row taps into the same DetailView the rest
// of the app uses, so I'm Here / directions / etc. all just work.
//
// Layout: a search bar sticks at the top filtering by site title, state,
// or category label. Below it, each category gets a header in its own
// color, then states under that, then site rows under each state.
// Categories with no matching sites are hidden entirely so the list
// doesn't grow noisy as the filter tightens.
//
// Performance note: useMemo on the grouped structure keeps re-renders
// cheap as the user types. We're well under 1000 sites for now so this is
// already overkill, but it costs nothing and pays off as the catalog grows.
// ---------- List View ----------
// Three-level drill-down for browsing the catalog without going through the
// home filmstrip:
//
//   Level 1: Categories   (Hauntings • 6 locations)
//   Level 2: States       (Virginia • 6 locations)
//   Level 3: Locations    (rows that open DetailView on tap)
//
// All three levels share one persistent search bar at the top — a search
// term applied at the category level filters out categories that have zero
// matching sites, applied at the state level filters states the same way,
// and on the locations level filters individual rows. This gives the user
// one mental model regardless of where they are.
//
// Empty categories (zero approved sites) are hidden from level 1 entirely
// so users only see categories with content. Same for empty states.
//
// Tapping a row at level 3 calls onSelectSite which opens the existing
// DetailView — same flow as everywhere else, no changes needed there.
//
// This component manages its own internal back-stack rather than going
// through App's view system. That keeps app-level swipe-back simple
// (one swipe right closes ListView entirely from anywhere inside it),
// and matches what users would expect on a drill-down browser.
function ListView({ sites, currentLocation, onSelectSite, onBack }: {
  sites: SinisterSite[];
  currentLocation: { lat: number; lng: number } | null;
  onSelectSite: (site: SinisterSite) => void;
  onBack: () => void;
}) {
  type Level =
    | { kind: 'categories' }
    | { kind: 'states'; category: CategoryKey }
    | { kind: 'sites'; category: CategoryKey; state: string };
  // Initialize from module-level memory so swipe-back from DetailView
  // returns to whichever level the user was on when they tapped a site,
  // instead of always resetting to the top Categories list.
  const [level, setLevelState] = useState<Level>(() => {
    return (_listLevelMemory as Level) || { kind: 'categories' };
  });
  // Wrap setLevel so every state change also updates the module memory.
  // That way the next mount of ListView (peek layer or real wrapper)
  // sees the same value — no race, no timers.
  const setLevel = (next: Level) => {
    _listLevelMemory = next;
    setLevelState(next);
  };
  // Ref mirror of `level` so the swipe-back hook below always reads the
  // current value rather than capturing it in a closure at hook-install
  // time. Without this the hook would always see whatever level was set
  // when ListView first mounted.
  const levelRef = useRef(level);
  levelRef.current = level;

  // Register a swipe-back hook with the App's gesture handler. When the
  // user swipes back at level 3 (sites) we step to level 2 (states); at
  // level 2 we step to level 1 (categories); at level 1 we return false
  // so the gesture handler falls through to its normal nav-stack pop
  // (which exits ListView entirely back to home). Cleared on unmount so
  // no other view inadvertently inherits this handler.
  useEffect(() => {
    _listSwipeBackHook = () => {
      const cur = levelRef.current;
      if (cur.kind === 'sites') {
        playBackSound();
        setLevel({ kind: 'states', category: cur.category });
        return true;
      }
      if (cur.kind === 'states') {
        playBackSound();
        setLevel({ kind: 'categories' });
        return true;
      }
      return false;
    };
    return () => { _listSwipeBackHook = null; };
  }, []);

  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  // Helper — does a site match the current search query? Empty query
  // matches everything. Used by every level.
  const siteMatches = (site: SinisterSite): boolean => {
    if (!q) return true;
    const cat = CATEGORIES.find(c => c.key === site.category);
    const catLabel = (cat?.label || site.category).toLowerCase();
    const hay = `${site.title} ${site.state} ${catLabel}`.toLowerCase();
    return hay.includes(q);
  };

  // Level 1: list of categories that have at least one matching site.
  // Counts only matching sites — searching "virginia" with one VA cult site
  // would show "Cults • 1" alongside "Hauntings • N" rather than the full
  // catalog count.
  const categoryRows = useMemo(() => {
    const rows: { cat: typeof CATEGORIES[number]; count: number }[] = [];
    for (const cat of CATEGORIES) {
      const count = sites.filter(s => s.category === cat.key && siteMatches(s)).length;
      if (count > 0) rows.push({ cat, count });
    }
    return rows;
  }, [sites, q]);

  // Level 2: list of states for the chosen category, with matching counts.
  const stateRows = useMemo(() => {
    if (level.kind !== 'states') return [];
    const filtered = sites.filter(s => s.category === level.category && siteMatches(s));
    const counts = new Map<string, number>();
    for (const s of filtered) {
      const st = s.state || 'Unknown';
      counts.set(st, (counts.get(st) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([state, count]) => ({ state, count }))
      .sort((a, b) => a.state.localeCompare(b.state));
  }, [sites, q, level]);

  // Level 3: list of sites for the chosen category + state.
  const siteRows = useMemo(() => {
    if (level.kind !== 'sites') return [];
    return sites
      .filter(s => s.category === level.category && s.state === level.state && siteMatches(s))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [sites, q, level]);

  // Title in the header reflects the current level so the user always knows
  // where they are in the drill-down.
  const titleText =
    level.kind === 'categories' ? 'List View' :
    level.kind === 'states' ? (CATEGORIES.find(c => c.key === level.category)?.label || 'States') :
    level.state;

  // Subtitle on level 2/3 — gives breadcrumb context. On level 1 it's hidden.
  const subtitleText =
    level.kind === 'states' ? 'Choose a state' :
    level.kind === 'sites' ? (CATEGORIES.find(c => c.key === level.category)?.label || '') :
    '';

  // In-component back: at level 3 -> level 2, at level 2 -> level 1, at
  // level 1 -> close the whole ListView (delegate to onBack from parent).
  const goBackInternal = () => {
    playBackSound();
    if (level.kind === 'sites') {
      setLevel({ kind: 'states', category: level.category });
    } else if (level.kind === 'states') {
      setLevel({ kind: 'categories' });
    } else {
      onBack();
    }
  };

  return (
    <div style={S.appBg}>
      <header style={S.header}>
        <div style={{ ...S.categoryViewTitle, color: WHITE, textShadow: `0 0 14px ${WHITE}cc` }}>
          {titleText}
        </div>
        {subtitleText && (
          <div style={S.listSubtitle}>{subtitleText}</div>
        )}
      </header>

      {/* In-component back button — rendered only at level 2 or 3 since
          level 1's back is the swipe-right gesture handled by App. We give
          users an explicit visible way to step back one level without
          swiping all the way out and re-entering. */}
      {level.kind !== 'categories' && (
        <div style={S.listBackBar}>
          <button style={S.listBackBtn} onClick={goBackInternal}>← Back</button>
        </div>
      )}

      <div style={S.listSearchWrap}>
        <div style={{ position: 'relative', flex: 1 }}>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title, state, or category…"
            style={S.searchInput}
          />
          {query && (
            <button
              style={S.searchClear}
              onClick={() => { playSubDrop(); setQuery(''); }}
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <div style={S.leaderBody}>
        {sites.length === 0 ? (
          <div style={S.listSitesWrap}>
            <SkeletonRow height={56} delay={0} />
            <SkeletonRow height={56} delay={120} />
            <SkeletonRow height={56} delay={240} />
            <SkeletonRow height={56} delay={360} />
          </div>
        ) : level.kind === 'categories' ? (
          // ---- Level 1: Categories ----
          categoryRows.length === 0 ? (
            <div style={S.emptyState}>
              <div style={S.emptyStateIcon}>🔍</div>
              <div style={S.emptyStateTitle}>Nothing matches</div>
              <div style={S.emptyStateBody}>No categories match "{query}". Try a different search.</div>
            </div>
          ) : (
            <div style={S.listSitesWrap}>
              {categoryRows.map(({ cat, count }) => {
                const color = CATEGORY_COLOR[cat.key];
                return (
                  <button
                    key={cat.key}
                    style={{ ...S.listCategoryRow, borderColor: `${color}55`, boxShadow: `0 0 10px ${color}22, inset 0 0 6px ${color}11` }}
                    onClick={() => { playSubDrop(); setLevel({ kind: 'states', category: cat.key }); }}
                  >
                    <span style={{ ...S.listRowDot, background: color, boxShadow: `0 0 6px ${color}` }} />
                    <span style={{ ...S.listRowTitle, color, textShadow: `0 0 8px ${color}88` }}>{cat.label}</span>
                    <span style={S.listRowCount}>{count} {count === 1 ? 'location' : 'locations'}</span>
                    <span style={S.listChevron}>›</span>
                  </button>
                );
              })}
            </div>
          )
        ) : level.kind === 'states' ? (
          // ---- Level 2: States ----
          stateRows.length === 0 ? (
            <div style={S.emptyState}>
              <div style={S.emptyStateIcon}>🔍</div>
              <div style={S.emptyStateTitle}>Nothing matches</div>
              <div style={S.emptyStateBody}>No states match "{query}" in this category.</div>
            </div>
          ) : (
            <div style={S.listSitesWrap}>
              {(() => {
                const color = CATEGORY_COLOR[level.category];
                return stateRows.map(({ state, count }) => (
                  <button
                    key={state}
                    style={S.listRow}
                    onClick={() => { playSubDrop(); setLevel({ kind: 'sites', category: level.category, state }); }}
                  >
                    <span style={{ ...S.listRowDot, background: color, boxShadow: `0 0 6px ${color}` }} />
                    <span style={S.listRowTitle}>{state}</span>
                    <span style={S.listRowCount}>{count} {count === 1 ? 'location' : 'locations'}</span>
                    <span style={S.listChevron}>›</span>
                  </button>
                ));
              })()}
            </div>
          )
        ) : (
          // ---- Level 3: Sites ----
          siteRows.length === 0 ? (
            <div style={S.emptyState}>
              <div style={S.emptyStateIcon}>🕯</div>
              <div style={S.emptyStateTitle}>Nothing here yet</div>
              <div style={S.emptyStateBody}>
                {query
                  ? `No sites match "${query}" in this state.`
                  : `No sites in this state yet. Submit one to be the first.`}
              </div>
            </div>
          ) : (
            <div style={S.listSitesWrap}>
              {(() => {
                const color = CATEGORY_COLOR[level.category];
                return siteRows.map((site) => (
                  <button
                    key={site.id}
                    style={S.listRow}
                    onClick={() => { playSubDrop(); onSelectSite(site); }}
                  >
                    <span style={{ ...S.listRowDot, background: color, boxShadow: `0 0 6px ${color}` }} />
                    <span style={S.listRowTitle}>{site.title}</span>
                    <span style={S.listChevron}>›</span>
                  </button>
                ));
              })()}
            </div>
          )
        )}
      </div>
    </div>
  );
}

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
// ---------- Latest Submission Spotlight ----------
// Small banner shown on the home screen between BY SINISTER and the
// filmstrip cell, recognizing the most recently approved submission.
// Tappable — goes straight to that site's detail page.
//
// Picks the site with the most recent `approvedAt` timestamp. Falls
// back to the first site in the list if none have approvedAt set
// (e.g. seeded sites that predate the submission flow).
//
// Positioned absolutely inside homeReelGroup so it sits in the existing
// gap between the title block and the highlighted cell, without
// affecting either's layout. If you ever shift the filmstrip vertically
// or change the title height, the `top` value below may need to slide.
function LatestSubmissionSpotlight({ sites, onSelectSite }: {
  sites: SinisterSite[];
  onSelectSite: (site: SinisterSite) => void;
}) {
  // Pick the most recent approved submission. We treat `approvedAt` as
  // the source of truth; sites without it (legacy seeded ones) sort to
  // the bottom and only show as a fallback if nothing else is available.
  const latest = useMemo(() => {
    if (!sites || sites.length === 0) return null;
    const withDate = sites.filter(s => {
      const a = (s as any).approvedAt;
      return typeof a === 'string' && a.length > 0;
    });
    if (withDate.length > 0) {
      const sorted = [...withDate].sort((a, b) => {
        const ad = new Date((a as any).approvedAt).getTime();
        const bd = new Date((b as any).approvedAt).getTime();
        return bd - ad;
      });
      return sorted[0];
    }
    // No site has approvedAt — fall back to first in the list.
    return sites[0];
  }, [sites]);

  if (!latest) return null;

  const submitter = (latest as any).submitter || 'Sinister';

  return (
    <button
      onClick={() => { playSubDrop(); onSelectSite(latest); }}
      style={S.latestSpotlight}
      aria-label={`Latest submission: ${latest.title} by ${submitter}`}
    >
      <div style={S.latestSpotlightLabel}>LATEST SUBMISSION</div>
      <div style={S.latestSpotlightTitle}>{latest.title}</div>
      <div style={S.latestSpotlightBy}>BY <span style={S.latestSpotlightHandle}>@{submitter}</span></div>
    </button>
  );
}

function HomeView({ sites, onSelectCategory, onSelectSite, onSubmit, onAbout, onLeaders, onList, onNearby }: {
  sites: SinisterSite[];
  onSelectCategory: (key: CategoryKey) => void;
  onSelectSite: (site: SinisterSite) => void;
  onSubmit: () => void;
  onAbout: () => void;
  onLeaders: () => void;
  onList: () => void;
  onNearby: () => void;
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
            <div style={{ ...S.titleStackTop, fontFamily: '"LivingHell", "Jolly Lodger", system-ui, serif' }} className="sinister-glitch" data-text="Dread">Dread</div>
            <div style={{ ...S.titleStackBottom, fontFamily: '"LivingHell", "Jolly Lodger", system-ui, serif' }} className="sinister-glitch" data-text="Directory">Directory</div>
            <div style={S.bySinister}><BySinister /></div>
          </div>

          {/* Latest submission spotlight. Absolutely positioned in the
              gap between the title block above and the filmstrip below,
              so it doesn't shift either. */}
          <LatestSubmissionSpotlight sites={sites} onSelectSite={onSelectSite} />

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
        <span style={S.submitFixedButtonText}>SUBMIT A LOCATION</span>
      </button>
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
  // Site counts per state for this category.
  const counts: Record<string, number> = {};
  for (const s of sites) {
    if (s.category === category) counts[s.state] = (counts[s.state] || 0) + 1;
  }

  // Per-category fallback photo for each tile's photo cutout window.
  const categoryPhoto = CATEGORIES.find(c => c.key === category)?.image || '';

  // Search filtering. Prefix match against state names.
  const [searchQuery, setSearchQuery] = useState<string>('');
  const visibleStates = searchQuery
    ? US_STATES.filter(s => s.toUpperCase().startsWith(searchQuery.toUpperCase()))
    : US_STATES;

  // Paged grid layout: 2 columns x 4 rows = 8 tiles per page.
  // 51 states -> 7 pages (6 full + 1 with 3 + 5 padded).
  const TILES_PER_PAGE = 8;
  const COLS = 2;

  const pageCount = Math.max(1, Math.ceil(visibleStates.length / TILES_PER_PAGE));
  const pages: (string | null)[][] = [];
  for (let p = 0; p < pageCount; p++) {
    const page: (string | null)[] = [];
    for (let i = 0; i < TILES_PER_PAGE; i++) {
      const stateIdx = p * TILES_PER_PAGE + i;
      page.push(stateIdx < visibleStates.length ? visibleStates[stateIdx] : null);
    }
    pages.push(page);
  }

  const [currentPage, setCurrentPage] = useState<number>(0);
  const pagerRef = useRef<HTMLDivElement | null>(null);
  const programmaticScrollUntil = useRef<number>(0);

  const handlePagerScroll = () => {
    if (Date.now() < programmaticScrollUntil.current) return;
    const el = pagerRef.current;
    if (!el) return;
    const page = Math.round(el.scrollLeft / el.clientWidth);
    const clamped = Math.max(0, Math.min(pageCount - 1, page));
    if (clamped !== currentPage) {
      setCurrentPage(clamped);
      try { playSlide(); } catch { /* silent */ }
    }
  };

  // When search filters change, snap back to page 0 so the first match
  // is visible without the user manually scrolling.
  useEffect(() => {
    setCurrentPage(0);
    const el = pagerRef.current;
    if (!el) return;
    programmaticScrollUntil.current = Date.now() + 500;
    el.scrollTo({ left: 0, behavior: 'auto' });
  }, [searchQuery]);

  const blockGlobalSwipe = (e: React.TouchEvent) => { e.stopPropagation(); };

  return (
    <div style={{ ...S.appBg, overflow: 'hidden', position: 'relative', display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Title at top — same Living Hell + sinister-glitch as the home title */}
      <header style={S.header}>
        <div
          style={{
            ...S.categoryViewTitle,
            fontFamily: '"LivingHell", "Jolly Lodger", system-ui, serif',
            fontSize: 56,
            color: '#FFFFFF',
            textShadow: `0 0 20px #FFFFFF, 0 0 40px #FFFFFFaa, 2px 2px 0 #000`,
          }}
          className="sinister-glitch"
          data-text={categoryLabel}
        >{categoryLabel}</div>
      </header>

      {/* PAGER — horizontal scroll-snap container, one full-width page per group of 8 states */}
      <div
        ref={pagerRef}
        onScroll={handlePagerScroll}
        onTouchStart={blockGlobalSwipe}
        onTouchMove={blockGlobalSwipe}
        onTouchEnd={blockGlobalSwipe}
        className="state-pager"
        style={{
          flex: 1,
          display: 'flex',
          overflowX: 'auto',
          overflowY: 'hidden',
          scrollSnapType: 'x mandatory',
          WebkitOverflowScrolling: 'touch',
          scrollbarWidth: 'none',
        }}
      >
        {pages.map((page, pageIdx) => (
          <div
            key={'page-' + pageIdx}
            style={{
              flex: '0 0 100%',
              width: '100%',
              height: '100%',
              scrollSnapAlign: 'start',
              scrollSnapStop: 'always',
              display: 'grid',
              gridTemplateColumns: 'repeat(' + COLS + ', 1fr)',
              gridTemplateRows: 'repeat(4, 1fr)',
              gap: '12px',
              padding: '12px 16px 24px',
              boxSizing: 'border-box',
            }}
          >
            {page.map((state, tileIdx) => {
              if (state === null) {
                // Padding tile so the grid stays even on the last page.
                return <div key={'pad-' + pageIdx + '-' + tileIdx} />;
              }
              const count = counts[state] || 0;
              return (
                <div
                  key={state}
                  onClick={() => { try { playButton(); } catch { /* silent */ } onSelectState(state); }}
                  className="sinister-pressable"
                  style={{
                    position: 'relative',
                    width: '100%',
                    height: '100%',
                    cursor: 'pointer',
                    backgroundImage: 'url(' + SlideMountUrl + ')',
                    backgroundSize: 'contain',
                    backgroundRepeat: 'no-repeat',
                    backgroundPosition: 'center',
                  }}
                >
                  {/* Photo cutout — measured from slide-mount.png */}
                  {categoryPhoto && (
                    <div style={{
                      position: 'absolute',
                      left: '21%',
                      right: '19%',
                      top: '30%',
                      bottom: '30%',
                      backgroundImage: 'url(' + categoryPhoto + ')',
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                      filter: 'sepia(0.4) saturate(0.7) brightness(0.6)',
                      pointerEvents: 'none',
                      overflow: 'hidden',
                    }} />
                  )}
                  {/* State name in cardboard top band */}
                  <div style={{
                    position: 'absolute',
                    top: '11%',
                    left: '15%',
                    right: '15%',
                    height: '11%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 14,
                    fontWeight: 700,
                    letterSpacing: '0.14em',
                    fontFamily: 'Georgia, "Times New Roman", serif',
                    color: '#3a2f1a',
                    textTransform: 'uppercase',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    textShadow: '0 1px 0 rgba(255,255,255,0.4), 0 -1px 0 rgba(0,0,0,0.15)',
                    pointerEvents: 'none',
                  }}>
                    {state}
                  </div>
                  {/* Count in cardboard bottom band */}
                  <div style={{
                    position: 'absolute',
                    bottom: '8%',
                    left: '15%',
                    right: '15%',
                    height: '11%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: '0.18em',
                    fontFamily: 'Georgia, "Times New Roman", serif',
                    color: count > 0 ? '#3a2f1a' : '#5a5142',
                    fontStyle: count === 0 ? 'italic' : 'normal',
                    textTransform: 'uppercase',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    textShadow: '0 1px 0 rgba(255,255,255,0.3)',
                    pointerEvents: 'none',
                  }}>
                    {count === 0 ? 'No Sites' : (count === 1 ? '1 Location' : count + ' Locations')}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Page indicator dots — only show if more than 1 page (so empty search results
          don't show a stranded dot, and the indicator stays meaningful). */}
      {pageCount > 1 && (
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          gap: 8,
          padding: '6px 0 10px',
          flexShrink: 0,
        }}>
          {Array.from({ length: pageCount }).map((_, i) => (
            <div
              key={'dot-' + i}
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                backgroundColor: i === currentPage ? '#fff5e0' : 'rgba(255, 245, 224, 0.3)',
                transition: 'background-color 200ms ease',
              }}
            />
          ))}
        </div>
      )}

      {/* Search bar — sits at the bottom of the screen */}
      <div style={{
        flexShrink: 0,
        padding: '8px 16px 20px',
        position: 'relative',
      }}>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search states…"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          enterKeyHint="search"
          aria-label="Search states"
          style={{
            width: '100%',
            background: 'rgba(20, 14, 8, 0.85)',
            border: '1px solid rgba(255, 220, 160, 0.35)',
            borderRadius: 8,
            color: '#fff5e0',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            fontSize: 15,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            padding: '12px 38px 12px 14px',
            outline: 'none',
            boxSizing: 'border-box',
            boxShadow: 'inset 0 1px 4px rgba(0,0,0,0.5), 0 0 18px rgba(255, 200, 130, 0.08)',
          }}
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery('')}
            aria-label="Clear search"
            className="sinister-pressable"
            style={{
              position: 'absolute',
              right: 22,
              top: 'calc(50% - 2px)',
              transform: 'translateY(-50%)',
              background: 'transparent',
              border: 'none',
              color: '#fff5e0',
              fontSize: 18,
              width: 28,
              height: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              opacity: 0.7,
              padding: 0,
            }}
          >×</button>
        )}
        {searchQuery && visibleStates.length === 0 && (
          <div style={{
            position: 'absolute',
            top: 'calc(100% - 12px)',
            left: 0,
            right: 0,
            textAlign: 'center',
            fontSize: 11,
            color: '#fff5e088',
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            pointerEvents: 'none',
          }}>No matches</div>
        )}
      </div>
    </div>
  );
}


function AboutView({ onBack }: { onBack: () => void }) {
  // Hide the iOS document scroll indicator while this view is mounted.
  useEffect(() => {
    document.body.setAttribute('data-view', 'about');
    document.documentElement.setAttribute('data-view', 'about');
    return () => {
      if (document.body.getAttribute('data-view') === 'about') {
        document.body.removeAttribute('data-view');
      }
      if (document.documentElement.getAttribute('data-view') === 'about') {
        document.documentElement.removeAttribute('data-view');
      }
    };
  }, []);
  return (
    <div style={S.appBg}>
      <header style={S.header}>
        
        <div
          style={{ ...S.categoryViewTitle, color: WHITE, textShadow: `0 0 14px ${WHITE}cc` }}
        >
          About
        </div>
      </header>

      <div style={S.aboutBody}>
        <p style={S.aboutPara}>
          <b>Sinister Locations</b> is a field guide to the macabre — historic crimes, hauntings, horror film locations,
          cults, serial killers, and unsettling history hiding all around you.
        </p>

        <div style={S.aboutSectionHeader}>What This App Does</div>

        <p style={S.aboutPara}>
          <b>Notifies you when you're near sinister sites.</b> The app runs in the background and pings you when
          you come within range of a haunting, crime scene, or other macabre location — even when the app is closed.
          Set location access to "Always" for this to work.
        </p>
        <p style={S.aboutPara}>
          <b>Tells the story behind every location.</b> Each site has its full history, exact coordinates, and
          turn-by-turn directions in your maps app.
        </p>
        <p style={S.aboutPara}>
          <b>Lets you claim visits.</b> Stand within 100 feet of any site and tap "I'm Here" to log your visit.
          Visits earn you badges and rank you on the Dread Leaders board.
        </p>
        <p style={S.aboutPara}>
          <b>Lets you add your own locations.</b> Found a sinister spot we don't have? Tap Submit a Location while
          you're physically on-site — the app verifies your GPS and requires an on-site photo. Approved entries
          are credited to your handle permanently.
        </p>
        <p style={S.aboutPara}>
          <b>Tracks your achievements.</b> Earn tiered badges for submissions and visits. Unlock special badges
          for milestones like visiting all six categories or reaching new states.
        </p>

        <div style={S.aboutSectionHeader}>About</div>

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
        </div>
      </div>
    </div>
  );
}

// ---------- Nearby (Live Map View) ----------
// Real Apple Maps via MapKit JS, embedded in the app. Shows the user's
// live location as a blue dot and pins for every site within RADIUS_MILES.
//
// MapKit JS notes:
//   - We load the script lazily on mount and tear it down on unmount so it
//     doesn't bloat the rest of the app.
//   - Auth uses a JWT Maps Token from developer.apple.com. The token has a
//     long expiry (up to a year) and the same one works for all users.
//   - Real-time tracking uses Capacitor Geolocation watchPosition where
//     available, falling back to the browser's geolocation API. The user's
//     dot recenters smoothly as they move.
//   - Pins are colored by category. Tapping one shows a small callout with
//     the site name; tapping the callout opens DetailView.
//
// Setup required: paste your Maps Token below in MAPKIT_JS_TOKEN. You get
// it from developer.apple.com → Certificates, IDs & Profiles → Maps IDs/Keys.
//
// NOTE: The current token is an 8-day test token (expires 05/13/26). Before
// shipping to production, generate a long-term token (up to 365 days) at
// developer.apple.com → Maps → Tokens, with a domain restriction set to
// sinistertrivia.com.
const MAPKIT_JS_TOKEN = 'eyJraWQiOiJQNTgzOEJGMlNHIiwidHlwIjoiSldUIiwiYWxnIjoiRVMyNTYifQ.eyJpc3MiOiI4SzZUOTc3N1I5IiwiaWF0IjoxNzc3OTg0ODU4LCJzY29wZSI6Im1hcGtpdF9qcyIsImV4cCI6MTc3ODY1NTU5OX0.7h9gMm7v8GJtjIjHdzQ3QUvg-nmyq-WkRU4OopbHrx93zTaAHq2ISkMfnWt858PD73zAxJmLSAT8q9ohNUcsyw';
const NEARBY_RADIUS_MILES = 20;
const METERS_PER_MILE = 1609.34;

// Per-category map pin glyphs. MapKit MarkerAnnotation renders the glyph
// inside the colored teardrop, so this gives each category an instantly-
// recognizable sinister icon while preserving the color coding.
//
// Single-character emoji is what MapKit JS reliably renders; multi-codepoint
// sequences (skin tone, ZWJ joins) sometimes get clipped or default-styled.
// Keeping these to plain single emoji avoids that.
const CATEGORY_PIN_GLYPH: Record<CategoryKey, string> = {
  haunting:   '👻',
  killer:     '💀',
  crime:      '🔪',
  cult:       '🕯',
  film:       '🎬',
  historical: '🪦',
};

// Lazily load MapKit JS once across the whole app. Returns a promise that
// resolves to the global `mapkit` object, or rejects if loading fails.
let _mapkitLoadPromise: Promise<any> | null = null;
function loadMapKitJS(token: string): Promise<any> {
  if (_mapkitLoadPromise) return _mapkitLoadPromise;
  _mapkitLoadPromise = new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return reject(new Error('No window'));
    // Already loaded?
    const w = window as any;
    if (w.mapkit && w.mapkit.maps) return resolve(w.mapkit);
    const script = document.createElement('script');
    script.src = 'https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.js';
    script.crossOrigin = '';
    script.dataset.callback = 'initMapKit';
    script.dataset.libraries = 'map,annotations,services';
    // @ts-ignore — mapkit attaches itself to window before firing the
    // initial-init event.
    script.dataset.token = token;
    script.async = true;
    script.onload = () => {
      // mapkit fires its initial init on load. We init synchronously here.
      try {
        const mk = (window as any).mapkit;
        if (!mk) {
          reject(new Error('mapkit failed to attach to window'));
          return;
        }
        mk.init({
          authorizationCallback: (done: (t: string) => void) => done(token),
          language: navigator.language || 'en-US',
        });
        resolve(mk);
      } catch (err) {
        reject(err);
      }
    };
    script.onerror = () => reject(new Error('Failed to load mapkit.js'));
    document.head.appendChild(script);
  });
  return _mapkitLoadPromise;
}

function NearbyView({ sites, currentLocation, onSelectSite, onBack }: {
  sites: SinisterSite[];
  currentLocation: { lat: number; lng: number } | null;
  onSelectSite: (site: SinisterSite) => void;
  onBack: () => void;
}) {
  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const userAnnotationRef = useRef<any>(null);
  const siteAnnotationsRef = useRef<any[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [livePos, setLivePos] = useState<{ lat: number; lng: number } | null>(currentLocation);
  // Currently-tapped pin's site + distance. When non-null, a slide-up
  // preview card renders over the bottom of the map. Tapping the map
  // background, the card's × button, or another pin updates this.
  const [selectedSite, setSelectedSite] = useState<{ site: SinisterSite; distMi: number } | null>(null);

  // Compute nearby sites once we have a location. We sort + cap at 50 so
  // huge metros don't paint hundreds of pins.
  const nearbySites = useMemo(() => {
    if (!livePos) return [] as { site: SinisterSite; distMi: number }[];
    const radiusM = NEARBY_RADIUS_MILES * METERS_PER_MILE;
    return sites
      .map((s) => ({
        site: s,
        distM: distanceMeters(livePos.lat, livePos.lng, s.coords.lat, s.coords.lng),
      }))
      .filter((x) => x.distM <= radiusM)
      .sort((a, b) => a.distM - b.distM)
      .slice(0, 50)
      .map((x) => ({ site: x.site, distMi: x.distM / METERS_PER_MILE }));
  }, [sites, livePos]);

  // Initialize the map once on mount. The map sits in mapElRef; we recenter
  // and re-pin via subsequent effects rather than tearing it down.
  useEffect(() => {
    let cancelled = false;
    if (!MAPKIT_JS_TOKEN) {
      setLoadError('Maps token missing. Paste it into MAPKIT_JS_TOKEN in App.tsx.');
      return;
    }
    loadMapKitJS(MAPKIT_JS_TOKEN)
      .then((mk) => {
        if (cancelled || !mapElRef.current) return;
        const map = new mk.Map(mapElRef.current, {
          colorScheme: mk.Map.ColorSchemes.Dark,
          showsUserLocation: false, // we render our own dot for control
          showsCompass: mk.FeatureVisibility.Hidden,
          showsScale: mk.FeatureVisibility.Hidden,
          showsZoomControl: false,
          showsMapTypeControl: false,
          isRotationEnabled: true,
        });
        mapRef.current = map;
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err?.message || 'Could not load Apple Maps');
      });
    return () => {
      cancelled = true;
      const m = mapRef.current;
      if (m) {
        try { m.destroy(); } catch { /* silent */ }
      }
      mapRef.current = null;
    };
  }, []);

  // Live geolocation watcher — updates livePos as the user moves.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    let watchId: number | null = null;
    try {
      watchId = navigator.geolocation.watchPosition(
        (pos) => setLivePos({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => { /* silent — keep last good position */ },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
      );
    } catch { /* silent */ }
    return () => {
      if (watchId != null && navigator.geolocation && navigator.geolocation.clearWatch) {
        try { navigator.geolocation.clearWatch(watchId); } catch { /* silent */ }
      }
    };
  }, []);

  // Recenter the map and update the user dot whenever livePos changes.
  // Only recenters on the FIRST fix to avoid yanking the map every move.
  const didInitialCenterRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    const mk = (window as any).mapkit;
    if (!map || !mk || !livePos) return;

    // First fix — center the map and set the visible region to the radius.
    if (!didInitialCenterRef.current) {
      const center = new mk.Coordinate(livePos.lat, livePos.lng);
      // Convert miles to meters for span. CoordinateRegion uses degrees,
      // so we approximate: 1 deg lat ~= 111km. Span = 2 * radius.
      const spanDeg = (NEARBY_RADIUS_MILES * 2 * METERS_PER_MILE) / 111000;
      map.region = new mk.CoordinateRegion(
        center,
        new mk.CoordinateSpan(spanDeg, spanDeg),
      );
      didInitialCenterRef.current = true;
    }

    // Update or create the user dot. We use a custom MarkerAnnotation so
    // we can color it blue and override the glyph.
    if (userAnnotationRef.current) {
      userAnnotationRef.current.coordinate = new mk.Coordinate(livePos.lat, livePos.lng);
    } else {
      const dot = new mk.MarkerAnnotation(
        new mk.Coordinate(livePos.lat, livePos.lng),
        {
          color: '#2a8aff',
          glyphColor: '#ffffff',
          title: 'You',
          subtitle: '',
          selected: false,
        },
      );
      map.addAnnotation(dot);
      userAnnotationRef.current = dot;
    }
  }, [livePos]);

  // Render site pins whenever the nearby set changes.
  // Tapping a pin sets selectedSite (state below), which renders the
  // slide-up card. We disable MapKit's built-in callout entirely by
  // setting calloutEnabled: false, since the card replaces it.
  useEffect(() => {
    const map = mapRef.current;
    const mk = (window as any).mapkit;
    if (!map || !mk) return;

    // Remove old pins.
    if (siteAnnotationsRef.current.length) {
      try { map.removeAnnotations(siteAnnotationsRef.current); } catch { /* silent */ }
      siteAnnotationsRef.current = [];
    }
    if (!nearbySites.length) return;

    // Annotation -> site lookup so the click handler can resolve which
    // site was tapped without fragile coordinate matching.
    const annToSite = new WeakMap<any, { site: SinisterSite; distMi: number }>();
    const created: any[] = [];
    for (const entry of nearbySites) {
      const { site, distMi } = entry;
      const color = CATEGORY_COLOR[site.category as CategoryKey] || '#888888';
      const glyph = CATEGORY_PIN_GLYPH[site.category as CategoryKey] || '✦';
      const ann = new mk.MarkerAnnotation(
        new mk.Coordinate(site.coords.lat, site.coords.lng),
        {
          color,
          // glyphText shows our category emoji inside the teardrop. The
          // emoji brings its own colors, so glyphColor is ignored once
          // glyphText is set — we keep the teardrop colored via `color`
          // so the category color still reads from far away.
          glyphText: glyph,
          title: site.title,
          subtitle: `${distMi.toFixed(1)} mi`,
          selected: false,
          // animates: false stops MapKit's default bounce/pulse on the
          // pin. The bounce was barely noticeable with no glyph, but with
          // emoji glyphs it reads as flickering/blinking — turning it off
          // keeps the pins still and readable.
          animates: false,
          // We render our own slide-up card instead of MapKit's bubble.
          calloutEnabled: false,
        },
      );
      annToSite.set(ann, entry);
      created.push(ann);
    }
    map.addAnnotations(created);
    siteAnnotationsRef.current = created;

    // Pin tap: open / swap the card. Tapping the same pin a second time
    // keeps the card open (no toggle on pin tap — we toggle only on
    // close-X or map-background tap, which is more predictable). Plays
    // a small upward pop to match the upward slide-in motion of the card.
    const onSelect = (e: any) => {
      const ann = e?.annotation;
      if (!ann) return;
      const matched = annToSite.get(ann);
      if (!matched) return;
      playPop();
      setSelectedSite(matched);
    };
    // Map-background tap: close the card. MapKit fires this whenever the
    // user taps anywhere that isn't a pin or annotation.
    const onMapTap = () => {
      setSelectedSite(null);
    };
    try { map.addEventListener('select', onSelect); } catch { /* silent */ }
    try { map.addEventListener('single-tap', onMapTap); } catch { /* silent */ }

    return () => {
      try { map.removeEventListener('select', onSelect); } catch { /* silent */ }
      try { map.removeEventListener('single-tap', onMapTap); } catch { /* silent */ }
    };
  }, [nearbySites]);

  // Directions helper — same geo: scheme + Google Maps web fallback that
  // DetailView's Get Directions button uses. Lets the slide-up card route
  // straight to maps without a stop in DetailView.
  const openDirections = (site: SinisterSite) => {
    playSubDrop();
    const lat = site.coords.lat;
    const lng = site.coords.lng;
    const label = encodeURIComponent(site.title);
    const geoUrl = `geo:${lat},${lng}?q=${lat},${lng}(${label})`;
    const webUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
    try { window.location.href = geoUrl; } catch { /* fall through */ }
    setTimeout(() => {
      if (document.hasFocus && document.hasFocus()) {
        window.open(webUrl, '_blank', 'noopener,noreferrer');
      }
    }, 600);
  };

  // ---- Render ----
  return (
    <div style={S.appBg}>
      <header style={S.header}>
        {/* Back button — positioned absolutely at the bottom-left of the
            header so it sits down near the map edge, leaving the full
            header width for the title to render on a single line. */}
        <button
          style={S.mapBackBtn}
          onClick={() => { playBackSound(); onBack(); }}
          aria-label="Back to home"
        >
          ‹
        </button>
        <div
          style={{
            ...S.categoryViewTitle,
            fontFamily: '"LivingHell", "Jolly Lodger", system-ui, serif',
            color: WHITE,
            textShadow: `0 0 14px ${WHITE}cc, 0 0 28px ${WHITE}66`,
          }}
          className="sinister-glitch"
          data-text="Locations Near Me"
        >
          Locations Near Me
        </div>
        <div style={S.listSubtitle}>
          {nearbySites.length} {nearbySites.length === 1 ? 'site' : 'sites'} within {NEARBY_RADIUS_MILES} mi
        </div>
      </header>

      {loadError ? (
        <div style={S.leaderBody}>
          <p style={{ ...S.aboutPara, color: '#d97a7a' }}>
            {loadError}
          </p>
          <p style={S.aboutPara}>
            Once the token is set, the map will load Apple Maps with your live position
            and every site within {NEARBY_RADIUS_MILES} miles.
          </p>
        </div>
      ) : (
        <>
          <div
            ref={mapElRef}
            style={{
              width: '100%',
              height: 'calc(100vh - 240px)',
              minHeight: 360,
              backgroundColor: '#0a0a0a',
              position: 'relative',
              zIndex: 1,
            }}
          />
          {!livePos && (
            <div style={{ ...S.aboutPara, padding: '12px 20px', textAlign: 'center', color: '#888' }}>
              Locating you…
            </div>
          )}
          {livePos && nearbySites.length === 0 && (
            <div style={{ ...S.aboutPara, padding: '12px 20px', textAlign: 'center', color: '#888' }}>
              No sites within {NEARBY_RADIUS_MILES} miles. Submit one to be the first.
            </div>
          )}

          {/* Slide-up site card. Renders when a pin is tapped. Sits at the
              bottom of the map, overlaying the lower portion. The card
              itself stops click-through so taps inside don't dismiss it. */}
          {selectedSite && (() => {
            const { site, distMi } = selectedSite;
            const cat = CATEGORIES.find(c => c.key === site.category);
            const catLabel = cat?.label || site.category;
            const color = CATEGORY_COLOR[site.category as CategoryKey] || '#888';
            return (
              <div
                style={S.mapCard}
                onClick={(e) => e.stopPropagation()}
                className="sinister-map-card"
              >
                {/* Close X — explicit dismiss control. */}
                <button
                  style={S.mapCardClose}
                  onClick={() => { playBackSound(); setSelectedSite(null); }}
                  aria-label="Close"
                >
                  ×
                </button>

                <div style={S.mapCardTop}>
                  {/* Thumbnail. Falls back to a colored block if the image
                      fails or is missing — better than a broken image icon. */}
                  {site.imageUrl ? (
                    <div
                      style={{
                        ...S.mapCardThumb,
                        backgroundImage: `url(${site.imageUrl})`,
                        borderColor: `${color}88`,
                      }}
                    />
                  ) : (
                    <div style={{ ...S.mapCardThumb, backgroundColor: color, opacity: 0.4 }} />
                  )}

                  <div style={S.mapCardText}>
                    <div style={S.mapCardTitle}>{site.title}</div>
                    <div style={S.mapCardMeta}>
                      <span style={{ color, textShadow: `0 0 6px ${color}88` }}>{catLabel}</span>
                      <span style={S.mapCardMetaSep}>·</span>
                      <span>{site.state}</span>
                      <span style={S.mapCardMetaSep}>·</span>
                      <span>{distMi.toFixed(1)} mi</span>
                    </div>
                    <div style={S.mapCardDesc}>
                      {site.shortDescription || ''}
                    </div>
                  </div>
                </div>

                <div style={S.mapCardActions}>
                  <button
                    style={{ ...S.mapCardBtn, ...S.mapCardBtnSecondary }}
                    onClick={() => { setSelectedSite(null); playForward(); onSelectSite(site); }}
                  >
                    View Details
                  </button>
                  <button
                    style={{ ...S.mapCardBtn, ...S.mapCardBtnPrimary }}
                    onClick={() => openDirections(site)}
                  >
                    Get Directions
                  </button>
                </div>
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}

// ---------- CATEGORY ----------
function CategoryView({ label, color, sites, currentLocation, onSelectSite, onSubmit, onBack, scrollKey }: {
  label: string;
  color: string;
  sites: SinisterSite[];
  currentLocation: { lat: number; lng: number } | null;
  onSelectSite: (s: SinisterSite) => void;
  onSubmit: () => void;
  onBack: () => void;
  scrollKey: string;
}) {
  // Search box: case-insensitive substring match against title, short
  // description, full description, and state name. Empty query = show all.
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const filteredSites = q
    ? sites.filter(s =>
        s.title.toLowerCase().includes(q) ||
        s.shortDescription.toLowerCase().includes(q) ||
        s.fullDescription.toLowerCase().includes(q) ||
        s.state.toLowerCase().includes(q)
      )
    : sites;

  // Mirror HomeView exactly: filmstrip with 3-copy looping scroll, sprocket
  // columns sliding in lockstep, one-cell-per-gesture detent scrolling.
  // Each cell is a SinisterSite instead of a category.
  type Entry = { id: string; site: SinisterSite };
  const baseSequence: Entry[] = filteredSites.map((s, i) => ({
    id: `site-${s.id}-${i}`,
    site: s,
  }));
  const cellsLooped: Entry[] = [0, 1, 2].flatMap((copy) =>
    baseSequence.map(e => ({ ...e, id: `c${copy}-${e.id}` }))
  );

  // Same stride as HomeView so the rhythm matches.
  const CELL_STRIDE = 248 + 16;
  const sequenceLength = baseSequence.length;
  const oneCopyHeight = sequenceLength * CELL_STRIDE;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sprocketLeftRef = useRef<HTMLDivElement | null>(null);
  const sprocketRightRef = useRef<HTMLDivElement | null>(null);

  // On mount: restore the scroll position the user was at when they last
  // tapped into a site from this category. If there's no saved position
  // (first visit to this category, or never tapped a site), default to the
  // middle copy of the looping filmstrip so they have equal looping room
  // in both directions.
  //
  // Why useLayoutEffect, not useEffect:
  //   useEffect fires AFTER paint. That gives the user a one-frame flash
  //   of the unrestored (default) position before we correct it, which
  //   matched the bug Drew was seeing exactly. useLayoutEffect fires
  //   synchronously after DOM mutations but BEFORE paint, so the very
  //   first frame the user sees already has the right scrollTop.
  //
  // Why a Map keyed by scrollKey, not a single module-level slot:
  //   During a swipe-back gesture, CategoryView mounts twice — once in
  //   the peek layer, once in the real wrapper after goBack(). With a
  //   single slot, the second mount races against whatever timer was
  //   clearing the slot. With a keyed Map, the entry stays put until
  //   the user next taps a site from this same category — no timers,
  //   no races, deterministic.
  //
  // Why the rAF retry loop:
  //   Setting scrollTop only takes effect if the scroll container's
  //   content is already tall enough. On a fresh mount the cells may
  //   not have laid out yet, and the browser silently caps scrollTop
  //   at maxScroll (which can be 0). We re-apply for a few frames to
  //   cover that case. We stop as soon as the value sticks OR the user
  //   touches the screen (handled by the gesture effect below clearing
  //   the save when it sees user input).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const saved = _categoryScrollMap.get(scrollKey);
    const target = saved != null ? saved : oneCopyHeight;
    _catScrollLog('mount restore', { scrollKey, saved, oneCopyHeight, target });
    el.scrollTop = target;

    // Retry for up to ~600ms in case content height wasn't ready yet.
    // We stop early once scrollTop actually equals target (or is as
    // close as the current maxScroll permits).
    let raf = 0;
    let attempts = 0;
    const MAX_ATTEMPTS = 36; // ~600ms at 60fps
    const tryApply = () => {
      if (!scrollRef.current) return;
      const node = scrollRef.current;
      const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
      const safeTarget = Math.min(target, maxScroll);
      if (Math.abs(node.scrollTop - safeTarget) > 1) {
        node.scrollTop = safeTarget;
      }
      attempts++;
      // Stop once we've reached target (within 1px) or the page is tall
      // enough that we can't blame layout, or we've burned through retries.
      if (attempts >= MAX_ATTEMPTS || (maxScroll >= target && Math.abs(node.scrollTop - target) <= 1)) {
        _catScrollLog('mount restore done', { attempts, finalScrollTop: node.scrollTop, target });
        return;
      }
      raf = requestAnimationFrame(tryApply);
    };
    raf = requestAnimationFrame(tryApply);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [scrollKey, oneCopyHeight]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Empty filtered list — nothing to scroll, skip wiring up gestures.
    if (sequenceLength === 0) return;
    let raf = 0;
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
    };

    const SPROCKET_STRIDE = 28;
    const updateSprockets = () => {
      const offset = -(el.scrollTop % SPROCKET_STRIDE);
      const transform = `translateY(${offset}px)`;
      if (sprocketLeftRef.current) sprocketLeftRef.current.style.transform = transform;
      if (sprocketRightRef.current) sprocketRightRef.current.style.transform = transform;
    };

    const animateTo = (target: number) => {
      isAnimating = true;
      const start = el.scrollTop;
      const distance = target - start;
      const duration = 280;
      const startTime = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - startTime) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        el.scrollTop = start + distance * eased;
        updateFocus();
        updateSprockets();
        if (t < 1) {
          raf = requestAnimationFrame(step);
        } else {
          isAnimating = false;
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

    const advanceOneCell = (dir: 1 | -1) => {
      if (isAnimating) return;
      playSlide();
      const target = el.scrollTop + dir * CELL_STRIDE;
      animateTo(target);
    };

    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < 5) return;
      e.preventDefault();
      const now = performance.now();
      if (now < wheelLockUntil) return;
      wheelLockUntil = now + 320;
      advanceOneCell(e.deltaY > 0 ? 1 : -1);
    };
    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0]?.clientY ?? 0;
      touchStartScroll = el.scrollTop;
    };
    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (isAnimating) return;
      const endY = e.changedTouches[0]?.clientY ?? touchStartY;
      const delta = touchStartY - endY;
      if (Math.abs(delta) > 25) {
        advanceOneCell(delta > 0 ? 1 : -1);
      } else {
        animateTo(touchStartScroll);
      }
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });

    setTimeout(() => { updateFocus(); updateSprockets(); }, 0);

    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      cancelAnimationFrame(raf);
    };
  }, [oneCopyHeight, sequenceLength]);

  const handleClick = (e: Entry) => {
    // Save the filmstrip's scroll position so that when the user swipes
    // back from DetailView to this CategoryView, we can restore them to
    // the exact site cell they tapped from. The mount effect above reads
    // this on remount and applies it once the cells layout is ready.
    // Keyed by scrollKey so each category has its own slot — no shared
    // state across categories, no clearing timers needed.
    const sc = scrollRef.current;
    const top = sc ? (sc.scrollTop || 0) : 0;
    _categoryScrollMap.set(scrollKey, top);
    _catScrollLog('save on tap', { scrollKey, top });
    onSelectSite(e.site);
  };

  return (
    <div style={S.appBg}>
      <div style={S.homeReelLayout}>
        <div style={S.homeReelGroup}>
          <div style={S.homeFilmHeader}>
            {/* Single-line title for category pages — uses the same glitched
                LivingHell font as the home title's bottom word, sized to fit
                the header band. The `label` prop already handles the wording
                (e.g. "Hauntings", "True Crime"). */}
            <div
              style={{
                ...S.titleStackBottom,
                fontFamily: '"LivingHell", "Jolly Lodger", system-ui, serif',
                color: color,
                textShadow: `0 0 14px ${color}cc, 0 0 28px ${color}66`,
              }}
              className="sinister-glitch"
              data-text={label}
            >
              {label}
            </div>
          </div>

          {/* Search bar sits between header and filmstrip. Hidden on empty
              category since there's nothing to search through. */}
          {sites.length >= 1 && (
            <div style={{ ...S.searchWrap, marginBottom: 8 }}>
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

          <div style={S.homeReelCenter}>
            <div style={S.filmstripOuter}>
              <SprocketColumn ref={sprocketLeftRef} side="left" />
              <SprocketColumn ref={sprocketRightRef} side="right" />
              <div ref={scrollRef} style={S.filmstripWrap}>
                <div style={S.filmstripFrames}>
                {sequenceLength === 0 ? (
                  <div style={S.emptyState}>
                    <div style={S.emptyStateIcon}>🕯</div>
                    <div style={S.emptyStateTitle}>
                      {sites.length === 0 ? 'No sites here yet' : 'Nothing matches'}
                    </div>
                    <div style={S.emptyStateBody}>
                      {sites.length === 0
                        ? `No ${label.toLowerCase()} have been catalogued yet. Be the first — submit a location below.`
                        : `Nothing matches "${query}". Try a different search.`}
                    </div>
                  </div>
                ) : cellsLooped.map((entry) => (
                  <button
                    key={entry.id}
                    data-cell="1"
                    className="sinister-pressable"
                    onClick={() => handleClick(entry)}
                    style={{
                      ...S.filmFrame,
                      backgroundImage: entry.site.imageUrl
                        ? `url(${entry.site.imageUrl})`
                        : 'linear-gradient(180deg, #1a0f0f 0%, #0a0a0a 100%)',
                    }}
                  >
                    <div style={S.filmFrameOverlay} />
                    <div style={S.filmFrameContent}>
                      {/* Most site titles look great at the full 48pt
                          home-style font. But long submissions like
                          "The Cavalier Hotel & Beach Club Resort" would
                          overflow at 48pt — for those we drop to a
                          smaller (36pt) variant that wraps to 2 lines.
                          Threshold is character-count; tuned by eye to
                          where 48pt starts looking cramped. */}
                      <div style={entry.site.title.length > 22 ? S.filmFrameLabelSite : S.filmFrameLabel}>
                        {entry.site.title}
                      </div>
                      <div style={S.filmFrameCount}>
                        {entry.site.state}
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

      {/* Mirror HomeView's bottom controls — Submit Location button always
          visible above the SocialBar, exactly as on the home page. This is the
          primary CTA for populating the category. */}
      <button
        className="sinister-pressable"
        onClick={onSubmit}
        style={S.submitFixedButton}
      >
        <span style={S.submitFixedButtonText}>SUBMIT A LOCATION</span>
      </button>
    </div>
  );
}

// ---------- DETAIL ----------
function DetailView({ site, currentLocation, handle, deviceId, alreadyVisited, onVisited, onBack }: {
  site: SinisterSite;
  currentLocation: { lat: number; lng: number } | null;
  handle: string | null;
  deviceId: string | null;
  alreadyVisited: boolean;
  onVisited: (siteId: string) => void;
  onBack: () => void;
}) {
  // Hide the iOS document scroll indicator while this view is mounted.
  // The CSS rule for body[data-view="detail"] handles the actual hiding;
  // we just toggle the attribute. Set on both documentElement (html) and
  // body because iOS WKWebView is inconsistent about which element is
  // the actual document scroller across versions. Cleared on unmount so
  // other views are unaffected.
  useEffect(() => {
    document.body.setAttribute('data-view', 'detail');
    document.documentElement.setAttribute('data-view', 'detail');
    return () => {
      if (document.body.getAttribute('data-view') === 'detail') {
        document.body.removeAttribute('data-view');
      }
      if (document.documentElement.getAttribute('data-view') === 'detail') {
        document.documentElement.removeAttribute('data-view');
      }
    };
  }, []);
  const color = CATEGORY_COLOR[site.category as CategoryKey] || WHITE;
  const distM = currentLocation ? distanceMeters(currentLocation.lat, currentLocation.lng, site.coords.lat, site.coords.lng) : null;
  const distMi = distM ? (distM / 1609.34).toFixed(1) : null;

  // ---- I'm Here button state ----
  // The button has three visual states once a GPS fix is available:
  //   visited  → "✓ You've Been Here" (green, no action)
  //   inRange  → "I'm Here — Claim Visit" (red, tappable)
  //   tooFar   → disabled with "Xm away — get within 100m to claim"
  // If no GPS fix yet, the whole block is hidden. Distance check uses the
  // same 100m radius the server enforces; server re-verifies on claim, so
  // this is just a UX gate, not the security check.
  const VISIT_RADIUS_M = 100;
  const inRange = distM != null && distM <= VISIT_RADIUS_M;
  const [visited, setVisited] = useState<boolean>(alreadyVisited);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);

  // Sync local visited flag if parent's set updates (e.g. new visits loaded
  // from server while this view is mounted).
  useEffect(() => {
    if (alreadyVisited) setVisited(true);
  }, [alreadyVisited]);

  const handleClaimVisit = async () => {
    if (!handle) {
      setClaimError('Claim a handle first (try Submit a Location)');
      return;
    }
    if (!deviceId) {
      setClaimError('Device not ready, try again in a moment');
      return;
    }
    if (!currentLocation) {
      setClaimError('No GPS fix yet — try again in a moment');
      return;
    }
    setClaiming(true);
    setClaimError(null);
    playBell();
    const result = await apiClaimVisit({
      handle,
      deviceId,
      siteId: site.id,
      lat: currentLocation.lat,
      lng: currentLocation.lng,
    });
    setClaiming(false);
    if (result.ok) {
      setVisited(true);
      onVisited(site.id);
      // Soft confirmation toast — reinforces the badge system by hinting
      // at progression. Idempotent claims (already visited) get a gentler
      // message that doesn't pretend they earned anything new.
      if (result.alreadyClaimed) {
        showToast(`Already visited ${site.title}`, 'default');
      } else {
        showToast(`✓ Visited ${site.title} — +1 toward your next badge`, 'success');
      }
      return;
    }
    // Failure path. Pull fields off as the failure variant — narrowing this way
    // doesn't depend on TS flow analysis across the early return.
    const fail = result as Extract<VisitClaimResult, { ok: false }>;
    if (fail.code === 'too_far') {
      const m = fail.distance != null ? `${Math.round(fail.distance)}m` : '';
      setClaimError(`Server says you're ${m} away — must be within 100m.`);
    } else if (fail.code === 'network') {
      setClaimError('Network error — check your connection and try again.');
    } else {
      setClaimError(fail.message || 'Could not claim visit');
    }
  };
  const handleDirections = () => {
    playSubDrop();
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
        
      </header>
      <div style={{
        ...S.heroImage,
        backgroundImage: `url(${site.imageUrl})`,
        border: `2px solid ${SUBMIT_RED}`,
        boxShadow: `0 0 28px ${SUBMIT_RED}aa, 0 0 56px ${SUBMIT_RED}55, inset 0 -50px 80px ${BLACK}`,
      }} />
      <div style={S.detailBody}>
        {/* Title styled to match the home / category page titles: LivingHell
            font with the chromatic-aberration glitch effect. data-text mirrors
            content for the ::before/::after pseudo-elements that drive the
            red/cyan channel split. */}
        <div
          style={{
            ...S.detailTitle,
            fontFamily: '"LivingHell", "Jolly Lodger", system-ui, serif',
            textShadow: `0 0 18px ${color}cc, 0 0 36px ${color}66, 2px 2px 0 ${BLACK}`,
          }}
          className="sinister-glitch"
          data-text={site.title}
        >
          {site.title}
        </div>
        {distMi && <div style={{ ...S.detailDistance, color: color }}>📍 {distMi} mi from you</div>}
        {/* Submitter credit — recognizes the person who added this site to
            the catalog. Submitting takes more effort than visiting, so the
            credit sits prominently right under the title/distance, before
            the description. Falls back to "Sinister" for legacy seeded
            sites that don't have a submitter field stored. */}
        {(() => {
          const s = site as SinisterSite & { submitter?: string | null; approvedAt?: string | null };
          const submitter = s.submitter || 'Sinister';
          let dateStr = '';
          if (s.approvedAt) {
            try {
              const d = new Date(s.approvedAt);
              if (!isNaN(d.getTime())) {
                dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
              }
            } catch { /* silent */ }
          }
          return (
            <div style={S.detailSubmitterCredit}>
              <span style={S.detailSubmitterLabel}>Submitted by</span>
              <span style={S.detailSubmitterHandle}>@{submitter}</span>
              {dateStr && <span style={S.detailSubmitterDate}> · {dateStr}</span>}
            </div>
          );
        })()}
        <div style={{ ...S.detailDivider, backgroundColor: SUBMIT_RED, boxShadow: `0 0 12px ${SUBMIT_RED}` }} />
        <div style={S.detailDescription}>
          {(site.fullDescription || site.shortDescription || '').split('\n\n').map((para, i) => <p key={i} style={S.detailPara}>{para}</p>)}
        </div>
        {/* I'm Here button — only rendered when we have a GPS fix. Three
            visual modes: visited (green confirmation), in-range (red, active),
            out-of-range (disabled with distance hint). */}
        {currentLocation && (
          visited ? (
            <div
              style={{
                ...S.directionsButton,
                border: `2px solid #2a3f2a`,
                color: '#6ad06a',
                backgroundColor: '#0f2010',
                boxShadow: `0 0 18px #2a3f2a88, inset 0 0 12px #2a3f2a55`,
                textShadow: `0 0 8px #6ad06a`,
                cursor: 'default',
                marginBottom: 12,
              }}
            >
              ✓ You've Been Here
            </div>
          ) : inRange ? (
            <button
              onClick={handleClaimVisit}
              disabled={claiming}
              style={{
                ...S.directionsButton,
                border: `2px solid ${SUBMIT_RED}`,
                color: WHITE,
                backgroundColor: claiming ? '#3a0a0a' : '#5a0000',
                boxShadow: `0 0 22px ${SUBMIT_RED}aa, 0 0 44px ${SUBMIT_RED}55, inset 0 0 14px ${SUBMIT_RED}33`,
                textShadow: `0 0 10px ${SUBMIT_RED}`,
                marginBottom: 12,
                opacity: claiming ? 0.7 : 1,
              }}
            >
              {claiming ? 'Claiming…' : "I'm Here — Claim Visit"}
            </button>
          ) : (
            <div
              style={{
                ...S.directionsButton,
                border: `2px solid #2a2a2a`,
                color: '#888',
                backgroundColor: '#1a1a1a',
                boxShadow: 'none',
                cursor: 'not-allowed',
                marginBottom: 12,
                fontSize: 14,
              }}
            >
              {distM != null ? 'Get within 100m to claim location' : 'Locating…'}
            </div>
          )
        )}
        {claimError && (
          <div style={{ color: '#d97a7a', fontSize: 13, textAlign: 'center', marginBottom: 12 }}>
            {claimError}
          </div>
        )}
        <button
          onClick={handleDirections}
          style={{
            ...S.directionsButton,
            border: `2px solid ${SUBMIT_RED}`,
            color: color,
            boxShadow: `0 0 22px ${SUBMIT_RED}aa, 0 0 44px ${SUBMIT_RED}55, inset 0 0 14px ${SUBMIT_RED}33`,
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

// ---------- Inline handle claim UI for SubmitView ----------
// If the user has a server-claimed handle, just shows it read-only. If not,
// shows a small text input with live availability check + Claim button.
// Once claimed, the parent's onClaimed() fires, App's `handle` state updates,
// and on next render the field flips to the read-only display.
function HandleField({ deviceId, handle, submitter, setSubmitter, onClaimed }: {
  deviceId: string | null;
  handle: string | null;
  submitter: string;
  setSubmitter: (v: string) => void;
  onClaimed: (h: string) => void;
}) {
  // Read-only display path: user already owns a handle.
  if (handle) {
    return (
      <Field label="Your Handle" valid={true} hint="Verified handle — credited on the entry">
        <div style={{
          ...S.input,
          display: 'flex', alignItems: 'center', gap: 8,
          color: BONE, opacity: 0.95,
        }}>
          <span style={{ color: SUBMIT_RED, fontWeight: 700 }}>@</span>
          <span style={{ flex: 1 }}>{handle}</span>
          <span style={{ fontSize: 11, color: '#6f6', letterSpacing: '0.1em' }}>✓ CLAIMED</span>
        </div>
      </Field>
    );
  }

  // Claim path: user has no handle yet. Show input + live availability + Claim button.
  // We use submitter state as the typed value so we don't need a second piece
  // of state and the placeholder behaves naturally.
  return (
    <ClaimHandleInline
      deviceId={deviceId}
      typed={submitter}
      onTypedChange={setSubmitter}
      onClaimed={onClaimed}
    />
  );
}

function ClaimHandleInline({ deviceId, typed, onTypedChange, onClaimed }: {
  deviceId: string | null;
  typed: string;
  onTypedChange: (v: string) => void;
  onClaimed: (h: string) => void;
}) {
  const [status, setStatus] = useState<'idle' | 'checking' | 'available' | 'taken' | 'invalid'>('idle');
  const [statusMsg, setStatusMsg] = useState<string>('');
  const [claiming, setClaiming] = useState(false);
  const [claimErr, setClaimErr] = useState<string | null>(null);
  const debounceRef = useRef<number | null>(null);

  // Live availability check, debounced 350ms after the last keystroke.
  useEffect(() => {
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const trimmed = typed.trim();
    if (trimmed.length === 0) {
      setStatus('idle');
      setStatusMsg('');
      return;
    }
    setStatus('checking');
    setStatusMsg('checking...');
    debounceRef.current = window.setTimeout(async () => {
      const r = await apiCheckHandle(trimmed);
      if (r.available) {
        setStatus('available');
        setStatusMsg('available');
      } else {
        // Distinguish "format/reserved/profanity" (invalid) from "already taken".
        if (r.reason && r.reason.toLowerCase().includes('taken')) {
          setStatus('taken');
          setStatusMsg('taken');
        } else {
          setStatus('invalid');
          setStatusMsg(r.reason || 'invalid');
        }
      }
    }, 350);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [typed]);

  async function doClaim() {
    if (status !== 'available') return;
    if (!deviceId) {
      setClaimErr('Device id not ready yet — try again in a moment.');
      return;
    }
    setClaiming(true);
    setClaimErr(null);
    try {
      const r = await apiClaimHandle(typed.trim(), deviceId);
      if (r.ok && r.handle) {
        onClaimed(r.handle);
      } else {
        setClaimErr(r.reason || 'Claim failed.');
      }
    } catch (err: any) {
      setClaimErr(err?.message || 'Claim failed.');
    } finally {
      setClaiming(false);
    }
  }

  const statusColor =
    status === 'available' ? '#6f6' :
    status === 'taken' ? '#f66' :
    status === 'invalid' ? '#fc6' :
    BONE;

  return (
    <Field label="Pick a Handle" valid={status === 'available'} hint="3-20 chars · letters, numbers, underscores · this is your forever name">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          type="text"
          value={typed}
          onChange={(e) => onTypedChange(e.target.value.replace(/[^A-Za-z0-9_]/g, ''))}
          placeholder="e.g. drew_horror"
          maxLength={20}
          style={S.input}
          disabled={claiming}
        />
        {statusMsg && (
          <div style={{ fontSize: 12, color: statusColor, letterSpacing: '0.1em' }}>
            {status === 'available' ? '✓ ' : status === 'taken' ? '✗ ' : status === 'invalid' ? '⚠ ' : ''}{statusMsg}
          </div>
        )}
        {claimErr && (
          <div style={{ fontSize: 12, color: '#f66', letterSpacing: '0.05em' }}>⚠ {claimErr}</div>
        )}
        <button
          type="button"
          onClick={doClaim}
          disabled={status !== 'available' || claiming || !deviceId}
          style={{
            padding: '12px 16px',
            border: `2px solid ${status === 'available' ? SUBMIT_RED : '#444'}`,
            background: 'transparent',
            color: status === 'available' ? '#fff' : '#666',
            fontFamily: 'inherit',
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: '0.18em',
            borderRadius: 12,
            cursor: status === 'available' && !claiming ? 'pointer' : 'not-allowed',
          }}
        >
          {claiming ? 'CLAIMING...' : 'CLAIM HANDLE'}
        </button>
      </div>
    </Field>
  );
}

// ---------- SUBMIT ----------
// Short Description field REMOVED. The server's `shortDescription` parameter is
// derived from the first ~150 chars of the full description so the existing
// /sites/submit endpoint still gets a value (it requires shortDescription).
function SubmitView({ currentLocation, deviceId, handle, onHandleClaimed, onBack }: {
  currentLocation: { lat: number; lng: number } | null;
  deviceId: string | null;
  handle: string | null;
  onHandleClaimed: (h: string) => void;
  onBack: () => void;
}) {
  const [title, setTitle] = useState('');
  const [fullDesc, setFullDesc] = useState('');
  const [category, setCategory] = useState<CategoryKey>('crime');
  // Seed from the server-claimed handle (if any) so the form ships with the
  // user's real identity already filled in instead of an empty box.
  const [submitter, setSubmitter] = useState(handle || '');
  // Keep submitter in sync if handle changes mid-form (e.g. user just claimed it).
  useEffect(() => { if (handle && !submitter) setSubmitter(handle); }, [handle]);
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
  const fullOk      = fullDesc.trim().length >= 20 && fullDesc.trim().length <= 500;
  // Submission requires a server-claimed handle. Free-text entry was the old
  // model; new model proves ownership via deviceId so badges can be tied to
  // a real persistent identity.
  const submitterOk = !!handle && submitter.trim().length >= 2 && submitter.trim().length <= 30;
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
      // Identity: handle (the user's claimed @name) and deviceId (proof of
      // ownership). Server uses the pair to attribute the submission for
      // future badges; sites.js will validate the pair if it knows about
      // /handles. If not, these are silently ignored — backward compatible.
      if (handle) fd.append('handle', handle);
      if (deviceId) fd.append('deviceId', deviceId);
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
            
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={S.appBg}>
      <header style={S.header}>
        
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

        <Field label="Description" valid={fullOk} hint="20-500 characters — the full story">
          <textarea value={fullDesc} onChange={(e) => setFullDesc(e.target.value)}
                    placeholder="When, who, what happened — the whole story."
                    maxLength={500} rows={6} style={{ ...S.input, ...S.textarea }} />
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

        {/* Handle field — driven by the server-claimed handle when one exists.
            If the user hasn't claimed yet, a small inline form does it now.
            We reuse the existing submitter state so downstream code (success
            message, server payload) doesn't care which path produced it. */}
        <HandleField
          deviceId={deviceId}
          handle={handle}
          submitter={submitter}
          setSubmitter={setSubmitter}
          onClaimed={(h) => { setSubmitter(h); onHandleClaimed(h); }}
        />

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

  // ---------- Latest Submission Spotlight ----------
  // Sits absolutely-positioned inside homeReelGroup so it doesn't disturb
  // either the title block (above) or the centered filmstrip (below).
  // The cell is locked to viewport center via top: 50% on homeReelCenter,
  // so the cell's TOP edge is at roughly (50vh - 124px) since the cell is
  // 248px tall. The header bottom (BY SINISTER) sits at roughly 60+title
  // height down from the top — plenty of clearance from the cell top.
  // The spotlight goes vertically halfway between those: a top value of
  // calc(50% - 175px) places it ~50px above the cell with comfortable
  // clearance above for the title block too.
  // Width is left/right margin-bound so it never overlaps the cell.
  latestSpotlight: {
    position: 'absolute',
    top: 'calc(50% - 175px)',
    left: '50%',
    transform: 'translateX(-50%)',
    backgroundColor: 'rgba(10,10,10,0.55)',
    border: `1px solid ${SINISTER_RED}55`,
    borderRadius: 12,
    padding: '8px 18px',
    minWidth: 240,
    maxWidth: '88vw',
    cursor: 'pointer',
    pointerEvents: 'auto',
    color: BONE,
    textAlign: 'center' as const,
    boxShadow: `0 0 18px ${SINISTER_RED}33, 0 0 4px ${BLACK}99`,
    backdropFilter: 'blur(2px)',
    zIndex: 3,
    // Subtle pulsing glow so it draws the eye but isn't garish.
    animation: 'sinister-spotlight-pulse 4.5s ease-in-out infinite',
    transformOrigin: 'center center',
  },
  latestSpotlightLabel: {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.32em',
    color: SINISTER_RED,
    textShadow: `0 0 8px ${SINISTER_RED}cc`,
    marginBottom: 3,
  },
  latestSpotlightTitle: {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: 14,
    fontWeight: 700,
    letterSpacing: '0.06em',
    color: WHITE,
    textShadow: `0 0 10px ${WHITE}66, 1px 1px 0 ${BLACK}`,
    lineHeight: 1.2,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  latestSpotlightBy: {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.18em',
    color: '#8a7f70',
    marginTop: 3,
  },
  latestSpotlightHandle: {
    color: SINISTER_RED,
    textShadow: `0 0 6px ${SINISTER_RED}88`,
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
  // Variant of filmFrameLabel for site cells in CategoryView. Smaller
  // base size + 2-line clamp so long site names like "The Cavalier
  // Hotel & Beach Club Resort" don't overflow. Same font/color/animation
  // so the visual identity is preserved.
  filmFrameLabelSite: {
    fontSize: 36,
    fontFamily: '"Jolly Lodger", system-ui, serif',
    color: '#FFFFFF',
    letterSpacing: '0.03em',
    lineHeight: 1.05,
    textShadow: '0 0 14px #000, 0 0 24px rgba(0,0,0,0.85), 1px 1px 0 #000, 2px 2px 6px rgba(0,0,0,0.9)',
    animation: 'sinister-cell-title-pulse 3.5s ease-in-out infinite',
    transformOrigin: 'center center',
    display: '-webkit-box' as any,
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical' as any,
    overflow: 'hidden' as const,
    maxWidth: '90%',
    padding: '0 8px',
    boxSizing: 'border-box' as const,
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
  // Restyled to match the "BY SINISTER" tagline under the main logo: system
  // bold sans-serif, uppercase, sinister red with a red glow. Bumped in
  // size from the original 26pt Jolly Lodger so it reads as the primary
  // call-to-action — submissions are how the catalog grows, so this needs
  // to grab the eye on the home page and on every category view.
  submitFixedButton: {
    position: 'fixed',
    left: '50%',
    // Lifted from bottom: 70 to 110 so there's a clear visual gap above
    // the bottom social bar (Dread Leaders / List / About) at bottom: 14.
    // That separation makes Submit read as the primary action, since
    // submissions are how the app's catalog grows.
    bottom: 110,
    transform: 'translateX(-50%)',
    zIndex: 3,
    backgroundColor: 'transparent',
    border: `2px solid ${SINISTER_RED}`,
    color: SINISTER_RED,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: 18,
    fontWeight: 700,
    letterSpacing: '0.22em',
    textTransform: 'uppercase' as const,
    padding: '14px 34px',
    borderRadius: 12,
    cursor: 'pointer',
    boxShadow: `0 0 16px ${SINISTER_RED}aa, 0 0 32px ${SINISTER_RED}55, inset 0 0 12px rgba(193,43,43,0.15)`,
    textShadow: `0 0 10px ${SINISTER_RED}, 0 0 18px ${SINISTER_RED}88`,
  },
  // Inner span on the submit button so just the TEXT pulses (button frame
  // stays still). Same animation as filmstrip cell titles for consistency.
  submitFixedButtonText: {
    display: 'inline-block',
    animation: 'sinister-cell-title-pulse 3.5s ease-in-out infinite',
    transformOrigin: 'center center',
  },

  // ---- Toast styles ----
  // Stack of small notifications above the bottom social bar. Each toast
  // is its own pill with a soft glow tinted by tone. Centered horizontally
  // with a max-width so they never feel crammed on small screens or stretch
  // weirdly on iPad.
  toastWrap: {
    position: 'fixed',
    left: 0,
    right: 0,
    bottom: 80, // just above the bottom social bar (which sits at 14px)
    zIndex: 50,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 8,
    padding: '0 16px',
    pointerEvents: 'none' as const,
  },
  toast: {
    maxWidth: 380,
    padding: '12px 16px',
    borderRadius: 12,
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: '0.02em',
    textAlign: 'center' as const,
    boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
    backdropFilter: 'blur(8px)',
    pointerEvents: 'auto' as const,
    color: BONE,
  },
  toastDefault: {
    backgroundColor: 'rgba(20,20,20,0.92)',
    border: `1px solid ${WHITE}33`,
  },
  toastSuccess: {
    backgroundColor: 'rgba(15, 32, 16, 0.95)',
    border: '1px solid #2a3f2a',
    color: '#a3e6a3',
    boxShadow: '0 4px 24px rgba(0,0,0,0.5), 0 0 16px rgba(106,208,106,0.3)',
  },
  toastError: {
    backgroundColor: 'rgba(31, 16, 16, 0.95)',
    border: '1px solid #3a2020',
    color: '#e6a3a3',
    boxShadow: '0 4px 24px rgba(0,0,0,0.5), 0 0 16px rgba(217,122,122,0.3)',
  },

  socialBar: {
    position: 'fixed',
    left: 0, right: 0,
    bottom: 14,
    zIndex: 10,
    display: 'flex',
    justifyContent: 'center',
    gap: 8,
    padding: '0 12px',
    boxSizing: 'border-box',
  },
  // Pill button used in the home bottom bar. Wider than the original 3-button
  // layout since there are now only 2 (Locations Near Me / More) sharing the
  // available width.
  //
  // Typography matches the "X Locations" count text under each home cell —
  // system bold sans-serif with wide letter-spacing — so the bottom bar
  // reads as the same family of supporting UI text instead of a random
  // third font.
  socialBtn: {
    flex: 1,
    maxWidth: 200,
    backgroundColor: 'rgba(0,0,0,0.45)',
    border: `1.5px solid ${WHITE}`,
    color: WHITE,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: 14,
    fontWeight: 700,
    letterSpacing: '0.18em',
    textTransform: 'uppercase' as const,
    padding: '10px 12px',
    borderRadius: 14,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    boxShadow: `0 0 10px ${WHITE}33`,
    backdropFilter: 'blur(2px)',
  },
  // Variant applied to the More button while its popup is open. Gives a
  // brighter glow + slightly stronger shadow so the user gets visual
  // feedback that the menu is anchored to that button.
  socialBtnActive: {
    boxShadow: `0 0 16px ${WHITE}88, 0 0 28px ${WHITE}33`,
    textShadow: `0 0 8px ${WHITE}aa`,
  },
  socialIcon: { fontSize: 16, lineHeight: 1 },
  socialLabel: { fontSize: 14 },

  // ---- More menu popup ----
  // Anchored above the More button (right-aligned). Sits at zIndex 11 so it
  // floats over the home bottom bar (zIndex 10) and the page content. Width
  // bumped to 220 so the wider letter-spacing on the labels has room.
  moreMenuWrap: {
    position: 'fixed',
    bottom: 70,
    right: 14,
    zIndex: 11,
    minWidth: 220,
    backgroundColor: 'rgba(13, 13, 13, 0.97)',
    border: `1px solid ${WHITE}55`,
    borderRadius: 12,
    overflow: 'hidden',
    boxShadow: `0 0 20px rgba(0,0,0,0.7), 0 0 28px ${WHITE}22`,
    backdropFilter: 'blur(6px)',
  },
  // Items in the More popup. Same typographic family as socialBtn (system
  // bold sans, wide letter-spacing, uppercase) so opening the menu doesn't
  // suddenly switch fonts on the user.
  moreMenuItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    boxSizing: 'border-box' as const,
    padding: '14px 16px',
    backgroundColor: 'transparent',
    border: 'none',
    color: BONE,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: '0.18em',
    textTransform: 'uppercase' as const,
    cursor: 'pointer',
    textAlign: 'left' as const,
  },
  moreMenuLabel: { flex: 1 },
  moreMenuDivider: {
    height: 0,
    borderTop: '0.5px solid rgba(255,255,255,0.1)',
  },

  // ---- Map View styles ----
  // Circular back button — small, glowing left chevron. Positioned
  // absolutely against the bottom-left of the header so it sits right
  // above the map edge, leaving the full header width for the title to
  // render on a single line. The position values match the header's
  // own paddingLeft / paddingBottom so it lines up cleanly inside the
  // header's gutters.
  mapBackBtn: {
    position: 'absolute' as const,
    left: 12,
    bottom: 12,
    zIndex: 2,
    width: 36,
    height: 36,
    backgroundColor: 'rgba(0,0,0,0.6)',
    border: `1.5px solid ${WHITE}`,
    color: WHITE,
    fontFamily: 'inherit',
    fontSize: 22,
    fontWeight: 700,
    lineHeight: 1,
    padding: 0,
    paddingBottom: 3,
    borderRadius: '50%',
    cursor: 'pointer',
    boxShadow: `0 0 10px ${WHITE}55`,
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Slide-up site preview card. Sits at the bottom of the map, overlaying
  // the lower ~30% of the viewport. Tap on the card stops propagation so
  // the map's "tap background to dismiss" handler doesn't fire.
  mapCard: {
    position: 'fixed',
    left: 12,
    right: 12,
    bottom: 12,
    zIndex: 11,
    backgroundColor: 'rgba(13,13,13,0.97)',
    border: `1px solid ${SUBMIT_RED}77`,
    borderRadius: 16,
    padding: '14px 14px 12px',
    boxShadow: `0 0 30px rgba(0,0,0,0.85), 0 0 22px ${SUBMIT_RED}33`,
    backdropFilter: 'blur(8px)',
    color: BONE,
  },
  mapCardClose: {
    position: 'absolute',
    top: 6,
    right: 8,
    width: 28,
    height: 28,
    background: 'transparent',
    border: 'none',
    color: '#aaa',
    fontSize: 22,
    lineHeight: 1,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  mapCardTop: {
    display: 'flex',
    gap: 12,
    alignItems: 'flex-start',
    paddingRight: 24,
    marginBottom: 12,
  },
  mapCardThumb: {
    width: 72,
    height: 72,
    borderRadius: 8,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
    border: '1px solid #2a2a2a',
    flexShrink: 0,
  },
  mapCardText: {
    flex: 1,
    minWidth: 0,
  },
  mapCardTitle: {
    fontSize: 15,
    fontWeight: 800,
    letterSpacing: '0.02em',
    color: WHITE,
    marginBottom: 4,
    lineHeight: 1.25,
  },
  mapCardMeta: {
    fontSize: 11,
    color: '#aaa',
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase' as const,
    marginBottom: 8,
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 4,
    alignItems: 'baseline',
  },
  mapCardMetaSep: { opacity: 0.5 },
  mapCardDesc: {
    fontSize: 12,
    color: '#bbb',
    lineHeight: 1.4,
    // Truncate to 2 lines so the card stays compact regardless of how
    // long the site's shortDescription is.
    display: '-webkit-box' as const,
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical' as const,
    overflow: 'hidden' as const,
  },
  mapCardActions: {
    display: 'flex',
    gap: 8,
  },
  mapCardBtn: {
    flex: 1,
    padding: '10px 12px',
    fontFamily: 'inherit',
    fontSize: 12,
    fontWeight: 800,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    borderRadius: 10,
    cursor: 'pointer',
  },
  mapCardBtnSecondary: {
    backgroundColor: 'transparent',
    border: `1px solid ${WHITE}66`,
    color: WHITE,
  },
  mapCardBtnPrimary: {
    backgroundColor: '#5a0000',
    border: `1px solid ${SUBMIT_RED}`,
    color: WHITE,
    boxShadow: `0 0 12px ${SUBMIT_RED}77`,
    textShadow: `0 0 6px ${SUBMIT_RED}`,
  },

  aboutBody: {
    padding: '20px 24px 80px',
    position: 'relative',
    zIndex: 1,
    color: BONE,
    maxWidth: 600,
    margin: '0 auto',
  },
  aboutPara: { fontSize: 14, lineHeight: 1.6, marginBottom: 14 },

  // Empty state — used when a list/grid has zero results to show. Shared
  // across CategoryView (no sites in category yet, or search filtered to
  // nothing) and ListView (every level's empty case). Centered with a
  // small icon, a strong title, and a helpful body line so empty screens
  // never feel broken.
  emptyState: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    textAlign: 'center' as const,
    padding: '60px 28px',
    gap: 10,
  },
  emptyStateIcon: {
    fontSize: 38,
    opacity: 0.55,
    filter: 'grayscale(0.3)',
  },
  emptyStateTitle: {
    fontSize: 17,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontWeight: 700,
    letterSpacing: '0.18em',
    textTransform: 'uppercase' as const,
    color: '#cfc6b6',
  },
  emptyStateBody: {
    fontSize: 13,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    color: '#8a7f70',
    lineHeight: 1.55,
    maxWidth: 320,
  },
  // Section divider for the About page — small caps banner with a thin
  // underline. Used to separate the How-To content from the brand /
  // submission policy blurb so the page scans cleanly without feeling like
  // a wall of text.
  aboutSectionHeader: {
    fontSize: 12,
    fontWeight: 900,
    letterSpacing: '0.28em',
    textTransform: 'uppercase' as const,
    color: WHITE,
    textShadow: `0 0 8px ${WHITE}88`,
    marginTop: 28,
    marginBottom: 14,
    paddingBottom: 8,
    borderBottom: '1px solid #2a2a2a',
  },

  // ---- Dread Leaders / Badges styles ----
  // Body uses the same width constraint as aboutBody so the leaderboard
  // doesn't sprawl on tablets, but uses tighter vertical padding because
  // the row list provides its own rhythm.
  leaderBody: {
    padding: '8px 20px 80px',
    position: 'relative',
    zIndex: 1,
    color: BONE,
    maxWidth: 600,
    margin: '0 auto',
    boxSizing: 'border-box',
  },
  leaderTabs: {
    display: 'flex',
    gap: 8,
    padding: '4px 20px 16px',
    maxWidth: 600,
    margin: '0 auto',
    boxSizing: 'border-box',
  },
  leaderTab: {
    flex: 1,
    backgroundColor: 'transparent',
    border: '2px solid #2a2a2a',
    color: '#888',
    padding: '10px',
    fontSize: 12,
    fontWeight: 800,
    letterSpacing: '0.18em',
    borderRadius: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
    textTransform: 'uppercase' as const,
  },
  leaderTabActive: {
    border: `2px solid ${WHITE}`,
    color: WHITE,
    textShadow: `0 0 8px ${WHITE}aa`,
    boxShadow: `0 0 14px ${WHITE}44, inset 0 0 10px ${WHITE}22`,
  },
  leaderMineBtn: {
    width: '100%',
    boxSizing: 'border-box' as const,
    backgroundColor: 'transparent',
    padding: '12px',
    fontSize: 12,
    fontWeight: 800,
    letterSpacing: '0.15em',
    cursor: 'pointer',
    borderRadius: 12,
    fontFamily: 'inherit',
    textShadow: `0 0 8px ${WHITE}88`,
    boxShadow: `0 0 12px ${WHITE}33, inset 0 0 8px ${WHITE}22`,
  },
  leaderList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
    marginTop: 8,
  },
  leaderRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    width: '100%',
    boxSizing: 'border-box' as const,
    padding: '12px 14px',
    background: '#0d0d0d',
    border: '1px solid #1f1f1f',
    borderRadius: 10,
    color: BONE,
    fontFamily: 'inherit',
    cursor: 'pointer',
    textAlign: 'left' as const,
  },
  leaderRowMe: {
    border: `1px solid ${SUBMIT_RED}66`,
    boxShadow: `0 0 12px ${SUBMIT_RED}44, inset 0 0 8px ${SUBMIT_RED}22`,
    background: '#150808',
  },
  leaderRank: {
    fontSize: 14,
    fontWeight: 900,
    color: '#666',
    minWidth: 24,
    letterSpacing: '0.1em',
  },
  leaderHandle: {
    flex: 1,
    fontSize: 14,
    fontWeight: 700,
    letterSpacing: '0.05em',
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  leaderCount: {
    fontSize: 11,
    color: '#888',
    fontWeight: 600,
    letterSpacing: '0.08em',
  },

  // Badges grid — auto-fitting cards so it works on phone & tablet alike.
  badgeGroupTitle: {
    fontSize: 13,
    fontWeight: 900,
    letterSpacing: '0.22em',
    textTransform: 'uppercase' as const,
    marginBottom: 12,
    paddingBottom: 6,
    borderBottom: '1px solid #1f1f1f',
  },
  badgeGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
    gap: 10,
  },
  badgeCard: {
    background: '#0d0d0d',
    border: '1px solid #1f1f1f',
    borderRadius: 12,
    padding: '14px 10px',
    textAlign: 'center' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 6,
  },
  badgeIcon: {
    fontSize: 32,
    lineHeight: 1,
  },
  badgeLabel: {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.05em',
    color: BONE,
  },
  badgeMeta: {
    fontSize: 10,
    color: '#777',
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
  },
  badgeStats: {
    display: 'flex',
    gap: 12,
    marginBottom: 24,
    marginTop: 4,
  },
  badgeStatCell: {
    flex: 1,
    background: '#0d0d0d',
    border: '1px solid #1f1f1f',
    borderRadius: 12,
    padding: '14px 10px',
    textAlign: 'center' as const,
  },
  badgeStatNum: {
    fontSize: 28,
    fontWeight: 900,
    lineHeight: 1.1,
    letterSpacing: '0.04em',
  },
  badgeStatLabel: {
    fontSize: 10,
    color: '#888',
    letterSpacing: '0.18em',
    textTransform: 'uppercase' as const,
    marginTop: 4,
    fontWeight: 700,
  },

  // ---- List View styles ----
  // Search bar wrap matches the same horizontal padding as the body and
  // the leader/about views so the layout aligns vertically across screens.
  listSearchWrap: {
    display: 'flex',
    padding: '4px 20px 16px',
    maxWidth: 600,
    margin: '0 auto',
    boxSizing: 'border-box' as const,
    width: '100%',
  },
  // Subtitle under the level title — used at level 2/3 to give a hint of
  // what the user is choosing from. Small, dim, all-caps for that catalog feel.
  listSubtitle: {
    fontSize: 11,
    color: '#888',
    letterSpacing: '0.22em',
    textTransform: 'uppercase' as const,
    fontWeight: 700,
    marginTop: 4,
    textAlign: 'center' as const,
  },
  // In-component back bar — sits between header and search to give users
  // a visible "step back one level" affordance without forcing them to
  // swipe out of List View entirely.
  listBackBar: {
    padding: '0 20px 4px',
    maxWidth: 600,
    margin: '0 auto',
    boxSizing: 'border-box' as const,
    width: '100%',
  },
  listBackBtn: {
    background: 'transparent',
    border: '1px solid #2a2a2a',
    color: '#aaa',
    padding: '8px 14px',
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.15em',
    borderRadius: 8,
    cursor: 'pointer',
    fontFamily: 'inherit',
    textTransform: 'uppercase' as const,
  },
  listSitesWrap: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },
  // Category-row variant — slightly taller and uses a border/glow tint
  // matched to the category color so the level-1 picker feels distinct
  // from the state and site rows below it.
  listCategoryRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    width: '100%',
    boxSizing: 'border-box' as const,
    padding: '16px 14px',
    background: '#0d0d0d',
    border: '1px solid',
    borderRadius: 10,
    color: BONE,
    fontFamily: 'inherit',
    cursor: 'pointer',
    textAlign: 'left' as const,
  },
  listRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    boxSizing: 'border-box' as const,
    padding: '11px 14px',
    background: '#0d0d0d',
    border: '1px solid #1f1f1f',
    borderRadius: 8,
    color: BONE,
    fontFamily: 'inherit',
    cursor: 'pointer',
    textAlign: 'left' as const,
  },
  listRowDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
  listRowTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: 700,
    letterSpacing: '0.04em',
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  listRowState: {
    fontSize: 10,
    color: '#777',
    fontWeight: 600,
    letterSpacing: '0.12em',
    textTransform: 'uppercase' as const,
    flexShrink: 0,
  },
  // "6 locations" count text — used on category and state rows.
  listRowCount: {
    fontSize: 11,
    color: '#888',
    fontWeight: 600,
    letterSpacing: '0.08em',
    flexShrink: 0,
  },
  // Right-side chevron indicating drill-down. Subtle, monochrome.
  listChevron: {
    fontSize: 18,
    color: '#555',
    flexShrink: 0,
    marginLeft: 4,
    lineHeight: 1,
  },
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
  // Submitter credit row — sits between distance and divider. Subtle
  // (smaller, less saturated) so it doesn't compete with the title for
  // attention but is visible enough that submitters feel recognized.
  detailSubmitterCredit: {
    fontSize: 12,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    color: '#9a8d7a',
    marginTop: -8,
    marginBottom: 14,
    letterSpacing: '0.08em',
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
    flexWrap: 'wrap' as const,
  },
  detailSubmitterLabel: {
    fontWeight: 400,
    color: '#7a6f5e',
    textTransform: 'uppercase' as const,
    fontSize: 10,
    letterSpacing: '0.18em',
  },
  detailSubmitterHandle: {
    fontWeight: 700,
    color: SUBMIT_RED,
    textShadow: `0 0 10px ${SUBMIT_RED}66`,
  },
  detailSubmitterDate: {
    color: '#7a6f5e',
    fontWeight: 400,
  },
  detailDivider: { height: 2, margin: '18px 0', borderRadius: 2 },
  detailDescription: { fontSize: 15, lineHeight: 1.65, color: BONE },
  detailPara: { marginBottom: 16 },
  directionsButton: { width: '100%', boxSizing: 'border-box', backgroundColor: 'transparent', padding: '16px', fontSize: 14, fontWeight: 900, letterSpacing: '0.15em', cursor: 'pointer', marginTop: 18, fontFamily: 'inherit', borderRadius: 16 },
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
