// @ts-ignore — Vite handles .ttf imports as URL strings
declare module '*.ttf' { const url: string; export default url; }
declare module '*.png' { const url: string; export default url; }
declare module '*.svg' { const url: string; export default url; }

import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  startGeofencing,
  stopGeofencing,
  requestPermissions,
  distanceMeters,
  setSites,
} from './geofencing';
import LivingHellFontUrl from './assets/Living Hell.ttf';
import PunkFontUrl from './assets/punk.ttf';
import SlideMountUrl from './assets/slide-mount.png';
// Custom bottom-bar icons (rounded-square iOS-style app icons) for the
// home page bar — replace the prior text labels + "More" dropdown.
import listIconUrl from './assets/list.png';
import exposureIconUrl from './assets/exposure.png';
import leaderIconUrl from './assets/leader.png';
import aboutIconUrl from './assets/about.png';
import locationIconUrl from './assets/location.png';

// Resolve a server-returned avatarUrl string into a renderable URL.
// Two shapes the server may return:
//   - null / undefined: caller falls back to default (exposureIconUrl)
//   - 'https://...':    custom upload from R2 — returned as-is
// We previously also supported 'library:<id>' for bundled SVG library
// avatars, but Drew killed that path — uploads only.
function resolveAvatarUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.startsWith('http')) return raw;
  return null;
}

// Register the Living Hell font face once at module load.
if (typeof document !== 'undefined' && !document.getElementById('__livinghell-fontface')) {
  const style = document.createElement('style');
  style.id = '__livinghell-fontface';
  style.textContent = `@font-face { font-family: 'LivingHell'; src: url('${LivingHellFontUrl}') format('truetype'); font-display: block; }`;
  document.head.appendChild(style);
}

// Register the punk ransom-note font ("Hit me, punk! 01"). Used as the
// brand title font in the eXposure header. The internal font family name
// inside the .ttf is "Hit me, punk! 01" — we keep that exact string here
// and reference it in fontFamily declarations below.
if (typeof document !== 'undefined' && !document.getElementById('__punk-fontface')) {
  const style = document.createElement('style');
  style.id = '__punk-fontface';
  style.textContent = `@font-face { font-family: 'Hit me, punk! 01'; src: url('${PunkFontUrl}') format('truetype'); font-display: block; }`;
  document.head.appendChild(style);
}
import { SINISTER_SITES as FALLBACK_SITES, SinisterSite } from './locations';

// ---------- Production server URL ----------
const API_BASE = 'https://dread.sinistertrivia.com';

// ---------- Platform detection ----------
// Returns true when running on iOS (native app via Capacitor) and false on
// Android or web. Apple-specific UI (Sign in with Apple buttons, the "Link
// your Apple ID" migration prompt, etc.) must hide on Android because the
// @capacitor-community/apple-sign-in plugin only works on iOS. We read
// Capacitor's platform via the global it injects at runtime (avoids an
// additional import dependency).
function isIOS(): boolean {
  try {
    // Capacitor injects window.Capacitor with getPlatform() returning
    // 'ios' | 'android' | 'web'.
    const cap = (window as any)?.Capacitor;
    if (cap && typeof cap.getPlatform === 'function') {
      return cap.getPlatform() === 'ios';
    }
    // Fallback for non-Capacitor environments (e.g. dev web preview): use
    // userAgent. iPad on iOS 13+ reports as Mac, so also check touchpoints.
    const ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    if (/Mac/.test(ua) && (navigator as any).maxTouchPoints > 1) return true;
    return false;
  } catch {
    return false;
  }
}

// ---------- YouTube URL parsing ----------
// Pulls the 11-char video ID out of any standard YouTube URL the user
// might paste. Supports:
//   - https://www.youtube.com/watch?v=ID
//   - https://m.youtube.com/watch?v=ID
//   - https://youtu.be/ID
//   - https://www.youtube.com/shorts/ID
//   - https://www.youtube.com/embed/ID
//   - https://www.youtube.com/v/ID
//   - bare ID strings (11 chars, URL-safe base64 alphabet)
// Returns null if nothing valid is found. The server validates the ID
// shape again with the same regex, so an invalid paste fails fast on
// either side.
function extractYouTubeId(input: string): string | null {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;

  // Bare 11-char ID — accept as-is.
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;

  // Try to parse as URL. If it doesn't parse, fall through to regex
  // scrape — handles cases like "youtube.com/..." without a scheme.
  let u: URL | null = null;
  try {
    u = new URL(s.startsWith('http') ? s : `https://${s}`);
  } catch {
    u = null;
  }

  if (u) {
    const host = u.hostname.replace(/^www\.|^m\./, '');
    // youtu.be/<id>
    if (host === 'youtu.be') {
      const id = u.pathname.replace(/^\//, '').split('/')[0];
      if (/^[A-Za-z0-9_-]{11}$/.test(id)) return id;
    }
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      // watch?v=<id>
      const v = u.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      // /shorts/<id>, /embed/<id>, /v/<id>, /live/<id>
      const m = u.pathname.match(/^\/(?:shorts|embed|v|live)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    }
  }

  // Last-ditch regex scrape — looks for any 11-char ID in the input
  // preceded by something that smells like a YouTube URL.
  const scrape = s.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|v\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (scrape) return scrape[1];

  return null;
}

// ---------- Native: Sign in with Apple ----------
// Wrapper around @capacitor-community/apple-sign-in. Dynamically imported
// so a web/desktop preview where the plugin isn't installed doesn't crash
// on module load — on iOS the plugin resolves and the native sheet opens.
// On non-iOS or when the plugin isn't available, returns { ok: false }.
//
// Returns the raw Apple identityToken on success — we hand it to
// /handles/sign-in-apple which verifies it against Apple's JWKS and
// extracts the stable user id + email.
async function nativeSignInWithApple(): Promise<
  | { ok: true; identityToken: string; email: string | null; user: string }
  | { ok: false; reason: string; cancelled?: boolean }
> {
  try {
    const mod: any = await import('@capacitor-community/apple-sign-in').catch(() => null);
    if (!mod || !mod.SignInWithApple) {
      return { ok: false, reason: 'Sign in with Apple is only available on iOS' };
    }
    const options = {
      clientId: 'com.sinistertrivia.macabretest',
      // We only request what we need. Apple requires the scopes match
      // what's configured in the App ID capability.
      scopes: 'email name',
      // redirectURI / state / nonce are only required for the web
      // variant; the native plugin handles them internally.
      redirectURI: '',
      state: '',
      nonce: '',
    };
    const result = await mod.SignInWithApple.authorize(options);
    // result.response shape (per plugin docs):
    //   { user, email?, givenName?, familyName?, identityToken, authorizationCode }
    // Apple only returns email + name on FIRST sign-in for a given Apple ID
    // per app. Subsequent sign-ins from the same Apple ID only give us
    // user + identityToken. The server-side JWT verification can still
    // extract email from the identityToken payload, so we don't need
    // the top-level email field to be populated.
    const r = result && result.response ? result.response : null;
    if (!r || !r.identityToken || !r.user) {
      return { ok: false, reason: 'Apple did not return a valid token' };
    }
    return {
      ok: true,
      identityToken: r.identityToken,
      email: typeof r.email === 'string' ? r.email : null,
      user: r.user,
    };
  } catch (err: any) {
    // The plugin throws on user cancellation. The exact error shape varies
    // by iOS version; check for common cancel signals.
    const msg = err && err.message ? String(err.message) : 'Apple Sign In failed';
    const cancelled = /cancel|user canceled|1001/i.test(msg);
    return { ok: false, reason: msg, cancelled };
  }
}

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

async function apiClaimHandle(
  handle: string,
  deviceId: string,
  opts?: { appleUserId?: string; appleEmail?: string }
): Promise<HandleClaimResult> {
  try {
    const body: any = { handle, deviceId };
    if (opts?.appleUserId) body.appleUserId = opts.appleUserId;
    if (opts?.appleEmail) body.appleEmail = opts.appleEmail;
    const res = await fetch(`${API_BASE}/handles/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch { return { ok: false, reason: 'network error' }; }
}

// ---- Avatar APIs ----
// Upload a custom avatar photo. Server resizes to 256x256 JPEG, strips
// EXIF, stores at avatars/{lowerHandle}.jpg in R2. Returns the new
// avatarUrl with a cache-busting query param so the UI refreshes.
async function apiUploadAvatar(args: { handle: string; deviceId: string; photo: File | Blob }):
  Promise<{ ok: boolean; avatarUrl?: string | null; reason?: string }> {
  try {
    const fd = new FormData();
    fd.append('handle', args.handle);
    fd.append('deviceId', args.deviceId);
    fd.append('photo', args.photo);
    const res = await fetch(`${API_BASE}/handles/avatar/upload`, {
      method: 'POST',
      body: fd,
    });
    return await res.json();
  } catch { return { ok: false, reason: 'network error' }; }
}

// Revert to the default placeholder. Server deletes the prior custom
// upload from R2 (best-effort) and clears the avatar field.
async function apiRemoveAvatar(args: { handle: string; deviceId: string }):
  Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`${API_BASE}/handles/avatar/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    return await res.json();
  } catch { return { ok: false, reason: 'network error' }; }
}

// Fetch one handle's current avatar URL. Used when the post/comment/etc
// payload didn't carry the avatar (older records, comments not yet
// enriched server-side). Returns null if the handle has no custom avatar.
async function apiGetAvatar(handle: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/handles/avatar/${encodeURIComponent(handle)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data && typeof data.avatarUrl === 'string') ? data.avatarUrl : null;
  } catch { return null; }
}

// ---- Profile (displayName / bio / link) ----
type ProfileFields = {
  handle: string;
  displayName: string;
  bio: string;
  link: string;
  avatarUrl: string | null;
};

async function apiGetProfile(handle: string): Promise<ProfileFields | null> {
  try {
    const res = await fetch(`${API_BASE}/handles/profile/${encodeURIComponent(handle)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function apiUpdateProfile(args: {
  handle: string;
  deviceId: string;
  displayName?: string;
  bio?: string;
  link?: string;
}): Promise<{ ok: boolean; reason?: string; profile?: ProfileFields }> {
  try {
    const res = await fetch(`${API_BASE}/handles/profile/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    return await res.json();
  } catch { return { ok: false, reason: 'network error' }; }
}

// ---- Email-path account creation (verified at claim time) ----
// Two-step: start sends a 6-digit code to email, finish verifies and
// atomically creates the handle. The server requires the same deviceId
// for both calls.
async function apiStartEmailClaim(args: { handle: string; email: string; deviceId: string }):
  Promise<{ ok: boolean; reason?: string; existingHandle?: string }> {
  try {
    const res = await fetch(`${API_BASE}/handles/start-email-claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    return await res.json();
  } catch (e: any) { return { ok: false, reason: e?.message || 'network error' }; }
}

async function apiFinishEmailClaim(args: { handle: string; code: string; deviceId: string }):
  Promise<HandleClaimResult> {
  try {
    const res = await fetch(`${API_BASE}/handles/finish-email-claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    return await res.json();
  } catch (e: any) { return { ok: false, reason: e?.message || 'network error' }; }
}

async function apiGetMyHandle(deviceId: string): Promise<{ handle: string | null; hasEmail: boolean; hasApple: boolean }> {
  try {
    const res = await fetch(`${API_BASE}/handles/me?deviceId=${encodeURIComponent(deviceId)}`);
    const data = await res.json();
    return {
      handle: data?.handle || null,
      hasEmail: !!data?.hasEmail,
      hasApple: !!data?.hasApple,
    };
  } catch { return { handle: null, hasEmail: false, hasApple: false }; }
}

// ---------- Account management API ----------
// All the endpoints added in Batch 1: account deletion, email recovery,
// Apple Sign In, content reporting, user blocking.

async function apiSignInApple(args: { identityToken: string; deviceId: string }):
  Promise<{ ok: boolean; handle: string | null; appleUserId?: string; appleEmail?: string | null; reason?: string }> {
  try {
    const res = await fetch(`${API_BASE}/handles/sign-in-apple`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    return await res.json();
  } catch (e: any) { return { ok: false, handle: null, reason: e?.message || 'network error' }; }
}

// Link an Apple ID to an existing handle. Used by the migration modal —
// the regular sign-in-apple flow assumes "log me in by Apple ID", but
// grandfathered users need "attach Apple ID to the handle I'm currently
// in." Verifies ownership AND the Apple JWT.
async function apiLinkApple(args: { handle: string; deviceId: string; identityToken: string }):
  Promise<{ ok: boolean; handle?: string; reason?: string; existingHandle?: string }> {
  try {
    const res = await fetch(`${API_BASE}/handles/link-apple`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    return await res.json();
  } catch (e: any) { return { ok: false, reason: e?.message || 'network error' }; }
}

async function apiAddEmail(args: { handle: string; deviceId: string; email: string }): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`${API_BASE}/handles/add-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    return await res.json();
  } catch (e: any) { return { ok: false, reason: e?.message || 'network error' }; }
}

async function apiVerifyEmail(args: { handle: string; deviceId: string; code: string }): Promise<{ ok: boolean; email?: string; reason?: string }> {
  try {
    const res = await fetch(`${API_BASE}/handles/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    return await res.json();
  } catch (e: any) { return { ok: false, reason: e?.message || 'network error' }; }
}

async function apiRequestRecovery(handle: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`${API_BASE}/handles/request-recovery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle }),
    });
    return await res.json();
  } catch (e: any) { return { ok: false, reason: e?.message || 'network error' }; }
}

async function apiRecover(args: { handle: string; code: string; newDeviceId: string }):
  Promise<{ ok: boolean; handle?: string; reason?: string }> {
  try {
    const res = await fetch(`${API_BASE}/handles/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    return await res.json();
  } catch (e: any) { return { ok: false, reason: e?.message || 'network error' }; }
}

async function apiDeleteAccount(args: { handle: string; deviceId: string }): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`${API_BASE}/handles/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    return await res.json();
  } catch (e: any) { return { ok: false, reason: e?.message || 'network error' }; }
}

// ---- Reports ----
type ReportReason = 'spam' | 'harassment' | 'hate' | 'violence' | 'sexual' | 'illegal' | 'off-topic' | 'other';

async function apiReport(args: { type: 'post' | 'comment'; targetId: string; reason: ReportReason; note?: string; handle: string; deviceId: string }):
  Promise<{ ok: boolean; alreadyReported?: boolean; reason?: string }> {
  try {
    const res = await fetch(`${API_BASE}/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, reason: data?.error || `HTTP ${res.status}` };
    return { ok: true, alreadyReported: !!data?.alreadyReported };
  } catch (e: any) { return { ok: false, reason: e?.message || 'network error' }; }
}

// ---- Blocks ----
async function apiBlock(args: { blocker: string; blocked: string; deviceId: string }): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`${API_BASE}/blocks/block`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, reason: data?.error || `HTTP ${res.status}` };
    return { ok: true };
  } catch (e: any) { return { ok: false, reason: e?.message || 'network error' }; }
}

async function apiUnblock(args: { blocker: string; blocked: string; deviceId: string }): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`${API_BASE}/blocks/unblock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, reason: data?.error || `HTTP ${res.status}` };
    return { ok: true };
  } catch (e: any) { return { ok: false, reason: e?.message || 'network error' }; }
}

async function apiBlockedList(handle: string): Promise<{ handle: string; createdAt: string }[]> {
  try {
    const res = await fetch(`${API_BASE}/blocks/list/${encodeURIComponent(handle)}`);
    const data = await res.json();
    return Array.isArray(data?.blocked) ? data.blocked : [];
  } catch { return []; }
}

// ---- Hidden set (blocked handles) ----
// Module-level cache of the viewer's blocked list, used to filter feeds
// and comments client-side without round-tripping per-render. Reloaded
// when the viewer changes handles or after a block/unblock action.
// Holding lowercase handles for case-insensitive matching.
let _hiddenSetCache: { viewer: string | null; set: Set<string>; loadedAt: number } = {
  viewer: null,
  set: new Set(),
  loadedAt: 0,
};
const HIDDEN_SET_TTL_MS = 60 * 1000; // 1 minute — short enough to feel live after a block

async function getHiddenSet(viewer: string | null): Promise<Set<string>> {
  if (!viewer) return new Set();
  const lower = viewer.toLowerCase();
  const fresh = _hiddenSetCache.viewer === lower &&
                (Date.now() - _hiddenSetCache.loadedAt) < HIDDEN_SET_TTL_MS;
  if (fresh) return _hiddenSetCache.set;
  const list = await apiBlockedList(viewer);
  const set = new Set(list.map((b) => (b.handle || '').toLowerCase()));
  _hiddenSetCache = { viewer: lower, set, loadedAt: Date.now() };
  return set;
}

// Invalidate the cache — call after every successful block/unblock so the
// next feed render reflects the change without waiting for the TTL.
function invalidateHiddenSet() {
  _hiddenSetCache = { viewer: null, set: new Set(), loadedAt: 0 };
}

// ---- Hidden posts (client-side only) ----
// Personal "I don't want to see this again" hides, distinct from
// block-handle (which hides ALL of a user's content). Stored locally
// via readPersistent/writePersistent (Capacitor Preferences on native,
// localStorage on web) and never sent to the server — the user's hides
// are their own business and don't affect other viewers. Reinstall =
// wipe. That's acceptable.
const HIDDEN_POSTS_KEY = 'sinister.hiddenPosts.v1';
let _hiddenPostsCache: Set<string> | null = null;

async function loadHiddenPosts(): Promise<Set<string>> {
  if (_hiddenPostsCache) return _hiddenPostsCache;
  try {
    const value = await readPersistent(HIDDEN_POSTS_KEY);
    const arr = value ? JSON.parse(value) : [];
    _hiddenPostsCache = new Set(Array.isArray(arr) ? arr : []);
  } catch {
    _hiddenPostsCache = new Set();
  }
  return _hiddenPostsCache;
}

async function hidePost(postId: string): Promise<void> {
  const set = await loadHiddenPosts();
  set.add(postId);
  try {
    await writePersistent(HIDDEN_POSTS_KEY, JSON.stringify([...set]));
  } catch {
    // Best effort — set is still updated in memory.
  }
}

// Delete one of your own posts from the server. Server verifies handle
// ownership AND that the post was actually authored by you.
async function apiDeleteMyPost(args: { postId: string; handle: string; deviceId: string }):
  Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`${API_BASE}/posts/delete-mine/${encodeURIComponent(args.postId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: args.handle, deviceId: args.deviceId }),
    });
    if (!res.ok) return { ok: false, reason: `http ${res.status}` };
    return await res.json();
  } catch { return { ok: false, reason: 'network error' }; }
}

// ---- Notifications ----
type NotificationItem = {
  id: string;
  type: 'liked_post' | 'followed' | 'commented';
  actor: string;
  actorAvatarUrl: string | null;
  postId: string | null;
  postThumbUrl: string | null;
  commentSnippet?: string;
  createdAt: string;
  unread: boolean;
};

type NotificationListResp = {
  handle: string;
  count: number;
  unreadCount: number;
  lastReadAt: string | null;
  notifications: NotificationItem[];
};

async function apiFetchNotifications(handle: string): Promise<NotificationListResp | null> {
  try {
    const res = await fetch(`${API_BASE}/notifications/${encodeURIComponent(handle)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function apiFetchUnreadCount(handle: string): Promise<number> {
  try {
    const res = await fetch(`${API_BASE}/notifications/count/${encodeURIComponent(handle)}`);
    if (!res.ok) return 0;
    const data = await res.json();
    return typeof data.unreadCount === 'number' ? data.unreadCount : 0;
  } catch { return 0; }
}

async function apiMarkNotificationsRead(args: { handle: string; deviceId: string }):
  Promise<{ ok: boolean }> {
  try {
    const res = await fetch(`${API_BASE}/notifications/mark-read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) return { ok: false };
    return await res.json();
  } catch { return { ok: false }; }
}

// ---------- Guestbook / visit-claim API ----------
// POST /visits — "signing the guestbook" at a site. Server checks
// (handle, deviceId) ownership, verifies the reported lat/lng is within
// 100m of the site's coords, dedupes (one signature per handle per site),
// and records to visits.json. Optionally accepts a short inscription
// (up to 30 chars). Returns:
//   { ok: true, signingRank, isKeeper, inscription }     on a fresh signing
//   { ok: true, alreadyClaimed: true, ... }              if already signed
//   { ok: false, code, ... }                             on failure
type VisitClaimResult =
  | { ok: true; alreadyClaimed?: boolean; signingRank?: number | null; isKeeper?: boolean; inscription?: string }
  | { ok: false; code: string; distance?: number; message?: string };

async function apiClaimVisit(args: {
  handle: string;
  deviceId: string;
  siteId: string;
  lat: number;
  lng: number;
  inscription?: string;
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
      return {
        ok: true,
        alreadyClaimed: true,
        signingRank: data?.signingRank ?? null,
        isKeeper: !!data?.isKeeper,
        inscription: data?.inscription || '',
      };
    }
    if (!res.ok) {
      return { ok: false, code: data?.code || `http_${res.status}`, distance: data?.distance, message: data?.error };
    }
    return {
      ok: true,
      alreadyClaimed: !!data?.alreadyClaimed,
      signingRank: data?.signingRank ?? null,
      isKeeper: !!data?.isKeeper,
      inscription: data?.inscription || '',
    };
  } catch (err: any) {
    return { ok: false, code: 'network', message: err?.message || 'Network error' };
  }
}

// GET /guestbook/:siteId — read the guestbook for a site. Returns an
// ordered list of signatures (rank 1 = Keeper, pinned at top). Public —
// anyone in the app can read it.
type GuestbookSignature = {
  handle: string;
  inscription: string;
  signedAt: string;
  signingRank: number | null;
};
async function apiGetGuestbook(siteId: string): Promise<GuestbookSignature[]> {
  try {
    const res = await fetch(`${API_BASE}/guestbook/${encodeURIComponent(siteId)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.signatures) ? data.signatures : [];
  } catch { return []; }
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

// ---------- Posts (Social feed) API ----------
// Companion to /posts on the server. A "post" is a GPS-verified photo a
// user submitted while standing at a site, with a caption. Posts are
// admin-approved before they appear in the feed.

type SocialPost = {
  id: string;
  siteId: string;
  siteTitle: string | null;
  siteCategory: string | null;
  handle: string;
  // Server returns the post author's current avatar — either null
  // (default placeholder), 'library:<id>' (bundled SVG), or a full
  // R2 URL (custom upload). Resolved via resolveAvatarUrl() before
  // passing to <img src>.
  avatarUrl?: string | null;
  caption: string;
  photoUrl: string;
  // v1.12 carousel posts: array of 1..N photo URLs. The post card uses
  // this when present; falls back to single photoUrl on older API
  // responses or single-photo posts.
  photoUrls?: string[];
  // v1.13: parallel to photoUrls, identifying which slots are videos.
  // Defaults to all 'photo' for pre-v1.13 posts.
  mediaTypes?: Array<'photo' | 'video'>;
  // v1.14: hashtags extracted from caption at write time, lowercased
  // and deduped. Older posts have no value (treated as empty array).
  hashtags?: string[];
  createdAt: string;
  approvedAt: string;
  likeCount: number;
  // Cached comment count — server denormalizes this onto the post so
  // the feed can render the count without joining comments.json. Server
  // may omit it on older records, so the post card defaults to 0.
  commentCount?: number;
  // Cached repost count — like commentCount, denormalized on the post
  // so the feed render doesn't have to join reposts.json.
  repostCount?: number;
  // When this feed entry is a REPOST rather than an original post, the
  // server stamps these. repostedBy is the handle of the user who
  // reposted; repostedAt is when. Null/undefined on original entries.
  // Used by the card to render the "Reposted by X" header above the
  // post content.
  repostedBy?: string | null;
  repostedAt?: string | null;
  // Up to 2 most-recent top-level approved comments, embedded by the
  // /posts/feed handler so the feed card can render IG-style inline
  // preview rows ("@handle their comment text") without N+1 follow-up
  // requests. Older API responses won't include this field; the card
  // defaults to an empty array in that case.
  // v1.17: YouTube post — when set, this is an 11-char YouTube video
  // ID. The feed renders an inline 16:9 iframe in place of the photo
  // carousel; profile/hashtag grids render the YouTube thumbnail
  // (i.ytimg.com/vi/{id}/hqdefault.jpg) with a play badge.
  youtubeId?: string | null;
  latestComments?: Array<{ id: string; handle: string; body: string; createdAt: string }>;
};

// One comment on a post. Returned by GET /comments/post/:postId.
// parentId carries IG-style reply structure: null for top-level
// comments, set to the root top-level comment id for replies. Replies
// are always one level deep (server flattens reply-to-reply chains).
type SocialComment = {
  id: string;
  postId: string;
  parentId?: string | null;
  handle: string;
  body: string;
  createdAt: string;
  likeCount: number;
};

type FeedPage = { posts: SocialPost[]; nextBefore: string | null };

async function apiFetchFeed(args: { limit?: number; before?: string | null }): Promise<FeedPage> {
  try {
    const params = new URLSearchParams();
    if (args.limit) params.set('limit', String(args.limit));
    if (args.before) params.set('before', args.before);
    const url = `${API_BASE}/posts/feed${params.toString() ? `?${params.toString()}` : ''}`;
    const res = await fetch(url);
    const data = await res.json();
    return {
      posts: Array.isArray(data?.posts) ? data.posts : [],
      nextBefore: data?.nextBefore || null,
    };
  } catch { return { posts: [], nextBefore: null }; }
}

// Following-only feed — posts by handles the given user follows. Mirrors
// the shape of apiFetchFeed so the SocialView can swap between "All" and
// "Following" without touching its render code.
async function apiFetchFollowingFeed(args: { handle: string; limit?: number; before?: string | null }): Promise<FeedPage> {
  try {
    const params = new URLSearchParams();
    if (args.limit) params.set('limit', String(args.limit));
    if (args.before) params.set('before', args.before);
    const qs = params.toString();
    const url = `${API_BASE}/follows/feed/${encodeURIComponent(args.handle)}${qs ? `?${qs}` : ''}`;
    const res = await fetch(url);
    const data = await res.json();
    return {
      posts: Array.isArray(data?.posts) ? data.posts : [],
      nextBefore: data?.nextBefore || null,
    };
  } catch { return { posts: [], nextBefore: null }; }
}

// ---- Follow API ----
// All follow endpoints live in the dedicated server module follows.js.
// Asymmetric public follows (no approval flow). All actions return
// optimistically; client treats network failure as transient and reverts.

type FollowStatus = { followedByYou: boolean; followerCount: number; followingCount: number };

async function apiFollowStatus(args: { target: string; handle: string | null }): Promise<FollowStatus> {
  try {
    const qs = args.handle ? `?handle=${encodeURIComponent(args.handle)}` : '';
    const res = await fetch(`${API_BASE}/follows/status/${encodeURIComponent(args.target)}${qs}`);
    const data = await res.json();
    return {
      followedByYou: !!data?.followedByYou,
      followerCount: typeof data?.followerCount === 'number' ? data.followerCount : 0,
      followingCount: typeof data?.followingCount === 'number' ? data.followingCount : 0,
    };
  } catch {
    return { followedByYou: false, followerCount: 0, followingCount: 0 };
  }
}

async function apiFollow(args: { follower: string; target: string; deviceId: string }): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`${API_BASE}/follows/follow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, reason: data?.error || `HTTP ${res.status}` };
    return { ok: true };
  } catch (e: any) { return { ok: false, reason: e?.message || 'network error' }; }
}

async function apiUnfollow(args: { follower: string; target: string; deviceId: string }): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`${API_BASE}/follows/unfollow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, reason: data?.error || `HTTP ${res.status}` };
    return { ok: true };
  } catch (e: any) { return { ok: false, reason: e?.message || 'network error' }; }
}

type HandleEntry = { handle: string; followedAt: string };

async function apiFollowers(handle: string): Promise<HandleEntry[]> {
  try {
    const res = await fetch(`${API_BASE}/follows/followers/${encodeURIComponent(handle)}`);
    const data = await res.json();
    return Array.isArray(data?.followers) ? data.followers : [];
  } catch { return []; }
}

async function apiFollowing(handle: string): Promise<HandleEntry[]> {
  try {
    const res = await fetch(`${API_BASE}/follows/following/${encodeURIComponent(handle)}`);
    const data = await res.json();
    return Array.isArray(data?.following) ? data.following : [];
  } catch { return []; }
}

// Approved posts by one handle (newest first). Powers the IG-style grid
// on UserProfileView. Server-side filter keeps the client from pulling
// the full feed and discarding 95% of it.
async function apiFetchPostsByHandle(handle: string): Promise<SocialPost[]> {
  try {
    const res = await fetch(`${API_BASE}/posts/handle/${encodeURIComponent(handle)}`);
    const data = await res.json();
    return Array.isArray(data?.posts) ? data.posts : [];
  } catch { return []; }
}

// v1.14: all approved posts tagged with the given hashtag, newest first.
// Server lowercases the tag before matching, and we trust its filtering
// — no client-side post-processing needed.
async function apiFetchPostsByHashtag(tag: string): Promise<SocialPost[]> {
  try {
    const cleaned = tag.replace(/^#/, '').toLowerCase();
    const res = await fetch(`${API_BASE}/posts/hashtag/${encodeURIComponent(cleaned)}`);
    const data = await res.json();
    return Array.isArray(data?.posts) ? data.posts : [];
  } catch { return []; }
}

// Single approved post by id. Used when the user taps a thumbnail in
// the profile grid and we navigate to the post-detail view.
async function apiFetchPost(postId: string): Promise<SocialPost | null> {
  try {
    const res = await fetch(`${API_BASE}/posts/id/${encodeURIComponent(postId)}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.id) return null;
    return data as SocialPost;
  } catch { return null; }
}

// ---- DM API (v1.15) ----
// 1:1 direct messages. Server stores conversations + messages in
// dms.js and exposes /dms/* endpoints.
type DMConversation = {
  id: string;
  otherHandle: string;
  lastMessageAt: string | null;
  lastMessageText: string | null;
  lastMessageBy: string | null;
  createdAt: string;
  unread: number;
};
type DMMessage = {
  id: string;
  from: string;       // sender's handle (lowercased)
  body: string;
  createdAt: string;
};
async function apiSendDM(args: { handle: string; deviceId: string; toHandle: string; body: string }):
  Promise<{ ok: boolean; conversationId?: string; messageId?: string; reason?: string }> {
  try {
    const res = await fetch(`${API_BASE}/dms/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, reason: data?.error || `HTTP ${res.status}` };
    return { ok: true, conversationId: data?.conversationId, messageId: data?.messageId };
  } catch (e: any) {
    return { ok: false, reason: e?.message || 'network error' };
  }
}
async function apiFetchInbox(handle: string): Promise<DMConversation[]> {
  try {
    const res = await fetch(`${API_BASE}/dms/inbox/${encodeURIComponent(handle)}`);
    const data = await res.json();
    return Array.isArray(data?.conversations) ? data.conversations : [];
  } catch { return []; }
}
async function apiFetchThread(convId: string, handle: string): Promise<{ otherHandle: string; messages: DMMessage[] }> {
  try {
    const res = await fetch(`${API_BASE}/dms/thread/${encodeURIComponent(convId)}?handle=${encodeURIComponent(handle)}`);
    const data = await res.json();
    return {
      otherHandle: data?.otherHandle || '',
      messages: Array.isArray(data?.messages) ? data.messages : [],
    };
  } catch { return { otherHandle: '', messages: [] }; }
}
async function apiUnreadDMs(handle: string): Promise<number> {
  try {
    const res = await fetch(`${API_BASE}/dms/unread/${encodeURIComponent(handle)}`);
    const data = await res.json();
    return typeof data?.count === 'number' ? data.count : 0;
  } catch { return 0; }
}
// Deterministic conv-id between two handles (must match server's
// conversationIdFor logic exactly so the client can open a thread
// before the conversation officially "exists").
function dmConversationId(a: string, b: string): string {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  const [lo, hi] = al < bl ? [al, bl] : [bl, al];
  return `conv_${lo}_${hi}`;
}

async function apiToggleLike(args: { postId: string; handle: string; deviceId: string }): Promise<{ ok: boolean; liked?: boolean; count?: number; reason?: string }> {
  try {
    const res = await fetch(`${API_BASE}/posts/like/${encodeURIComponent(args.postId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: args.handle, deviceId: args.deviceId }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, reason: data?.error || `HTTP ${res.status}` };
    return { ok: true, liked: !!data?.liked, count: typeof data?.count === 'number' ? data.count : undefined };
  } catch (e: any) {
    return { ok: false, reason: e?.message || 'network error' };
  }
}

async function apiLikeStatus(args: { postId: string; handle: string | null }): Promise<{ liked: boolean; count: number }> {
  try {
    const url = args.handle
      ? `${API_BASE}/posts/likes/${encodeURIComponent(args.postId)}?handle=${encodeURIComponent(args.handle)}`
      : `${API_BASE}/posts/likes/${encodeURIComponent(args.postId)}`;
    const res = await fetch(url);
    const data = await res.json();
    return { liked: !!data?.liked, count: typeof data?.count === 'number' ? data.count : 0 };
  } catch { return { liked: false, count: 0 }; }
}

// ---- Repost API ----
// Mirrors the like API. POST toggles, GET returns current status. The
// server prevents reposting your own post and verifies handle ownership.

async function apiToggleRepost(args: { postId: string; handle: string; deviceId: string }): Promise<{ ok: boolean; reposted?: boolean; count?: number; reason?: string }> {
  try {
    const res = await fetch(`${API_BASE}/posts/repost/${encodeURIComponent(args.postId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: args.handle, deviceId: args.deviceId }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, reason: data?.error || `HTTP ${res.status}` };
    return { ok: true, reposted: !!data?.reposted, count: typeof data?.count === 'number' ? data.count : undefined };
  } catch (e: any) {
    return { ok: false, reason: e?.message || 'network error' };
  }
}

async function apiRepostStatus(args: { postId: string; handle: string | null }): Promise<{ reposted: boolean; count: number }> {
  try {
    const url = args.handle
      ? `${API_BASE}/posts/repost-status/${encodeURIComponent(args.postId)}?handle=${encodeURIComponent(args.handle)}`
      : `${API_BASE}/posts/repost-status/${encodeURIComponent(args.postId)}`;
    const res = await fetch(url);
    const data = await res.json();
    return { reposted: !!data?.reposted, count: typeof data?.count === 'number' ? data.count : 0 };
  } catch { return { reposted: false, count: 0 }; }
}

// ---- Comment API ----
// All comment endpoints live in the dedicated server module comments.js.
// Auto-approved at creation; flat structure (no nested replies in v1).

// Fetch all approved comments for a post, oldest first.
async function apiFetchComments(postId: string): Promise<SocialComment[]> {
  try {
    const res = await fetch(`${API_BASE}/comments/post/${encodeURIComponent(postId)}`);
    const data = await res.json();
    return Array.isArray(data?.comments) ? data.comments : [];
  } catch { return []; }
}

// Create a new comment on a post. Server auto-approves and updates the
// parent post's cached commentCount.
async function apiCreateComment(args: { postId: string; handle: string; deviceId: string; body: string; parentId?: string | null }): Promise<{ ok: boolean; comment?: SocialComment; reason?: string }> {
  try {
    const res = await fetch(`${API_BASE}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, reason: data?.error || `HTTP ${res.status}` };
    return { ok: true, comment: data?.comment };
  } catch (e: any) {
    return { ok: false, reason: e?.message || 'network error' };
  }
}

// Toggle a heart on a single comment. Mirrors apiToggleLike for posts.
async function apiToggleCommentLike(args: { commentId: string; handle: string; deviceId: string }): Promise<{ ok: boolean; liked?: boolean; count?: number; reason?: string }> {
  try {
    const res = await fetch(`${API_BASE}/comments/like/${encodeURIComponent(args.commentId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: args.handle, deviceId: args.deviceId }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, reason: data?.error || `HTTP ${res.status}` };
    return { ok: true, liked: !!data?.liked, count: typeof data?.count === 'number' ? data.count : 0 };
  } catch (e: any) { return { ok: false, reason: e?.message || 'network error' }; }
}

// Check whether the current user has liked a comment + the total count.
async function apiCommentLikeStatus(args: { commentId: string; handle: string | null }): Promise<{ liked: boolean; count: number }> {
  try {
    const url = args.handle
      ? `${API_BASE}/comments/likes/${encodeURIComponent(args.commentId)}?handle=${encodeURIComponent(args.handle)}`
      : `${API_BASE}/comments/likes/${encodeURIComponent(args.commentId)}`;
    const res = await fetch(url);
    const data = await res.json();
    return { liked: !!data?.liked, count: typeof data?.count === 'number' ? data.count : 0 };
  } catch { return { liked: false, count: 0 }; }
}

// Author-delete their own comment.
async function apiDeleteComment(args: { commentId: string; handle: string; deviceId: string }): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`${API_BASE}/comments/delete/${encodeURIComponent(args.commentId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: args.handle, deviceId: args.deviceId }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, reason: data?.error || `HTTP ${res.status}` };
    return { ok: true };
  } catch (e: any) { return { ok: false, reason: e?.message || 'network error' }; }
}

// Create a post via multipart/form-data. Photo must be a Blob/File from
// the camera capture. Server verifies GPS within 100m, queues for admin
// approval, and records the visit (idempotent — same site = no dup visit).
// Create a post. Two modes:
//   - Site-tagged (default): pass siteId + captureLat + captureLng.
//     Server verifies GPS within 100m, post enters pending review.
//   - Freeform: pass freeform=true and omit siteId / GPS. Server
//     auto-approves and the post hits the feed immediately.
// v1.12: photo is the primary (edited) image. extras is an optional
// array of unedited additional photos that ride along as carousel slots
// 2..N. The server stores them in photoR2Keys[] with the primary at
// index 0.
async function apiCreatePost(args: {
  photo: Blob;
  extras?: Blob[];
  handle: string;
  deviceId: string;
  caption: string;
  siteId?: string;
  captureLat?: number;
  captureLng?: number;
  freeform?: boolean;
}): Promise<{ ok: boolean; postId?: string; reason?: string }> {
  try {
    const fd = new FormData();
    // Send the primary on BOTH fields — `photo` for backwards-compat
    // with any legacy server, AND as the first entry in `photos` for
    // v1.12+ servers that expect the multi-field. Servers running both
    // schemas dedupe in the normalizeFiles middleware.
    fd.append('photos', args.photo, 'post-0.jpg');
    if (args.extras && args.extras.length > 0) {
      args.extras.forEach((blob, i) => {
        fd.append('photos', blob, `post-${i + 1}.jpg`);
      });
    }
    fd.append('handle', args.handle);
    fd.append('deviceId', args.deviceId);
    fd.append('caption', args.caption);
    if (args.freeform) {
      fd.append('freeform', 'true');
    } else {
      if (args.siteId) fd.append('siteId', args.siteId);
      if (args.captureLat !== undefined) fd.append('captureLat', String(args.captureLat));
      if (args.captureLng !== undefined) fd.append('captureLng', String(args.captureLng));
    }
    const res = await fetch(`${API_BASE}/posts`, { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) return { ok: false, reason: data?.error || `HTTP ${res.status}` };
    return { ok: true, postId: data?.postId };
  } catch (e: any) {
    return { ok: false, reason: e?.message || 'network error' };
  }
}

// Create a YouTube-video post (v1.17). JSON-only — no file upload, no
// R2 storage. The server auto-approves (YouTube already moderates the
// underlying video), so no admin queue. The feed renders an inline
// 16:9 iframe in place of the photo carousel.
async function apiCreateYouTubePost(args: {
  handle: string;
  deviceId: string;
  caption: string;
  youtubeId: string;
}): Promise<{ ok: boolean; postId?: string; reason?: string }> {
  try {
    const res = await fetch(`${API_BASE}/posts/youtube`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handle: args.handle,
        deviceId: args.deviceId,
        caption: args.caption,
        youtubeId: args.youtubeId,
      }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, reason: data?.error || `HTTP ${res.status}` };
    return { ok: true, postId: data?.postId };
  } catch (e: any) {
    return { ok: false, reason: e?.message || 'network error' };
  }
}

// ---------- Polls API ----------
// Text-only polls that live in the DreadFeed alongside photo posts. One
// question + 4 answer options. Users with a handle can vote once and may
// change their vote until the poll expires (7 days after creation).
// Results are hidden until the user has voted (IG/Twitter style). After
// expiry, polls lock read-only with final tallies. Server module: polls.js.

type PollEntry = {
  id: string;
  type: 'poll';                 // discriminator so the feed render can branch
  handle: string;
  question: string;
  options: string[];            // always length 4
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  // null = viewer hasn't voted (or no handle passed). Otherwise the
  // option index they picked.
  userVote: number | null;
  // Only populated when results are visible (viewer has voted OR poll
  // expired). Otherwise null.
  tallies: number[] | null;
  totalVotes: number | null;
};

type PollFeedPage = { polls: PollEntry[]; nextBefore: string | null };

async function apiFetchPollsFeed(args: { limit?: number; before?: string | null; handle?: string | null }): Promise<PollFeedPage> {
  try {
    const params = new URLSearchParams();
    if (args.limit) params.set('limit', String(args.limit));
    if (args.before) params.set('before', args.before);
    if (args.handle) params.set('handle', args.handle);
    const qs = params.toString();
    const url = `${API_BASE}/polls/feed${qs ? `?${qs}` : ''}`;
    const res = await fetch(url);
    const data = await res.json();
    return {
      polls: Array.isArray(data?.polls) ? data.polls : [],
      nextBefore: data?.nextBefore || null,
    };
  } catch { return { polls: [], nextBefore: null }; }
}

async function apiCreatePoll(args: {
  handle: string;
  deviceId: string;
  question: string;
  options: string[];
}): Promise<{ ok: boolean; poll?: PollEntry; reason?: string }> {
  try {
    const res = await fetch(`${API_BASE}/polls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handle: args.handle,
        deviceId: args.deviceId,
        question: args.question,
        options: args.options,
      }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, reason: data?.error || `HTTP ${res.status}` };
    return { ok: true, poll: data?.poll };
  } catch (e: any) {
    return { ok: false, reason: e?.message || 'network error' };
  }
}

async function apiVoteOnPoll(args: {
  pollId: string;
  handle: string;
  deviceId: string;
  optionIndex: number;
}): Promise<{ ok: boolean; tallies?: number[]; totalVotes?: number; userVote?: number; reason?: string }> {
  try {
    const res = await fetch(`${API_BASE}/polls/vote/${encodeURIComponent(args.pollId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handle: args.handle,
        deviceId: args.deviceId,
        optionIndex: args.optionIndex,
      }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, reason: data?.error || `HTTP ${res.status}` };
    return { ok: true, tallies: data?.tallies, totalVotes: data?.totalVotes, userVote: data?.userVote };
  } catch (e: any) {
    return { ok: false, reason: e?.message || 'network error' };
  }
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
      imageCredit: s.submitter ? `@${s.submitter}` : 'The Dread Directory',
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

// ---------- DreadFeed (IG-style) sounds ----------
// Distinct from the horror app's playSubDrop/playPop — these are bright,
// short, IG-style UI blips. The DreadFeed mini-app reaches for "social
// network" feel rather than "sinister" feel, so these sounds skip the
// low-freq weight and stay in the 600-1500Hz pleasant range with quick
// envelopes. All three share the same getAudioCtx() singleton so they
// inherit the iOS resume/unlock pattern.

// haptic — fires a short native haptic tap when available. Order:
//   1) Capacitor Haptics plugin (native iOS — real haptic engine)
//   2) navigator.vibrate (older Android browsers)
//   3) silent no-op (modern iOS Safari, desktop)
// Wrapped in try/catch and runtime-resolved so we don't take a build
// dependency on @capacitor/haptics — if the plugin isn't installed yet,
// we silently fall through. Three intensities matching iOS's
// UIImpactFeedbackGenerator styles.
function haptic(style: 'light' | 'medium' | 'heavy' = 'light') {
  try {
    const cap = (window as any).Capacitor;
    const Haptics = cap?.Plugins?.Haptics;
    if (Haptics && typeof Haptics.impact === 'function') {
      // Native: matches iOS's UIImpactFeedbackGenerator styles exactly.
      Haptics.impact({ style: style.toUpperCase() });
      return;
    }
  } catch { /* fall through */ }
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      const ms = style === 'heavy' ? 18 : style === 'medium' ? 12 : 8;
      navigator.vibrate(ms);
    }
  } catch { /* silent */ }
}

// playLikeBlip — short "tap" for double-tap-style like reactions. A
// quick sine pulse at 900Hz, ~70ms total. Bright enough to be felt as
// positive feedback without being distracting.
function playLikeBlip() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(900, now);
    osc.frequency.exponentialRampToValueAtTime(1200, now + 0.05);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.14, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.1);
  } catch { /* silent */ }
}

// playCommentSent — "thwip" send sound for posting a comment. Two
// stacked oscillators (700Hz + 1100Hz) sweeping up briefly then fading,
// gives a satisfying "off it goes" feel like IG's send sound.
function playCommentSent() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const dur = 0.12;
    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    const gain = ctx.createGain();
    o1.type = 'sine';
    o2.type = 'sine';
    o1.frequency.setValueAtTime(700, now);
    o1.frequency.exponentialRampToValueAtTime(1400, now + dur);
    o2.frequency.setValueAtTime(1100, now);
    o2.frequency.exponentialRampToValueAtTime(2200, now + dur);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.12, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    o1.connect(gain);
    o2.connect(gain);
    gain.connect(ctx.destination);
    o1.start(now);
    o2.start(now);
    o1.stop(now + dur + 0.02);
    o2.stop(now + dur + 0.02);
  } catch { /* silent */ }
}

// playPostShared — longer celebratory "shink!" for successfully creating
// a DreadFeed post. Three-tone arpeggio (600 → 900 → 1200Hz) over
// ~220ms. Bigger than playLikeBlip / playCommentSent because creating a
// post is the more significant action.
function playPostShared() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const notes = [600, 900, 1200];
    notes.forEach((freq, i) => {
      const t = now + i * 0.05;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.12, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.14);
    });
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
  // True if the user has already tapped to play this sound but the buffer
  // wasn't decoded yet. When decode completes, we fire one play immediately
  // so the first tap on cold launch isn't silently swallowed.
  pendingPlay: boolean;
}

const _fileSounds: Record<'slide' | 'button' | 'back' | 'bell', FileSoundSlot> = {
  slide:  { url: slideSound1, volume: SLIDE_VOLUME,  buffer: null, gain: null, rawBytes: null, fetchStarted: false, initStarted: false, pendingPlay: false },
  button: { url: buttonSound, volume: BUTTON_VOLUME, buffer: null, gain: null, rawBytes: null, fetchStarted: false, initStarted: false, pendingPlay: false },
  back:   { url: backSound,   volume: BACK_VOLUME,   buffer: null, gain: null, rawBytes: null, fetchStarted: false, initStarted: false, pendingPlay: false },
  bell:   { url: bellSound,   volume: BELL_VOLUME,   buffer: null, gain: null, rawBytes: null, fetchStarted: false, initStarted: false, pendingPlay: false },
};

// Internal: actually fire a buffer source for a slot. Caller is responsible
// for ensuring slot.buffer + slot.gain are non-null before calling.
function _fireFileSound(key: 'slide' | 'button' | 'back' | 'bell') {
  const slot = _fileSounds[key];
  const ctx = _audioCtx;
  if (!ctx || !slot.buffer || !slot.gain) return;
  try {
    const src = ctx.createBufferSource();
    src.buffer = slot.buffer;
    src.connect(slot.gain);
    src.start(0);
  } catch { /* silent */ }
}

// Phase 1: fetch the raw audio bytes. Doesn't need AudioContext, can run
// at any time including app boot before any user gesture. Idempotent.
// If a play was queued while we were fetching, kick off the decode chain
// (which will fire the queued play when it completes).
function prefetchFileSound(key: 'slide' | 'button' | 'back' | 'bell') {
  const slot = _fileSounds[key];
  if (slot.fetchStarted) return;
  slot.fetchStarted = true;
  fetch(slot.url)
    .then(r => r.arrayBuffer())
    .then(ab => {
      slot.rawBytes = ab;
      // If the user already tapped while we were fetching, advance to
      // decode now. ensureFileSound is a no-op if AudioContext isn't
      // unlocked yet, in which case the next tap (which will unlock it)
      // will pick this up.
      if (slot.pendingPlay) ensureFileSound(key);
    })
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
// If a play is queued (pendingPlay), fire it the moment decode resolves —
// this is what fixes cold-launch first-tap-silent: the user's first tap
// unlocks the context and triggers ensureFileSound, and even though the
// buffer isn't ready synchronously, we still play it ~few-hundred-ms
// later instead of swallowing it.
function ensureFileSound(key: 'slide' | 'button' | 'back' | 'bell') {
  const slot = _fileSounds[key];
  if (slot.initStarted) return;
  // Make sure phase 1 has at least started — if for some reason the
  // module-load prefetch didn't run yet, kick it off.
  prefetchFileSound(key);
  const ctx = getAudioCtx();
  if (!ctx) return;
  // Need the raw bytes to decode. If they haven't arrived yet, leave
  // initStarted=false; the prefetch resolver will call us back when bytes
  // arrive (provided pendingPlay is set).
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
        // Fire the queued play, if any. Once consumed, clear the flag
        // so we don't re-fire on every subsequent tap.
        if (slot.pendingPlay) {
          slot.pendingPlay = false;
          _fireFileSound(key);
        }
      })
      .catch(() => { slot.initStarted = false; /* allow retry */ });
  } catch { /* silent */ }
}

function playFileSound(key: 'slide' | 'button' | 'back' | 'bell') {
  const slot = _fileSounds[key];
  // Lazy-init the decode + gain chain on first call.
  ensureFileSound(key);
  const ctx = _audioCtx;
  // Buffer not ready yet (cold launch, decode in flight, or fetch in
  // flight). Mark a pending play so whichever async step finishes last
  // (prefetch → ensureFileSound → decodeAudioData.then) fires the
  // sound. The AudioContext was already resume()d inside this same user
  // gesture by getAudioCtx() in ensureFileSound above, so deferred
  // plays from .then() callbacks are still allowed by iOS.
  if (!ctx || !slot.buffer || !slot.gain) {
    slot.pendingPlay = true;
    return;
  }
  // Buffer ready: fire synchronously in the same tap event.
  if (ctx.state === 'running') {
    _fireFileSound(key);
  } else {
    ctx.resume().then(() => _fireFileSound(key)).catch(() => { /* silent */ });
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

// When non-zero, the global swipe-back touch handler bails on touchstart.
// Used by full-screen modal flows like the post editor where horizontal
// swipes are part of the in-screen UI (font picker, filter strip, sticker
// drawer scroll) and must not pop the nav stack. Reference-counted so
// nested suppressors don't accidentally re-enable each other.
let _swipeBackSuppressCount = 0;
function beginSuppressSwipeBack() { _swipeBackSuppressCount++; }
function endSuppressSwipeBack() {
  _swipeBackSuppressCount = Math.max(0, _swipeBackSuppressCount - 1);
}

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
import cellUfo        from './assets/cell-ufo.jpg';
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

type CategoryKey = 'crime' | 'film' | 'haunting' | 'ufo' | 'killer' | 'historical';
// `hidden: true` removes a category from the home grid, List View top
// level, DreadFeed filter chips, and the submission form dropdown.
// Data stays intact in sites.json and all the per-site machinery
// (CATEGORY_COLOR, DetailView, etc.) keeps working — so existing sites
// in hidden categories still render correctly if reached via direct
// link or admin tools. Easy to flip back on later — just drop `hidden`.
// For launch we show only: True Crime, Film Locations, Hauntings.
// Serial Killers are folded into True Crime (see CATEGORY_HOME_MERGE
// below). UFO Sightings and Grave Sites are hidden until relaunch.
const CATEGORIES: { key: CategoryKey; label: string; gridIndex: number; cascadeOrder: number; borderColor: string; image: string; hidden?: boolean }[] = [
  { key: 'crime',      label: 'True Crime',     gridIndex: 0, cascadeOrder: 0, borderColor: TILE_RED, image: cellCrime      },
  { key: 'film',       label: 'Film Locations', gridIndex: 1, cascadeOrder: 5, borderColor: TILE_RED, image: cellFilm       },
  { key: 'haunting',   label: 'Hauntings',      gridIndex: 2, cascadeOrder: 1, borderColor: WHITE,    image: cellHaunting   },
  // UFO Sightings replaced Cults in v1.11. Server-side migration runs on
  // boot to move legacy category='cult' sites to category='crime'. The
  // tile image is a vintage 1960s UFO Polaroid that lives at
  // src/assets/cell-ufo.jpg.
  { key: 'ufo',        label: 'UFO Sightings',  gridIndex: 3, cascadeOrder: 4, borderColor: WHITE,    image: cellUfo,         hidden: true },
  { key: 'killer',     label: 'Serial Killers', gridIndex: 4, cascadeOrder: 2, borderColor: TILE_RED, image: cellKiller,      hidden: true },
  { key: 'historical', label: 'Grave Sites',    gridIndex: 5, cascadeOrder: 3, borderColor: TILE_RED, image: cellHistorical,  hidden: true },
];

// Visible category list for the home grid, List View top level,
// DreadFeed filter chips, and submission form dropdown. Filters out
// anything flagged hidden.
const VISIBLE_CATEGORIES = CATEGORIES.filter((c) => !c.hidden);

// Home-page merge map: when the user opens True Crime from the home grid
// (or its List View row), we want serial-killer sites to surface there
// too — they ARE true crime, just a subset. This map says "if the user
// asks for 'crime', show sites whose category is in ['crime', 'killer']."
// Anything not in the map falls back to a single-category filter.
const CATEGORY_HOME_MERGE: Partial<Record<CategoryKey, CategoryKey[]>> = {
  crime: ['crime', 'killer'],
};
function categoriesForKey(key: CategoryKey): CategoryKey[] {
  return CATEGORY_HOME_MERGE[key] || [key];
}

const CATEGORY_COLOR: Record<CategoryKey, string> = {
  crime:      '#FF3B3B',
  film:       '#FF9D2E',
  haunting:   '#3FA9FF',
  ufo:        '#34D058',
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
  let css = `@import url('https://fonts.bunny.net/css?family=jolly-lodger:400|creepster:400|special-elite:400|permanent-marker:400|oswald:400,700|share-tech-mono:400');\n`;

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
   Slow 4.5s cycle so it reads as ambient rather than attention-grabbing.
   Colors are hardcoded here (rather than interpolating JS color
   constants) because this CSS string runs BEFORE the const declarations
   for BLACK/etc. are initialized — referencing them via interpolation
   would throw a ReferenceError. */
@keyframes sinister-spotlight-pulse {
  0%, 100% {
    box-shadow: 0 0 14px rgba(193, 43, 43, 0.2), 0 0 4px rgba(10, 10, 10, 0.6);
    transform: scale(1);
  }
  50% {
    box-shadow: 0 0 26px rgba(193, 43, 43, 0.4), 0 0 8px rgba(10, 10, 10, 0.6);
    transform: scale(1.015);
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

/* iOS-style press feedback for icon buttons (home bottom bar icons,
   eXposure bottom bar icons). Scale-down + dim on :active. Snappy
   transition: fast on press, slightly slower on release. */
.sinister-icon-btn {
  transition: transform 80ms ease-out, opacity 80ms ease-out;
}
.sinister-icon-btn:active {
  transform: scale(0.88);
  opacity: 0.7;
  transition: transform 50ms ease-in, opacity 50ms ease-in;
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
     scrollbar-width: none on the scrolling element.

   v1.12 globalized this from per-view (detail/about/leaders) to
   everywhere. The white scrollbar was still showing up on DreadFeed,
   the home screen, and any other view that wasn't in the enumerated
   list. There's no view where we WANT to show a scrollbar — they all
   look cheap on iOS — so the global rule is correct. */
html::-webkit-scrollbar,
body::-webkit-scrollbar,
html::-webkit-scrollbar-thumb,
body::-webkit-scrollbar-thumb,
html::-webkit-scrollbar-track,
body::-webkit-scrollbar-track,
*::-webkit-scrollbar,
*::-webkit-scrollbar-thumb,
*::-webkit-scrollbar-track {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
  -webkit-appearance: none !important;
  background: transparent !important;
}
html,
body,
* {
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
  | { name: 'nearby'; category?: CategoryKey }
  | { name: 'list' }
  | { name: 'social' }
  | { name: 'userProfile'; handle: string }
  | { name: 'hashtag'; tag: string }
  | { name: 'dmInbox' }
  | { name: 'dmThread'; conversationId: string; otherHandle: string }
  | { name: 'post'; postId: string; postList?: string[]; preloadedPosts?: SocialPost[] }
  | { name: 'notifications' }
  | { name: 'settings' };

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
  // Cache of NearbyView state per category (and `__all` for the no-filter
  // map). Persists pinCenter + radius across navigations away from the
  // map and back — e.g. tap a pin → Detail → swipe back should return
  // the user to the spot where they were searching, not snap them back
  // to their real location. Keyed by category so each category remembers
  // its own search center independently.
  type NearbyState = { pinCenter: { lat: number; lng: number } | null; radiusMi: number };
  const _nearbyStateCache = useRef<Map<string, NearbyState>>(new Map());
  const setView = (next: View, opts?: { replace?: boolean }) => {
    const sy = (typeof window !== 'undefined')
      ? (window.scrollY || document.documentElement.scrollTop || 0)
      : 0;
    _setViewRaw((prev) => {
      if (JSON.stringify(prev) !== JSON.stringify(next)) {
        // Home-bar destinations are peer pages reachable directly from
        // home. If the user is hopping between peers (List View →
        // eXposure → Dread Leaders → About), swipe-back should bring
        // them straight back to home, not retrace every peer. To do
        // that, when both the previous view AND the new view are home
        // peers, we collapse them: pop any peer that's at the top of
        // the stack BEFORE pushing the new one. The first peer push
        // (from home) still records home below it, so swipe-back from
        // any peer always lands on home.
        const homePeers = new Set(['list', 'social', 'leaders', 'about']);
        // DreadFeed-context views — every screen that lives "inside"
        // the DreadFeed mini-app. When the user returns to the social
        // root (the feed), we strip these off the top of the history
        // stack so swipe-back from the feed goes straight to whatever
        // was OUTSIDE DreadFeed (usually home), never back into the
        // DreadFeed sub-views the user already navigated past.
        const dreadFeedSubViews = new Set([
          'social', 'userProfile', 'post', 'badges', 'settings', 'notifications',
        ]);
        const prevIsPeer = homePeers.has(prev.name);
        const nextIsPeer = homePeers.has(next.name);
        if (opts?.replace) {
          // Replace mode — caller is swapping the current view for
          // another (e.g. swipe up/down between posts in the IG-style
          // post viewer). Don't push prev onto history; swipe-back
          // should skip the intermediate steps and return to whatever
          // came BEFORE the replace chain started.
        } else if (prevIsPeer && nextIsPeer) {
          // Don't push prev. The peer at the top of the stack already
          // points back to home (or further); leave it.
        } else {
          _navHistory.current.push({ view: prev, scrollY: sy });
          if (_navHistory.current.length > 50) _navHistory.current.shift();
        }
        // Whenever the destination is the DreadFeed root (social), the
        // stack should hold only entries from BEFORE the user entered
        // DreadFeed. Pop any DreadFeed-sub-view entries off the top.
        // This handles the case where the user navigates social →
        // userProfile → post, then taps the DreadFeed home tab from
        // inside a sub-view — we'd otherwise push userProfile onto the
        // stack and a subsequent swipe-back from social would land on
        // userProfile instead of home.
        if (next.name === 'social') {
          const stack = _navHistory.current;
          while (stack.length > 0 && dreadFeedSubViews.has(stack[stack.length - 1].view.name)) {
            stack.pop();
          }
        }
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
  // EULA acceptance — App Store guideline 1.2 + 5.1.1(v) require an EULA
  // for apps with user-generated content. On first launch (or after a
  // version bump) we show the modal until the user accepts. localStorage
  // persists acceptance across launches; bumping EULA_VERSION re-prompts.
  const [showEula, setShowEula] = useState(() => {
    try {
      return localStorage.getItem(EULA_LS_KEY) !== '1';
    } catch {
      // Storage unavailable (private mode etc) — show it; better to
      // re-prompt than to skip the legal gate.
      return true;
    }
  });

  // Email-migration prompt for grandfathered handles. Set true at app
  // boot when /handles/me reports the user owns a handle but is missing
  // either an email OR an Apple ID link. The modal blocks dismissal —
  // they have to add the missing recovery method to continue.
  const [showMigrateEmail, setShowMigrateEmail] = useState(false);
  // Snapshot of which recovery methods are already on the account at
  // boot — used by the modal to hide buttons for methods that exist.
  const [migrateHasEmail, setMigrateHasEmail] = useState(false);
  const [migrateHasApple, setMigrateHasApple] = useState(false);
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
        const me = await apiGetMyHandle(id);
        if (cancelled) return;
        if (me.handle) {
          setHandle(me.handle);
          // Migration prompt fires when a recovery method is missing.
          // On iOS we want both email and Apple ID for redundant recovery
          // (Apple is preferred for one-tap on next device, email is the
          // universal fallback). On Android, Apple Sign-In is unavailable,
          // so we only require email.
          const needsRecovery = isIOS()
            ? (!me.hasEmail || !me.hasApple)
            : !me.hasEmail;
          if (needsRecovery) {
            setMigrateHasEmail(me.hasEmail);
            setMigrateHasApple(me.hasApple);
            setShowMigrateEmail(true);
          }
          // Load visit history so DetailView can show the visited state
          // immediately without a flash of the unclaimed button.
          const siteIds = await apiGetMyVisits(me.handle);
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
      if (_swipeBackSuppressCount > 0) return;
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
    // Category cells on the home screen now open the map filtered to that
    // category, instead of the scrollable list of every site in the category.
    // The scrollable list was getting sluggish past ~130 sites in a single
    // category, and the map is a better fit for "go visit these places"
    // intent anyway. The old `category` view still exists for back-stack
    // routing from Detail / List View; it's just no longer the destination
    // from the home cells.
    playButton();
    setView({ name: 'nearby', category: key });
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
  function goSocial() {
    setView({ name: 'social' });
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
      const allowed = new Set<CategoryKey>(categoriesForKey(v.category));
      const filtered = v.state
        ? sites.filter(s => allowed.has(s.category as CategoryKey) && s.state === v.state)
        : sites.filter(s => allowed.has(s.category as CategoryKey));
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
      return { key: 'submit', element: <SubmitView currentLocation={currentLocation} deviceId={deviceId} handle={handle} onHandleClaimed={setHandle} onBack={goHome} onGoToSocial={goSocial} /> };
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
    } else if (v.name === 'social') {
      return {
        key: 'social',
        element: (
          <SocialView
            handle={handle}
            deviceId={deviceId}
            sites={sites}
            currentLocation={currentLocation}
            onSelectSite={goDetail}
            onBack={goHome}
            onSelectHandle={(h) => setView({ name: 'userProfile', handle: h })}
            onSelectHashtag={(tag) => setView({ name: 'hashtag', tag })}
            onSelectPost={(postId, postList, preloadedPosts) => setView({ name: 'post', postId, postList, preloadedPosts })}
            onHandleClaimed={setHandle}
            onSelectSettings={() => setView({ name: 'settings' })}
            onSelectNotifications={() => setView({ name: 'notifications' })}
            onSelectInbox={() => setView({ name: 'dmInbox' })}
          />
        ),
      };
    } else if (v.name === 'userProfile') {
      return {
        key: `userProfile:${v.handle}`,
        element: (
          <UserProfileView
            profileHandle={v.handle}
            currentHandle={handle}
            deviceId={deviceId}
            sites={sites}
            onSelectSite={goDetail}
            onSelectBadges={(h) => setView({ name: 'badges', handle: h })}
            onSelectPost={(postId, postList, preloadedPosts) => setView({ name: 'post', postId, postList, preloadedPosts })}
            onSelectHandle={(h) => setView({ name: 'userProfile', handle: h })}
            onSelectDMThread={(conversationId, otherHandle) => setView({ name: 'dmThread', conversationId, otherHandle })}
            onSelectExposureTab={(tab) => {
              _exposureSubTabMemory = tab;
              setView({ name: 'social' });
            }}
            onBack={goHome}
          />
        ),
      };
    } else if (v.name === 'hashtag') {
      return {
        key: `hashtag:${v.tag}`,
        element: (
          <HashtagView
            tag={v.tag}
            onSelectPost={(postId, postList, preloadedPosts) => setView({ name: 'post', postId, postList, preloadedPosts })}
            onBack={goBack}
          />
        ),
      };
    } else if (v.name === 'dmInbox') {
      // Inbox requires a claimed handle — anything else returns home.
      if (!handle || !deviceId) {
        // Defer the redirect to a useEffect since we're inside render.
        // For now, render an empty placeholder; AppShell will re-render
        // when handle becomes available.
        return { key: 'dmInbox', element: <div /> };
      }
      return {
        key: 'dmInbox',
        element: (
          <DMInboxView
            currentHandle={handle}
            deviceId={deviceId}
            onSelectThread={(conversationId, otherHandle) =>
              setView({ name: 'dmThread', conversationId, otherHandle })
            }
            onBack={goBack}
          />
        ),
      };
    } else if (v.name === 'dmThread') {
      if (!handle || !deviceId) {
        return { key: `dmThread:${v.conversationId}`, element: <div /> };
      }
      return {
        key: `dmThread:${v.conversationId}`,
        element: (
          <DMThreadView
            conversationId={v.conversationId}
            otherHandle={v.otherHandle}
            currentHandle={handle}
            deviceId={deviceId}
            onBack={goBack}
          />
        ),
      };
    } else if (v.name === 'post') {
      return {
        key: `post:${v.postId}`,
        element: (
          <PostDetailView
            postId={v.postId}
            postList={v.postList}
            preloadedPosts={v.preloadedPosts}
            currentHandle={handle}
            deviceId={deviceId}
            sites={sites}
            onSelectSite={goDetail}
            onSelectHandle={(h) => setView({ name: 'userProfile', handle: h })}
            onSelectHashtag={(tag) => setView({ name: 'hashtag', tag })}
            onSelectExposureTab={(tab) => {
              // Tapping a bottom-bar tab from inside post detail jumps
              // back to eXposure on that sub-tab. Updating the module-
              // level memory before navigating means SocialView's mount
              // picks up the right starting tab — no flicker through
              // 'feed' first.
              _exposureSubTabMemory = tab;
              setView({ name: 'social' });
            }}
            onBack={goHome}
          />
        ),
      };
    } else if (v.name === 'settings') {
      return {
        key: 'settings',
        element: (
          <SettingsView
            handle={handle}
            deviceId={deviceId}
            onBack={() => {
              // Settings is only entered from your own profile, so back
              // returns there via SocialView with profile sub-tab restored.
              _exposureSubTabMemory = 'profile';
              setView({ name: 'social' });
            }}
            onSignedOut={() => {
              // After account deletion the local handle state must clear
              // so we don't re-render screens with a stale handle.
              setHandle(null);
              setView({ name: 'home' });
            }}
          />
        ),
      };
    } else if (v.name === 'notifications') {
      // The bell is only tappable when a handle exists, so handle/deviceId
      // should be present — but defensively fall back to home if not.
      if (!handle || !deviceId) {
        return { key: 'notifications-noauth', element: null };
      }
      return {
        key: 'notifications',
        element: (
          <NotificationsView
            handle={handle}
            deviceId={deviceId}
            onSelectHandle={(h) => setView({ name: 'userProfile', handle: h })}
            onSelectPost={(postId) => setView({ name: 'post', postId })}
            onBack={() => {
              // Back returns to DreadFeed feed tab.
              _exposureSubTabMemory = 'feed';
              setView({ name: 'social' });
            }}
          />
        ),
      };
    } else if (v.name === 'nearby') {
      const catEntry = v.category ? CATEGORIES.find(c => c.key === v.category) : null;
      const catLabel = catEntry?.label || (v.category ? titleCase(v.category) : null);
      const cacheKey = v.category || '__all';
      const cached = _nearbyStateCache.current.get(cacheKey);
      const persistState = (s: NearbyState) => {
        _nearbyStateCache.current.set(cacheKey, s);
      };
      return {
        key: v.category ? `nearby-${v.category}` : 'nearby',
        element: (
          <NearbyView
            sites={sites}
            currentLocation={currentLocation}
            onSelectSite={goDetail}
            onBack={goHome}
            categoryFilter={v.category}
            categoryLabel={catLabel || undefined}
            initialPinCenter={cached?.pinCenter ?? null}
            initialRadiusMi={cached?.radiusMi ?? DEFAULT_RADIUS_MILES}
            onStateChange={persistState}
          />
        ),
      };
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
      {/* HomeBottomBar appears ONLY on the main home page. Previously it
          also rendered on home-peer views (list, about, leaders) but that
          made those pages feel cluttered — the home bar's 4 large icons
          competed visually with the list/leaders content. Each non-home
          view has its own back/nav affordances and doesn't need the home
          bar layered on top. Per-screen IG-style bars (e.g. on DreadFeed)
          are rendered by those views themselves. */}
      {view.name === 'home' && (
        <HomeBottomBar
          onSubmit={goSubmit}
          onList={goList}
          onAbout={goAbout}
          onSocial={goSocial}
        />
      )}
      <ToastHost />
      {/* First-launch EULA gate — top of the stacking order so it sits
          above everything else (even other modals). Persisted to
          localStorage on accept. */}
      {showEula && (
        <EulaModal
          onAccept={() => {
            try {
              localStorage.setItem(EULA_LS_KEY, '1');
            } catch { /* ignore — fine to re-prompt next launch */ }
            setShowEula(false);
          }}
        />
      )}
      {/* Grandfathered-handle email migration. Only renders when EULA
          is already accepted (so we never stack two full-screen gates).
          Required to dismiss — no Skip button. */}
      {!showEula && showMigrateEmail && handle && deviceId && (
        <MigrateEmailModal
          handle={handle}
          deviceId={deviceId}
          hasEmail={migrateHasEmail}
          hasApple={migrateHasApple}
          onDone={() => setShowMigrateEmail(false)}
        />
      )}
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
function HomeBottomBar({ onSubmit, onList, onAbout, onSocial }: {
  onSubmit: () => void;
  onList: () => void;
  onAbout: () => void;
  onSocial: () => void;
}) {
  // Four icon buttons on the home page bottom bar. Each is one of Drew's
  // custom rounded-square app-style icons sitting above a small text
  // label. The icons carry the visual weight; the labels exist so users
  // can identify them at a glance.
  //
  //   List View       — full categorized list of every site
  //   eXposure        — the social photo feed (entry point to the mini-app)
  //   Submit          — submit a new haunted location
  //   About           — info + credits
  return (
    <div style={S.homeBar}>
      <button
        className="sinister-icon-btn" style={S.homeBarBtn}
        onClick={() => { playSubDrop(); onList(); }}
      >
        <img src={listIconUrl} alt="" style={{ ...S.homeBarIcon, ...S.homeBarIconSmall }} />
        <span style={S.homeBarLabel}>List View</span>
      </button>
      <button
        className="sinister-icon-btn" style={S.homeBarBtn}
        onClick={() => { playBackSound(); onSocial(); }}
      >
        <img src={exposureIconUrl} alt="" style={S.homeBarIcon} />
        <span style={S.homeBarLabel}>DreadFeed</span>
      </button>
      <button
        className="sinister-icon-btn" style={S.homeBarBtn}
        onClick={() => { playSubDrop(); onSubmit(); }}
        aria-label="Submit a Location"
      >
        <img src={locationIconUrl} alt="" style={{ ...S.homeBarIcon, ...S.homeBarIconSmall }} />
        <span style={S.homeBarLabel}>Submit</span>
      </button>
      <button
        className="sinister-icon-btn" style={S.homeBarBtn}
        onClick={() => { playSubDrop(); onAbout(); }}
      >
        <img src={aboutIconUrl} alt="" style={{ ...S.homeBarIcon, ...S.homeBarIconLarge }} />
        <span style={S.homeBarLabel}>About</span>
      </button>
    </div>
  );
}

// ---------- Social (vertical photo feed) ----------
// Vertical scroll feed of GPS-verified visitor photo posts. Instagram-
// style card layout: photo on top, caption + handle + site link below,
// like heart at the bottom-left.
//
// Posts come from GET /posts/feed (chronological, newest first, paginated
// via nextBefore cursor). Each card carries a cached likeCount; the
// authoritative like state for the current user is fetched on demand via
// /posts/likes/:postId when the card mounts.
//
// Like UI uses optimistic update — tap heart, increment count locally and
// toggle filled state, then call /posts/like/:postId in the background.
// On server error we revert.
// Module-level memory for the eXposure sub-tab the user was last on.
// Lets SocialView resume in the right place when the user navigates out
// (e.g. taps a post thumbnail to open PostDetailView) and swipes back —
// without this, SocialView would unmount, lose its state, and remount on
// the default 'feed' tab regardless of where the user actually left off.
// File-level rather than a useRef inside App so it survives even if App
// itself remounts.
type _ExposureSubTab = 'feed' | 'search' | 'post' | 'profile';
let _exposureSubTabMemory: _ExposureSubTab = 'feed';

// Snapshot of SocialView's feed state, preserved across unmounts so
// navigating from DreadFeed → UserProfileView → swipe-back lands the
// user on the same post at the same scroll position they were viewing.
// Without this, each remount kicks off a fresh fetch of page 1 from
// the server and the user is dumped at the top of the feed — frustrating
// when they were 30 posts deep.
//
// We snapshot ONLY the 'all' feed (not 'following'), because the
// following filter is cheap enough to recompute and tends to have many
// fewer posts. Scroll position is window.scrollY since the SocialView
// uses the document scroll, not an inner overflow container.
type _SocialFeedSnapshot = {
  posts: SocialPost[];
  nextBefore: string | null;
  scrollY: number;
  // Wall-clock timestamp when this snapshot was captured. If the user
  // comes back hours later we discard the snapshot and refetch — a
  // stale feed is worse than a momentary scroll-to-top.
  capturedAt: number;
};
let _socialFeedMemory: _SocialFeedSnapshot | null = null;
const SOCIAL_FEED_MEMORY_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ---------- Settings View ----------
// Reached from a gear icon on your own DreadFeed profile. Centralizes
// the account management surface that App Store guideline 5.1.1(v)
// requires to be reachable and discoverable:
//   - Add / verify a recovery email
//   - View blocked users
//   - View terms / privacy
//   - Delete account (with confirmation)
//
// Visually matches the DreadFeed aesthetic — black background, white
// text, system-ui sans-serif, IG-style rows with a chevron.
function SettingsView({ handle, deviceId, onBack, onSignedOut }: {
  handle: string | null;
  deviceId: string | null;
  onBack: () => void;
  onSignedOut: () => void;
}) {
  // Modal states. Only one open at a time.
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [verifyModalOpen, setVerifyModalOpen] = useState(false);
  const [pendingEmail, setPendingEmail] = useState('');
  const [blockedModalOpen, setBlockedModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);

  if (!handle || !deviceId) {
    return (
      <div style={S.settingsWrap}>
        <SettingsHeader title="Settings" onBack={onBack} />
        <div style={S.settingsEmpty}>You need a handle to manage settings.</div>
      </div>
    );
  }

  return (
    <div style={S.settingsWrap}>
      <SettingsHeader title="Settings" onBack={onBack} />

      <div style={S.settingsSectionLabel}>Account</div>
      <SettingsRow
        label="Add recovery email"
        sublabel="Required to recover your account if you lose your phone"
        onClick={() => setEmailModalOpen(true)}
      />
      <SettingsRow
        label="Blocked users"
        sublabel="Manage who you've blocked"
        onClick={() => setBlockedModalOpen(true)}
      />

      <div style={S.settingsSectionLabel}>Legal</div>
      <SettingsRow
        label="Terms of Service"
        onClick={() => {
          // Open external link to terms page. Will be a hosted page on
          // sinistertrivia.com once Drew writes them — placeholder for now.
          try { (window as any).open?.('https://sinistertrivia.com/terms', '_blank'); }
          catch { showToast('Opening terms…', 'default'); }
        }}
      />
      <SettingsRow
        label="Privacy Policy"
        onClick={() => {
          try { (window as any).open?.('https://sinistertrivia.com/privacy', '_blank'); }
          catch { showToast('Opening privacy policy…', 'default'); }
        }}
      />

      <div style={S.settingsSectionLabel}>Danger zone</div>
      <SettingsRow
        label="Delete account"
        sublabel="Permanently delete your handle, posts, comments, follows"
        destructive
        onClick={() => setDeleteModalOpen(true)}
      />

      <div style={S.settingsFooter}>
        @{handle} · The Dread Directory
      </div>

      {emailModalOpen && (
        <AddEmailModal
          handle={handle}
          deviceId={deviceId}
          onClose={() => setEmailModalOpen(false)}
          onCodeSent={(email) => {
            setPendingEmail(email);
            setEmailModalOpen(false);
            setVerifyModalOpen(true);
          }}
        />
      )}
      {verifyModalOpen && (
        <VerifyEmailModal
          handle={handle}
          deviceId={deviceId}
          email={pendingEmail}
          onClose={() => setVerifyModalOpen(false)}
          onVerified={() => {
            setVerifyModalOpen(false);
            showToast('Email verified — you can now recover your account', 'success');
          }}
        />
      )}
      {blockedModalOpen && (
        <BlockedListModal
          handle={handle}
          deviceId={deviceId}
          onClose={() => setBlockedModalOpen(false)}
        />
      )}
      {deleteModalOpen && (
        <DeleteAccountModal
          handle={handle}
          deviceId={deviceId}
          onClose={() => setDeleteModalOpen(false)}
          onDeleted={() => {
            setDeleteModalOpen(false);
            showToast('Account deleted', 'success');
            onSignedOut();
          }}
        />
      )}
    </div>
  );
}

function SettingsHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div style={S.settingsHeaderBar}>
      <button onClick={onBack} style={S.settingsBackBtn} aria-label="Back">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>
      <div style={S.settingsHeaderTitle}>{title}</div>
      <div style={{ width: 36 }} />
    </div>
  );
}

function SettingsRow({ label, sublabel, onClick, destructive }: {
  label: string;
  sublabel?: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button onClick={onClick} style={S.settingsRow}>
      <div style={S.settingsRowTextCol}>
        <div style={{ ...S.settingsRowLabel, color: destructive ? '#ff6b6b' : '#FFFFFF' }}>{label}</div>
        {sublabel && <div style={S.settingsRowSublabel}>{sublabel}</div>}
      </div>
      <div style={S.settingsRowChevron}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#666" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </div>
    </button>
  );
}

// ---------- Add Email Modal ----------
// Modal that takes an email address and triggers a server send of the
// 6-digit verification code. On success it closes and opens the verify
// modal. Centered modal sheet, IG-style.
function AddEmailModal({ handle, deviceId, onClose, onCodeSent }: {
  handle: string;
  deviceId: string;
  onClose: () => void;
  onCodeSent: (email: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = email.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setErr(null);
    const result = await apiAddEmail({ handle, deviceId, email: trimmed });
    setBusy(false);
    if (result.ok) {
      onCodeSent(trimmed);
    } else {
      setErr(result.reason || 'Could not send verification code');
    }
  };

  return (
    <CenteredModal title="Add recovery email" onClose={onClose}>
      <div style={S.modalBody}>
        <div style={S.modalText}>
          Enter your email. We'll send a 6-digit code to confirm.
        </div>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          style={S.modalInput}
          disabled={busy}
        />
        {err && <div style={S.modalError}>{err}</div>}
        <button
          onClick={submit}
          disabled={busy || !email.trim()}
          style={busy || !email.trim() ? S.modalBtnDisabled : S.modalBtnPrimary}
        >
          {busy ? 'Sending…' : 'Send code'}
        </button>
      </div>
    </CenteredModal>
  );
}

// ---------- Verify Email Modal ----------
function VerifyEmailModal({ handle, deviceId, email, onClose, onVerified }: {
  handle: string;
  deviceId: string;
  email: string;
  onClose: () => void;
  onVerified: () => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!/^\d{6}$/.test(code.trim()) || busy) return;
    setBusy(true);
    setErr(null);
    const result = await apiVerifyEmail({ handle, deviceId, code: code.trim() });
    setBusy(false);
    if (result.ok) {
      onVerified();
    } else {
      setErr(result.reason || 'Invalid code');
    }
  };

  return (
    <CenteredModal title="Verify your email" onClose={onClose}>
      <div style={S.modalBody}>
        <div style={S.modalText}>
          Enter the 6-digit code we sent to <strong>{email}</strong>. Code expires in 15 minutes.
        </div>
        <input
          type="text"
          inputMode="numeric"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="000000"
          maxLength={6}
          style={{ ...S.modalInput, textAlign: 'center', letterSpacing: '0.4em', fontSize: 20 }}
          disabled={busy}
        />
        {err && <div style={S.modalError}>{err}</div>}
        <button
          onClick={submit}
          disabled={busy || code.length !== 6}
          style={busy || code.length !== 6 ? S.modalBtnDisabled : S.modalBtnPrimary}
        >
          {busy ? 'Verifying…' : 'Verify'}
        </button>
      </div>
    </CenteredModal>
  );
}

// ---------- Blocked List Modal ----------
function BlockedListModal({ handle, deviceId, onClose }: {
  handle: string;
  deviceId: string;
  onClose: () => void;
}) {
  const [list, setList] = useState<{ handle: string; createdAt: string }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const data = await apiBlockedList(handle);
      if (cancelled) return;
      setList(data);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [handle]);

  const unblock = async (target: string) => {
    const result = await apiUnblock({ blocker: handle, blocked: target, deviceId });
    if (result.ok) {
      setList((prev) => prev.filter((b) => b.handle.toLowerCase() !== target.toLowerCase()));
      invalidateHiddenSet();
      showToast(`Unblocked ${target}`, 'success');
    } else {
      showToast(result.reason || 'Unblock failed', 'error');
    }
  };

  return (
    <CenteredModal title="Blocked users" onClose={onClose}>
      <div style={S.modalBody}>
        {loading ? (
          <div style={S.modalText}>Loading…</div>
        ) : list.length === 0 ? (
          <div style={S.modalText}>You haven't blocked anyone.</div>
        ) : (
          list.map((b) => (
            <div key={b.handle} style={S.blockedRow}>
              <div style={S.blockedHandle}>{b.handle}</div>
              <button onClick={() => unblock(b.handle)} style={S.blockedUnblockBtn}>
                Unblock
              </button>
            </div>
          ))
        )}
      </div>
    </CenteredModal>
  );
}

// ---------- Post / Comment action sheet (3-dot menu) ----------
// Bottom-sheet that slides up from the bottom on iOS / Android pattern.
// Used for both posts (Report, Block author, Cancel) and comments (Report,
// Block author, Cancel). Own posts/comments show no menu — Delete on own
// content lives on the row itself.
//
// Rendered via portal so it floats above feed cards regardless of the
// parent's transform context (the same trick CommentSheet uses).
function ActionSheet({ title, actions, onClose }: {
  title?: string;
  actions: { label: string; onClick: () => void; destructive?: boolean }[];
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const animateClose = () => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(onClose, 180);
  };

  const visible = mounted && !closing;
  return createPortal(
    <div
      style={{ ...S.actionSheetBackdrop, opacity: visible ? 1 : 0 }}
      onClick={animateClose}
    >
      <div
        style={{ ...S.actionSheet, transform: visible ? 'translateY(0)' : 'translateY(100%)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {title && <div style={S.actionSheetTitle}>{title}</div>}
        {actions.map((a, i) => (
          <button
            key={i}
            onClick={() => { animateClose(); window.setTimeout(a.onClick, 200); }}
            style={a.destructive ? S.actionSheetBtnDestructive : S.actionSheetBtn}
          >
            {a.label}
          </button>
        ))}
        <button onClick={animateClose} style={S.actionSheetCancelBtn}>
          Cancel
        </button>
      </div>
    </div>,
    document.body
  );
}

// ---------- EULA / Terms acceptance modal ----------
// Shown on first launch. App Store guideline 1.2 + 5.1.1(v) require an
// EULA for apps with user-generated content, particularly when those
// apps include blocking/reporting features. We persist acceptance in
// localStorage so the user only sees this once. Bumping the EULA_VERSION
// constant below re-prompts existing users (e.g. after a material terms
// change).
const EULA_VERSION = '1';
const EULA_LS_KEY = 'sinister.eulaAccepted.v' + EULA_VERSION;

function EulaModal({ onAccept }: { onAccept: () => void }) {
  // No close button — user must accept to continue.
  return (
    <div style={S.eulaBackdrop}>
      <div style={S.eulaSheet}>
        <div style={S.eulaTitle}>Welcome to The Dread Directory</div>
        <div style={S.eulaBody}>
          <p style={S.eulaPara}>
            Before you start, please review and accept our terms.
          </p>
          <p style={S.eulaPara}>
            <strong>Community guidelines.</strong> The Dread Directory is for
            sharing real haunted, abandoned, and sinister locations.
            Don't post objectionable content — no harassment, hate speech,
            sexual content, violence, or illegal activity. Posts and
            comments are reviewed and may be removed.
          </p>
          <p style={S.eulaPara}>
            <strong>Zero tolerance.</strong> Accounts that post abusive
            material will be banned with no warning. You can report or
            block any user from the 3-dot menu on their posts or profile.
          </p>
          <p style={S.eulaPara}>
            <strong>Your content.</strong> You retain ownership of photos
            you post but grant us a license to display them in the app.
            You can delete your account and all your data at any time
            from Settings.
          </p>
          <p style={S.eulaPara}>
            By tapping Accept you agree to our{' '}
            <a
              href="https://sinistertrivia.com/terms"
              target="_blank"
              rel="noopener noreferrer"
              style={S.eulaLink}
            >Terms of Service</a>{' '}and{' '}
            <a
              href="https://sinistertrivia.com/privacy"
              target="_blank"
              rel="noopener noreferrer"
              style={S.eulaLink}
            >Privacy Policy</a>.
          </p>
        </div>
        <button onClick={onAccept} style={S.eulaAcceptBtn}>
          Accept &amp; Continue
        </button>
      </div>
    </div>
  );
}

// ---------- Email migration modal for grandfathered handles ----------
// Shown on launch to handles that were claimed before email-at-signup
// was required. Two paths:
//   1. Sign in with Apple — links the Apple ID + email to the existing
//      handle in one tap. (Server's handleSignInApple "existing user
//      signing in" branch already handles the email-attach.)
//   2. Add email manually — uses the existing /handles/add-email +
//      /handles/verify-email flow (Drew's been able to do this in
//      Settings; this just surfaces it on launch with no Skip).
//
// No close button — must complete one path. Once an email is on file,
// the modal never shows again for this handle.
function MigrateEmailModal({ handle, deviceId, hasEmail, hasApple, onDone }: {
  handle: string;
  deviceId: string;
  hasEmail: boolean;
  hasApple: boolean;
  onDone: () => void;
}) {
  type Step = 'choose' | 'email-pick' | 'email-code';
  const [step, setStep] = useState<Step>('choose');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onApple = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    const native = await nativeSignInWithApple();
    if (!native.ok) {
      setBusy(false);
      const fail = native as { ok: false; reason: string; cancelled?: boolean };
      if (!fail.cancelled) setErr(fail.reason);
      return;
    }
    // Use link-apple, NOT sign-in-apple. We want to ATTACH this Apple ID
    // to the handle the user is already signed in as — not log in by
    // Apple ID (which would fail for a new Apple ID with no handle).
    const r = await apiLinkApple({
      handle,
      deviceId,
      identityToken: native.identityToken,
    });
    setBusy(false);
    if (r.ok) {
      onDone();
    } else {
      // Most likely failure: Apple ID already linked to a different handle.
      // Surface the conflict; the user can use the email path instead.
      if (r.existingHandle) {
        setErr(`This Apple ID is already linked to @${r.existingHandle}. Use email recovery instead.`);
      } else {
        setErr(r.reason || 'Could not link Apple ID.');
      }
    }
  };

  const onSend = async () => {
    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) || busy) {
      setErr('Please enter a valid email.');
      return;
    }
    setBusy(true);
    setErr(null);
    const r = await apiAddEmail({ handle, deviceId, email: trimmed });
    setBusy(false);
    if (r.ok) {
      setStep('email-code');
    } else {
      setErr(r.reason || 'Could not send code.');
    }
  };

  const onVerify = async () => {
    const cleanCode = code.trim();
    if (!/^\d{6}$/.test(cleanCode) || busy) return;
    setBusy(true);
    setErr(null);
    const r = await apiVerifyEmail({ handle, deviceId, code: cleanCode });
    setBusy(false);
    if (r.ok) {
      onDone();
    } else {
      setErr(r.reason || 'Invalid code.');
    }
  };

  return (
    <div style={S.eulaBackdrop}>
      <div style={S.eulaSheet}>
        {step === 'choose' && (
          <>
            <div style={S.eulaTitle}>One more thing</div>
            <div style={S.eulaBody}>
              <p style={S.eulaPara}>
                Welcome back, <strong>@{handle}</strong>. {!isIOS()
                  ? "Add a recovery email so you don't lose access if you lose your phone."
                  : hasEmail && !hasApple
                  ? "Link your Apple ID so you can sign in on a new device with one tap."
                  : !hasEmail && hasApple
                  ? "Add a recovery email as a backup in case you lose access to your Apple ID."
                  : "We need a recovery method on your account so you don't lose access if you lose your phone."}
              </p>
            </div>
            {!hasApple && isIOS() && (
              <button
                onClick={onApple}
                disabled={busy}
                style={S.dreadFeedAppleBtn}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="#FFFFFF" style={{ marginRight: 8 }}>
                  <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
                </svg>
                {busy ? 'Connecting…' : (hasEmail ? 'Link Apple ID' : 'Sign in with Apple')}
              </button>
            )}
            {!hasApple && !hasEmail && isIOS() && (
              <div style={S.dreadFeedClaimOrRow}>
                <div style={S.dreadFeedClaimOrLine} />
                <span style={S.dreadFeedClaimOrText}>or</span>
                <div style={S.dreadFeedClaimOrLine} />
              </div>
            )}
            {!hasEmail && (
              <button
                onClick={() => { setStep('email-pick'); setErr(null); }}
                style={S.dreadFeedEmailBtn}
              >
                Add recovery email
              </button>
            )}
            {err && <div style={S.modalError}>{err}</div>}
          </>
        )}

        {step === 'email-pick' && (
          <>
            <div style={S.eulaTitle}>Add recovery email</div>
            <div style={S.eulaBody}>
              <p style={S.eulaPara}>
                We'll send a 6-digit code to verify your email.
              </p>
            </div>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              inputMode="email"
              style={S.modalInput}
              disabled={busy}
              autoFocus
            />
            <button
              onClick={onSend}
              disabled={busy || !email.trim()}
              style={!busy && email.trim() ? S.modalBtnPrimary : S.modalBtnDisabled}
            >
              {busy ? 'Sending…' : 'Send code'}
            </button>
            <button
              onClick={() => { setStep('choose'); setErr(null); }}
              disabled={busy}
              style={S.modalBtnSecondary}
            >
              Back
            </button>
            {err && <div style={S.modalError}>{err}</div>}
          </>
        )}

        {step === 'email-code' && (
          <>
            <div style={S.eulaTitle}>Check your email</div>
            <div style={S.eulaBody}>
              <p style={S.eulaPara}>
                We sent a 6-digit code to <strong>{email.trim()}</strong>.
              </p>
            </div>
            <input
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              maxLength={6}
              style={{ ...S.modalInput, letterSpacing: 6, textAlign: 'center', fontSize: 22, fontFamily: 'monospace' }}
              disabled={busy}
              autoFocus
            />
            <button
              onClick={onVerify}
              disabled={busy || code.length !== 6}
              style={!busy && code.length === 6 ? S.modalBtnPrimary : S.modalBtnDisabled}
            >
              {busy ? 'Verifying…' : 'Verify'}
            </button>
            <button
              onClick={() => { setStep('email-pick'); setCode(''); setErr(null); }}
              disabled={busy}
              style={S.modalBtnSecondary}
            >
              Back
            </button>
            {err && <div style={S.modalError}>{err}</div>}
          </>
        )}
      </div>
    </div>
  );
}

// ---------- Recover Account Modal ----------
// Two-step flow inside a CenteredModal:
//   Step 1 — user types their handle, we POST /handles/request-recovery.
//            Server sends a 6-digit code to the email on file (if any).
//            For privacy, server always returns ok=true regardless, so
//            we just advance to step 2.
//   Step 2 — user types the 6-digit code, we POST /handles/recover
//            with { handle, code, newDeviceId }. On success, the
//            handle's deviceId is swapped to this device and we notify
//            the parent which sets the handle and dismisses the modal.
function RecoverAccountModal({ newDeviceId, onClose, onRecovered }: {
  newDeviceId: string;
  onClose: () => void;
  onRecovered: (handle: string) => void;
}) {
  const [step, setStep] = useState<'handle' | 'code'>('handle');
  const [handle, setHandle] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const requestCode = async () => {
    const trimmed = handle.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setErr(null);
    const result = await apiRequestRecovery(trimmed);
    setBusy(false);
    if (result.ok) {
      // Always advance — server doesn't reveal whether an email exists.
      setStep('code');
    } else {
      setErr(result.reason || 'Could not request a recovery code.');
    }
  };

  const submitCode = async () => {
    const cleanCode = code.trim();
    if (!/^\d{6}$/.test(cleanCode) || busy) return;
    setBusy(true);
    setErr(null);
    const result = await apiRecover({
      handle: handle.trim(),
      code: cleanCode,
      newDeviceId,
    });
    setBusy(false);
    if (result.ok && result.handle) {
      onRecovered(result.handle);
    } else {
      setErr(result.reason || 'Invalid code or expired.');
    }
  };

  return (
    <CenteredModal
      title={step === 'handle' ? 'Recover account' : 'Enter recovery code'}
      onClose={onClose}
    >
      <div style={S.modalBody}>
        {step === 'handle' ? (
          <>
            <div style={S.modalText}>
              Enter your handle. If you have a recovery email on file, we'll send a 6-digit code.
            </div>
            <input
              type="text"
              value={handle}
              onChange={(e) => setHandle(e.target.value.replace(/[^A-Za-z0-9_]/g, ''))}
              placeholder="your handle"
              maxLength={20}
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              style={{ ...S.modalInput, marginTop: 10 }}
              disabled={busy}
            />
            {err && <div style={S.modalError}>{err}</div>}
            <button
              onClick={requestCode}
              disabled={!handle.trim() || busy}
              style={!handle.trim() || busy ? S.modalBtnDisabled : S.modalBtnPrimary}
            >
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </>
        ) : (
          <>
            <div style={S.modalText}>
              We sent a 6-digit code to the email on file for <strong>{handle.trim()}</strong>. Enter it below.
            </div>
            <input
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              maxLength={6}
              style={{ ...S.modalInput, marginTop: 10, letterSpacing: 6, textAlign: 'center', fontSize: 20, fontFamily: 'monospace' }}
              disabled={busy}
            />
            {err && <div style={S.modalError}>{err}</div>}
            <button
              onClick={submitCode}
              disabled={code.length !== 6 || busy}
              style={code.length !== 6 || busy ? S.modalBtnDisabled : S.modalBtnPrimary}
            >
              {busy ? 'Verifying…' : 'Recover account'}
            </button>
            <button
              onClick={() => { setStep('handle'); setCode(''); setErr(null); }}
              style={S.modalBtnSecondary}
              disabled={busy}
            >
              Back
            </button>
          </>
        )}
      </div>
    </CenteredModal>
  );
}


function DeleteAccountModal({ handle, deviceId, onClose, onDeleted }: {
  handle: string;
  deviceId: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  // User must type DELETE before the button activates. Standard
  // confirmation pattern for destructive actions.
  const canSubmit = confirmText.trim().toUpperCase() === 'DELETE' && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    const result = await apiDeleteAccount({ handle, deviceId });
    setBusy(false);
    if (result.ok) {
      onDeleted();
    } else {
      setErr(result.reason || 'Delete failed');
    }
  };

  return (
    <CenteredModal title="Delete account" onClose={onClose}>
      <div style={S.modalBody}>
        <div style={S.modalText}>
          This permanently deletes your handle <strong>@{handle}</strong>, all your posts,
          comments, follows, and visits. <strong>This cannot be undone.</strong>
        </div>
        <div style={{ ...S.modalText, marginTop: 8 }}>
          Type <strong>DELETE</strong> below to confirm.
        </div>
        <input
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder="DELETE"
          style={S.modalInput}
          disabled={busy}
        />
        {err && <div style={S.modalError}>{err}</div>}
        <button
          onClick={submit}
          disabled={!canSubmit}
          style={canSubmit ? S.modalBtnDanger : S.modalBtnDisabled}
        >
          {busy ? 'Deleting…' : 'Permanently delete account'}
        </button>
      </div>
    </CenteredModal>
  );
}

// ---------- Centered Modal (shared chrome) ----------
function CenteredModal({ title, onClose, children }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return createPortal(
    <div style={S.modalOverlay}>
      <div style={S.modalBackdrop} onClick={onClose} />
      <div style={S.modalPanel}>
        <div style={S.modalHeader}>
          <div style={{ width: 32 }} />
          <div style={S.modalTitle}>{title}</div>
          <button onClick={onClose} style={S.modalCloseBtn} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}

// ---------- Report Modal ----------
// Opened from a "Report" option on post / comment menus. Lets the user
// pick a reason and add an optional note. App Store 1.2 compliance.
function ReportModal({ targetType, targetId, handle, deviceId, onClose, onReported }: {
  targetType: 'post' | 'comment';
  targetId: string;
  handle: string;
  deviceId: string;
  onClose: () => void;
  onReported: () => void;
}) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reasons: { value: ReportReason; label: string }[] = [
    { value: 'spam', label: 'Spam' },
    { value: 'harassment', label: 'Harassment or bullying' },
    { value: 'hate', label: 'Hate speech' },
    { value: 'violence', label: 'Violence or threats' },
    { value: 'sexual', label: 'Sexual content' },
    { value: 'illegal', label: 'Illegal activity' },
    { value: 'off-topic', label: 'Off-topic' },
    { value: 'other', label: 'Other' },
  ];

  const submit = async () => {
    if (!reason || busy) return;
    setBusy(true);
    setErr(null);
    const result = await apiReport({
      type: targetType,
      targetId,
      reason,
      note: note.trim() || undefined,
      handle,
      deviceId,
    });
    setBusy(false);
    if (result.ok) {
      onReported();
    } else {
      setErr(result.reason || 'Report failed');
    }
  };

  return (
    <CenteredModal title={`Report ${targetType}`} onClose={onClose}>
      <div style={S.modalBody}>
        <div style={S.modalText}>Why are you reporting this {targetType}?</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {reasons.map((r) => (
            <button
              key={r.value}
              onClick={() => setReason(r.value)}
              style={reason === r.value ? S.reasonBtnActive : S.reasonBtn}
            >
              {r.label}
            </button>
          ))}
        </div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, 500))}
          placeholder="Add a note (optional)"
          rows={3}
          style={{ ...S.modalInput, resize: 'none' as const, marginTop: 10 }}
          disabled={busy}
        />
        {err && <div style={S.modalError}>{err}</div>}
        <button
          onClick={submit}
          disabled={!reason || busy}
          style={!reason || busy ? S.modalBtnDisabled : S.modalBtnPrimary}
        >
          {busy ? 'Submitting…' : 'Submit report'}
        </button>
      </div>
    </CenteredModal>
  );
}


// ---------- DreadFeed Claim Screen ----------
// IG-style "Create your account" screen that lives in the Profile sub-tab
// when the user has no handle claimed. Previously this slot just told the
// user to "Open Submit a Location to claim one" — terrible UX for a
// DreadFeed-only user who never plans to submit a haunted site.
//
// Reuses the same apiCheckHandle / apiClaimHandle backend as the inline
// claim in SubmitView. On success, calls onClaimed which lifts to the
// App-level handle state — like buttons, comments, follows immediately
// start working without a refresh.
function DreadFeedClaimScreen({ deviceId, onClaimed }: {
  deviceId: string | null;
  onClaimed: (handle: string) => void;
}) {
  // Steps:
  //   'entry'      — Apple button (primary) + "Use email instead" (secondary) + Recover link
  //   'apple-pick' — Apple succeeded but the Apple ID isn't bound to a handle yet;
  //                  ask the user to pick a username, then claim with appleUserId+appleEmail
  //   'email-pick' — User chose email path. Ask for handle + email; on submit, server emails a code
  //   'email-code' — Code entry; on submit, server verifies and claims
  type Step = 'entry' | 'apple-pick' | 'email-pick' | 'email-code';
  const [step, setStep] = useState<Step>('entry');

  // Apple-state — populated when entry → apple-pick is triggered.
  const [appleUserId, setAppleUserId] = useState<string | null>(null);
  const [appleEmail, setAppleEmail] = useState<string | null>(null);
  const [appleBusy, setAppleBusy] = useState(false);

  // Shared username input + availability state, used by both apple-pick
  // and email-pick.
  const [typed, setTyped] = useState('');
  const [status, setStatus] = useState<'idle' | 'checking' | 'available' | 'taken' | 'invalid'>('idle');
  const [statusMsg, setStatusMsg] = useState('');
  const [claiming, setClaiming] = useState(false);
  const [claimErr, setClaimErr] = useState<string | null>(null);
  const debounceRef = useRef<number | null>(null);

  // Email-path state.
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);

  // Recover-account modal — reachable from the entry step.
  const [recoverOpen, setRecoverOpen] = useState(false);

  // Live availability check, debounced 350ms. Active on the screens where
  // the user types a username (apple-pick + email-pick).
  useEffect(() => {
    if (step !== 'apple-pick' && step !== 'email-pick') return;
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
    setStatusMsg('checking…');
    debounceRef.current = window.setTimeout(async () => {
      const r = await apiCheckHandle(trimmed);
      if (r.available) {
        setStatus('available');
        setStatusMsg('available');
      } else if (r.reason && r.reason.toLowerCase().includes('taken')) {
        setStatus('taken');
        setStatusMsg('taken');
      } else {
        setStatus('invalid');
        setStatusMsg(r.reason || 'invalid');
      }
    }, 350);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [typed, step]);

  const statusColor =
    status === 'available' ? '#5dd069' :
    status === 'taken' ? '#ff6b6b' :
    status === 'invalid' ? '#ffb648' :
    '#888888';

  // ---- Apple path ----
  const onAppleTap = async () => {
    if (!deviceId || appleBusy) return;
    setAppleBusy(true);
    setClaimErr(null);
    const native = await nativeSignInWithApple();
    if (!native.ok) {
      setAppleBusy(false);
      const fail = native as { ok: false; reason: string; cancelled?: boolean };
      if (!fail.cancelled) {
        setClaimErr(fail.reason);
      }
      return;
    }
    // Hand the token to the server.
    const r = await apiSignInApple({
      identityToken: native.identityToken,
      deviceId,
    });
    setAppleBusy(false);
    if (!r.ok) {
      setClaimErr(r.reason || 'Apple sign-in failed.');
      return;
    }
    if (r.handle) {
      // Existing Apple user — straight in.
      playPostShared();
      onClaimed(r.handle);
      return;
    }
    // New Apple user — need to pick a handle.
    setAppleUserId(r.appleUserId || null);
    setAppleEmail(r.appleEmail || null);
    setStep('apple-pick');
    setTyped('');
    setStatus('idle');
    setStatusMsg('');
  };

  const onAppleClaim = async () => {
    const trimmed = typed.trim();
    if (!deviceId || !trimmed || status !== 'available' || claiming) return;
    setClaiming(true);
    setClaimErr(null);
    const r = await apiClaimHandle(trimmed, deviceId, {
      appleUserId: appleUserId || undefined,
      appleEmail: appleEmail || undefined,
    });
    setClaiming(false);
    if (r.ok && r.handle) {
      playPostShared();
      onClaimed(r.handle);
    } else {
      setClaimErr(r.reason || 'Claim failed.');
    }
  };

  // ---- Email path ----
  const onSendCode = async () => {
    const trimmedHandle = typed.trim();
    const trimmedEmail = email.trim();
    if (!deviceId || !trimmedHandle || status !== 'available') return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setClaimErr('Please enter a valid email.');
      return;
    }
    if (sending) return;
    setSending(true);
    setClaimErr(null);
    const r = await apiStartEmailClaim({
      handle: trimmedHandle,
      email: trimmedEmail,
      deviceId,
    });
    setSending(false);
    if (r.ok) {
      setStep('email-code');
    } else {
      setClaimErr(r.reason || 'Could not send code.');
    }
  };

  const onVerifyCode = async () => {
    const trimmedHandle = typed.trim();
    const cleanCode = code.trim();
    if (!deviceId || !trimmedHandle || !/^\d{6}$/.test(cleanCode)) return;
    if (verifying) return;
    setVerifying(true);
    setClaimErr(null);
    const r = await apiFinishEmailClaim({
      handle: trimmedHandle,
      code: cleanCode,
      deviceId,
    });
    setVerifying(false);
    if (r.ok && r.handle) {
      playPostShared();
      onClaimed(r.handle);
    } else {
      setClaimErr(r.reason || 'Verification failed.');
    }
  };

  // ---- Render ----
  return (
    <div style={S.dreadFeedClaimWrap}>
      <div style={S.dreadFeedClaimInner}>

        {/* ============================================================
            ENTRY STEP — Apple primary, email secondary, recover link.
            ============================================================ */}
        {step === 'entry' && (
          <>
            <div style={S.dreadFeedClaimTitle}>Create your account</div>
            <div style={S.dreadFeedClaimSubtitle}>
              {isIOS()
                ? 'Sign in with Apple to get started in one tap.'
                : 'Sign in with your email to get started.'}
            </div>

            {isIOS() && (
              <>
                <button
                  onClick={onAppleTap}
                  disabled={appleBusy}
                  style={S.dreadFeedAppleBtn}
                  aria-label="Sign in with Apple"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="#FFFFFF" style={{ marginRight: 8 }}>
                    <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
                  </svg>
                  {appleBusy ? 'Connecting…' : 'Sign in with Apple'}
                </button>

                {claimErr && <div style={S.dreadFeedClaimError}>{claimErr}</div>}

                <div style={S.dreadFeedClaimOrRow}>
                  <div style={S.dreadFeedClaimOrLine} />
                  <span style={S.dreadFeedClaimOrText}>or</span>
                  <div style={S.dreadFeedClaimOrLine} />
                </div>
              </>
            )}

            {!isIOS() && claimErr && <div style={S.dreadFeedClaimError}>{claimErr}</div>}

            <button
              onClick={() => {
                setStep('email-pick');
                setClaimErr(null);
                setTyped('');
                setEmail('');
                setStatus('idle');
                setStatusMsg('');
              }}
              style={S.dreadFeedEmailBtn}
            >
              Use email instead
            </button>

            <button
              onClick={() => setRecoverOpen(true)}
              style={S.dreadFeedRecoverLink}
            >
              Lost my phone? Recover account
            </button>
          </>
        )}

        {/* ============================================================
            APPLE-PICK STEP — Apple succeeded, pick a handle.
            ============================================================ */}
        {step === 'apple-pick' && (
          <>
            <div style={S.dreadFeedClaimTitle}>Pick your handle</div>
            <div style={S.dreadFeedClaimSubtitle}>
              This is your forever name on DreadFeed — you can't change it later.
            </div>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value.replace(/[^A-Za-z0-9_]/g, ''))}
              placeholder="username"
              maxLength={20}
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              style={S.dreadFeedClaimInput}
              disabled={claiming}
              autoFocus
            />
            {statusMsg && (
              <div style={{ ...S.dreadFeedClaimStatus, color: statusColor }}>
                {status === 'available' ? '✓ ' :
                 status === 'taken' ? '✗ ' :
                 status === 'invalid' ? '⚠ ' : ''}{statusMsg}
              </div>
            )}
            <button
              onClick={onAppleClaim}
              disabled={status !== 'available' || claiming}
              style={status === 'available' && !claiming ? S.dreadFeedClaimBtn : S.dreadFeedClaimBtnDisabled}
            >
              {claiming ? 'Creating…' : 'Create Account'}
            </button>
            {claimErr && <div style={S.dreadFeedClaimError}>{claimErr}</div>}
            <div style={S.dreadFeedClaimFooter}>
              3–20 characters. Letters, numbers, underscores.
            </div>
            <button
              onClick={() => { setStep('entry'); setClaimErr(null); }}
              style={S.dreadFeedRecoverLink}
            >
              ← Use a different sign-in
            </button>
          </>
        )}

        {/* ============================================================
            EMAIL-PICK STEP — Handle + email, server sends a code.
            ============================================================ */}
        {step === 'email-pick' && (
          <>
            <div style={S.dreadFeedClaimTitle}>Create your account</div>
            <div style={S.dreadFeedClaimSubtitle}>
              Pick a handle and add your email so you can recover your account if you lose your phone.
            </div>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value.replace(/[^A-Za-z0-9_]/g, ''))}
              placeholder="username"
              maxLength={20}
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              style={S.dreadFeedClaimInput}
              disabled={sending}
              autoFocus
            />
            {statusMsg && (
              <div style={{ ...S.dreadFeedClaimStatus, color: statusColor }}>
                {status === 'available' ? '✓ ' :
                 status === 'taken' ? '✗ ' :
                 status === 'invalid' ? '⚠ ' : ''}{statusMsg}
              </div>
            )}
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              inputMode="email"
              style={{ ...S.dreadFeedClaimInput, marginTop: 10 }}
              disabled={sending}
            />
            <button
              onClick={onSendCode}
              disabled={status !== 'available' || sending || !email.trim()}
              style={status === 'available' && !sending && email.trim()
                ? S.dreadFeedClaimBtn
                : S.dreadFeedClaimBtnDisabled}
            >
              {sending ? 'Sending…' : 'Send verification code'}
            </button>
            {claimErr && <div style={S.dreadFeedClaimError}>{claimErr}</div>}
            <div style={S.dreadFeedClaimFooter}>
              We'll email you a 6-digit code to verify it's really you.
            </div>
            <button
              onClick={() => { setStep('entry'); setClaimErr(null); }}
              style={S.dreadFeedRecoverLink}
            >
              {isIOS() ? '← Use Sign in with Apple instead' : '← Back'}
            </button>
          </>
        )}

        {/* ============================================================
            EMAIL-CODE STEP — Type the 6-digit code.
            ============================================================ */}
        {step === 'email-code' && (
          <>
            <div style={S.dreadFeedClaimTitle}>Check your email</div>
            <div style={S.dreadFeedClaimSubtitle}>
              We sent a 6-digit code to <strong>{email.trim()}</strong>. Enter it below.
            </div>
            <input
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              maxLength={6}
              style={{ ...S.dreadFeedClaimInput, letterSpacing: 6, textAlign: 'center', fontSize: 22, fontFamily: 'monospace' }}
              disabled={verifying}
              autoFocus
            />
            <button
              onClick={onVerifyCode}
              disabled={code.length !== 6 || verifying}
              style={code.length === 6 && !verifying
                ? S.dreadFeedClaimBtn
                : S.dreadFeedClaimBtnDisabled}
            >
              {verifying ? 'Verifying…' : 'Verify & create account'}
            </button>
            {claimErr && <div style={S.dreadFeedClaimError}>{claimErr}</div>}
            <button
              onClick={() => { setStep('email-pick'); setCode(''); setClaimErr(null); }}
              style={S.dreadFeedRecoverLink}
            >
              ← Back
            </button>
          </>
        )}
      </div>

      {/* Recover-account modal (Apple-or-email-recovery for existing handles) */}
      {recoverOpen && deviceId && (
        <RecoverAccountModal
          newDeviceId={deviceId}
          onClose={() => setRecoverOpen(false)}
          onRecovered={(recoveredHandle) => {
            setRecoverOpen(false);
            playPostShared();
            onClaimed(recoveredHandle);
          }}
        />
      )}
    </div>
  );
}


function SocialView({ handle, deviceId, sites, currentLocation, onSelectSite, onBack, onSelectHandle, onSelectHashtag, onSelectPost, onHandleClaimed, onSelectSettings, onSelectNotifications, onSelectInbox }: {
  handle: string | null;
  deviceId: string | null;
  sites: SinisterSite[];
  currentLocation: { lat: number; lng: number } | null;
  onSelectSite: (site: SinisterSite) => void;
  onBack: () => void;
  onSelectHandle: (handle: string) => void;
  // v1.14: tapping a hashtag in any caption inside SocialView routes to
  // the dedicated HashtagView for that tag.
  onSelectHashtag: (tag: string) => void;
  onSelectPost: (postId: string, postList?: string[], preloadedPosts?: SocialPost[]) => void;
  // Called when the user successfully claims a handle from the inline
  // ClaimHandleScreen in the Profile tab. The parent App lifts this
  // into its top-level `handle` state so subsequent likes/comments/
  // follows immediately work without a refresh.
  onHandleClaimed: (h: string) => void;
  // Opens the Settings screen, plumbed down to the embedded
  // UserProfileView's gear icon.
  onSelectSettings: () => void;
  // Routes to the NotificationsView when the user taps the bell in
  // the DreadFeed header.
  onSelectNotifications: () => void;
  // v1.15: opens the DM inbox view.
  onSelectInbox: () => void;
}) {
  // Sub-tab inside eXposure. The static black bottom bar switches
  // between four sub-screens: 'feed' (the post feed, eXposure home),
  // 'search' (filter posts by category and/or handle), 'post' (the
  // composer — opens the camera flow), and 'profile' (your own
  // UserProfileView).
  //
  // Tabs only switch the sub-screen *inside* eXposure; they don't
  // navigate out via setView. Tapping the Post tab from a non-feed
  // sub-screen flips back to feed and opens the composer.
  type SubTab = 'feed' | 'search' | 'post' | 'profile';
  // Initialize from the module-level memory so swipe-back from a
  // PostDetailView (or any view that unmounted SocialView) restores
  // the user to the sub-tab they were on. First-ever mount picks up
  // the default 'feed'.
  const [subTab, _setSubTab] = useState<SubTab>(_exposureSubTabMemory);
  // Wrap the setter so every change also updates the module-level
  // memory. Callers don't need to know about the memory.
  const setSubTab = (next: SubTab) => {
    _exposureSubTabMemory = next;
    _setSubTab(next);
  };

  // When the user taps the ➕ Post tab, we open an inline composer
  // overlay. We don't switch sub-tabs because Post is an action, not a
  // sub-screen. The overlay handles the GPS check internally — if no
  // site is within 100m, it shows a "get closer" message; otherwise it
  // surfaces the existing AddPhotoButton composer.
  const [postSheetOpen, setPostSheetOpen] = useState(false);
  // ➕ tap opens a small chooser sheet (Photo vs Poll) before routing
  // to the matching composer. setChooserOpen(true) on ➕ tap; the chooser
  // then either opens postSheetOpen (photo) or pollSheetOpen (poll) and
  // closes itself.
  const [chooserOpen, setChooserOpen] = useState(false);
  const [pollSheetOpen, setPollSheetOpen] = useState(false);
  const [youtubeSheetOpen, setYoutubeSheetOpen] = useState(false);

  // Unread notifications badge count, shown on the bell in the brand
  // header. Polled on mount + every 60 seconds while DreadFeed is open.
  const [unreadCount, setUnreadCount] = useState(0);
  useEffect(() => {
    if (!handle) {
      setUnreadCount(0);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      const n = await apiFetchUnreadCount(handle);
      if (!cancelled) setUnreadCount(n);
    };
    refresh();
    const id = window.setInterval(refresh, 60000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [handle]);

  // v1.15: same pattern for DM unread count. Polls every 30s so the
  // airplane badge updates without the user manually opening the inbox.
  const [dmUnreadCount, setDmUnreadCount] = useState(0);
  useEffect(() => {
    if (!handle) {
      setDmUnreadCount(0);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      const n = await apiUnreadDMs(handle);
      if (!cancelled) setDmUnreadCount(n);
    };
    refresh();
    const id = window.setInterval(refresh, 30000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [handle]);

  // If we have a recent snapshot from a previous mount, seed feed state
  // from it. This makes returning to DreadFeed via swipe-back land the
  // user on the same posts they were viewing instead of refetching from
  // the top. Snapshots expire after 10 minutes so the feed eventually
  // freshens. Only the 'all' feed gets cached this way.
  const initialSnap = (() => {
    if (!_socialFeedMemory) return null;
    if (Date.now() - _socialFeedMemory.capturedAt > SOCIAL_FEED_MEMORY_TTL_MS) {
      _socialFeedMemory = null;
      return null;
    }
    return _socialFeedMemory;
  })();
  const [posts, setPosts] = useState<SocialPost[]>(initialSnap ? initialSnap.posts : []);
  const [nextBefore, setNextBefore] = useState<string | null>(initialSnap ? initialSnap.nextBefore : null);
  // Polls live in parallel with posts. Fetched alongside the feed and
  // merged chronologically at render time. Separate state keeps the
  // post code paths (search view, profile grid, etc.) untouched. Pagination
  // is independent — polls have their own nextBefore cursor.
  const [polls, setPolls] = useState<PollEntry[]>([]);
  const [pollsNextBefore, setPollsNextBefore] = useState<string | null>(null);
  // Loading=true only if we have nothing seeded. If we restored from a
  // snapshot, we already have posts to show — no loading flicker.
  const [loading, setLoading] = useState(!initialSnap);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Feed mode toggle — 'all' shows every approved post; 'following'
  // restricts to posts by handles the current user follows. Persists
  // for the session only (resets on remount). When the user has no
  // handle claimed, 'following' is hidden in the UI.
  type FeedMode = 'all' | 'following';
  const [feedMode, setFeedMode] = useState<FeedMode>('all');

  // Helper: load a page from the right endpoint depending on feed mode.
  // Following mode requires a handle; falls back to empty page if not.
  // After fetching, we filter out posts authored by handles the viewer
  // has blocked AND posts the viewer has personally hidden. Server
  // doesn't know about either, so filtering is client-side. Anonymous
  // viewers (no handle) skip the block list but still get post hides.
  const loadPage = async (before: string | null): Promise<FeedPage> => {
    let page: FeedPage;
    if (feedMode === 'following') {
      if (!handle) return { posts: [], nextBefore: null };
      page = await apiFetchFollowingFeed({ handle, limit: 20, before });
    } else {
      page = await apiFetchFeed({ limit: 20, before });
    }
    const hiddenPosts = await loadHiddenPosts();
    let filtered = page.posts;
    if (hiddenPosts.size > 0) {
      filtered = filtered.filter((p) => !hiddenPosts.has(p.id));
    }
    if (handle) {
      const hidden = await getHiddenSet(handle);
      if (hidden.size > 0) {
        filtered = filtered.filter((p) => !hidden.has((p.handle || '').toLowerCase()));
      }
    }
    return { posts: filtered, nextBefore: page.nextBefore };
  };

  // ---- Pull-to-refresh state ----
  // When the user is at scrollY=0 and starts dragging down, we record the
  // initial Y in _pullStartY. As they drag, _pullDistance grows. At
  // PULL_THRESHOLD_PX of drag, the indicator switches from "pull to refresh"
  // to "release to refresh". Releasing past the threshold triggers a feed
  // refetch. Released early → snap back, no-op. While refreshing is true
  // we show a spinner and ignore further pulls.
  const PULL_THRESHOLD_PX = 70;
  const PULL_MAX_PX = 120;
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const _pullStartY = useRef<number | null>(null);
  // True once the current drag has crossed PULL_THRESHOLD_PX. Used to
  // fire the haptic tap exactly once per drag (when crossing the line)
  // rather than continuously while held past threshold. Resets on touch
  // start so the next drag fires fresh.
  const _pullCrossedThreshold = useRef<boolean>(false);

  // Refresh = reload from the top. Called by pull-to-refresh on release
  // past threshold. Replaces the entire feed since we're back to the
  // newest post; resets the nextBefore cursor. Also wipes the memory
  // snapshot so the next remount fetches fresh — pull-refresh is an
  // Polls fetch — runs in parallel with posts. Only in 'all' mode; the
  // following feed stays photo-only. Returns empty if the call fails so
  // a polls outage never breaks the photo feed.
  const loadPollsPage = async (before: string | null): Promise<PollFeedPage> => {
    if (feedMode === 'following') return { polls: [], nextBefore: null };
    return apiFetchPollsFeed({ limit: 20, before, handle });
  };

  // explicit "I want new content" signal from the user.
  const refreshFeed = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const [page, pollsPage] = await Promise.all([
        loadPage(null),
        loadPollsPage(null),
      ]);
      setPosts(page.posts);
      setNextBefore(page.nextBefore);
      setPolls(pollsPage.polls);
      setPollsNextBefore(pollsPage.nextBefore);
      _socialFeedMemory = null;
    } catch { /* silent — keep prior feed visible */ }
    setRefreshing(false);
    setPullDistance(0);
  };

  // Initial load — and also re-load when feedMode flips between
  // All / Following so the user gets fresh content for the chosen tab.
  // SPECIAL CASE: on first mount, if we restored from _socialFeedMemory,
  // skip the network fetch entirely — we already have posts seeded.
  // The user gets an instant return-to-feed experience. We still fire
  // a refresh on feedMode flips or handle changes since those are user
  // actions that imply they want fresh data.
  const skipInitialLoadRef = useRef(initialSnap !== null);
  useEffect(() => {
    if (skipInitialLoadRef.current) {
      // Only skip the FIRST run — subsequent feedMode/handle changes
      // still trigger a real fetch.
      skipInitialLoadRef.current = false;
      // Restore scroll position. RAF gives the layout one frame to
      // commit so document height is correct before we scroll.
      const targetY = initialSnap ? initialSnap.scrollY : 0;
      requestAnimationFrame(() => { window.scrollTo(0, targetY); });
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const [page, pollsPage] = await Promise.all([
        loadPage(null),
        loadPollsPage(null),
      ]);
      if (cancelled) return;
      setPosts(page.posts);
      setNextBefore(page.nextBefore);
      setPolls(pollsPage.polls);
      setPollsNextBefore(pollsPage.nextBefore);
      setLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedMode, handle]);

  // Snapshot feed state to module-level memory on unmount so a return
  // to DreadFeed restores the same feed + scroll position the user
  // was viewing. Only snapshots the 'all' feed (skip 'following' to
  // keep the cache simple and small).
  useEffect(() => {
    return () => {
      if (feedMode === 'all' && posts.length > 0) {
        _socialFeedMemory = {
          posts,
          nextBefore,
          scrollY: window.scrollY,
          capturedAt: Date.now(),
        };
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posts, nextBefore, feedMode]);

  // Load more — called when the user scrolls near the bottom. Pulls
  // the next page of posts AND polls in parallel (each has its own
  // cursor). Either may exhaust before the other; we only stop calling
  // when both are exhausted.
  const loadMore = async () => {
    if (loadingMore) return;
    if (!nextBefore && !pollsNextBefore) return;
    setLoadingMore(true);
    const [page, pollsPage] = await Promise.all([
      nextBefore ? loadPage(nextBefore) : Promise.resolve({ posts: [], nextBefore: null } as FeedPage),
      pollsNextBefore ? loadPollsPage(pollsNextBefore) : Promise.resolve({ polls: [], nextBefore: null } as PollFeedPage),
    ]);
    setPosts((prev) => [...prev, ...page.posts]);
    setNextBefore(page.nextBefore);
    setPolls((prev) => [...prev, ...pollsPage.polls]);
    setPollsNextBefore(pollsPage.nextBefore);
    setLoadingMore(false);
  };

  // Scroll listener for infinite scroll. Trigger when user is within
  // ~800px of the bottom of the page. Either cursor (posts or polls)
  // being non-null means there's still more to fetch.
  useEffect(() => {
    const onScroll = () => {
      if ((!nextBefore && !pollsNextBefore) || loadingMore) return;
      const scrollPos = window.scrollY + window.innerHeight;
      const docHeight = document.documentElement.scrollHeight;
      if (docHeight - scrollPos < 800) {
        loadMore();
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextBefore, pollsNextBefore, loadingMore]);

  // Site lookup for tap-to-DetailView. Sites are passed down from App so
  // we don't refetch.
  const siteById = useMemo(() => {
    const m = new Map<string, SinisterSite>();
    for (const s of sites) m.set(s.id, s);
    return m;
  }, [sites]);

  // ====== ACCOUNT GATE ======
  // DreadFeed is a social mini-app — feed, posts, likes, comments,
  // follows, profiles all require an identity. Rather than letting
  // anonymous users browse and hit "sign up to react" on every tap,
  // we gate the entire mini-app: the very first thing a no-account
  // user sees inside DreadFeed is the signup screen. They either
  // complete signup (Apple ID or email) and land in the feed, or
  // swipe back to exit DreadFeed entirely.
  //
  // No bottom bar, no brand header — just the signup screen full-
  // bleed so it reads as a gate, not a sub-tab.
  if (!handle) {
    return (
      <div style={S.socialViewWrap}>
        <DreadFeedClaimScreen
          deviceId={deviceId}
          onClaimed={onHandleClaimed}
        />
      </div>
    );
  }

  return (
    <div
      style={S.socialViewWrap}
      onTouchStart={(e) => {
        // Only arm pull-to-refresh when the user starts a touch at the
        // top of the page. Anywhere mid-scroll, this is a normal scroll.
        if (window.scrollY > 0 || refreshing) return;
        _pullStartY.current = e.touches[0].clientY;
        _pullCrossedThreshold.current = false;
      }}
      onTouchMove={(e) => {
        if (_pullStartY.current === null || refreshing) return;
        const dy = e.touches[0].clientY - _pullStartY.current;
        if (dy <= 0) {
          setPullDistance(0);
          return;
        }
        // Apply rubber-banding so the pull feels resistant past threshold.
        // 1:1 until threshold, then halved.
        const eased = dy < PULL_THRESHOLD_PX
          ? dy
          : PULL_THRESHOLD_PX + (dy - PULL_THRESHOLD_PX) * 0.5;
        // Fire a single light haptic tap the moment the user crosses
        // the trigger line, matching IG's pattern: it confirms "release
        // now and the feed will refresh" without buzzing continuously.
        if (!_pullCrossedThreshold.current && eased >= PULL_THRESHOLD_PX) {
          _pullCrossedThreshold.current = true;
          haptic('light');
        }
        setPullDistance(Math.min(eased, PULL_MAX_PX));
      }}
      onTouchEnd={() => {
        if (_pullStartY.current === null) return;
        _pullStartY.current = null;
        if (pullDistance >= PULL_THRESHOLD_PX && !refreshing) {
          void refreshFeed();
        } else {
          setPullDistance(0);
        }
      }}
    >
      {/* ====== PERMANENT eXposure BRAND HEADER ======
          Sits at the top of every sub-tab (Feed, Search, Post, Profile).
          Black bar with the eXposure brand on top and a short tagline
          underneath. Sticky so it stays visible while the feed scrolls.
          Pull-to-refresh and per-sub-tab headers render BELOW this. */}
      <ExposureBrandHeader
        unreadCount={unreadCount}
        dmUnreadCount={dmUnreadCount}
        onTapBell={onSelectNotifications}
        onTapInbox={handle ? onSelectInbox : undefined}
      />

      {/* ====== FEED sub-tab ====== */}
      {subTab === 'feed' && (
        <>
          {/* Pull-to-refresh indicator. */}
          <div style={{
            ...S.pullIndicator,
            height: refreshing ? PULL_THRESHOLD_PX : pullDistance,
            opacity: refreshing || pullDistance > 8 ? 1 : 0,
          }}>
            <span style={S.pullIndicatorText}>
              {refreshing
                ? 'Refreshing…'
                : pullDistance >= PULL_THRESHOLD_PX
                  ? 'Release to refresh'
                  : 'Pull to refresh'}
            </span>
          </div>

          {/* Following / For You segmented toggle — only shown when the
              user has a claimed handle (Following mode is meaningless
              without one). Two equal-width buttons, the active one is
              underlined and bold. Tapping flips feedMode which triggers
              a refetch via the useEffect dep. */}
          {handle && (
            <div style={S.feedModeRow}>
              <button
                onClick={() => setFeedMode('all')}
                style={feedMode === 'all' ? S.feedModeBtnActive : S.feedModeBtn}
              >
                For You
              </button>
              <button
                onClick={() => setFeedMode('following')}
                style={feedMode === 'following' ? S.feedModeBtnActive : S.feedModeBtn}
              >
                Following
              </button>
            </div>
          )}

          {/* Feed body */}
          {loading ? (
            <div style={S.socialEmpty}>Loading the feed…</div>
          ) : error ? (
            <div style={S.socialEmpty}>⚠ {error}</div>
          ) : posts.length === 0 && polls.length === 0 ? (
            <div style={S.socialEmpty}>
              {feedMode === 'following'
                ? 'No posts from accounts you follow yet.'
                : 'No posts yet.'}<br />
              <span style={{ opacity: 0.7, fontSize: 13 }}>
                Visit a site and tap "Post to DreadFeed" to be the first.
              </span>
            </div>
          ) : (
            <div style={{ ...S.socialFeed, paddingBottom: 80 }}>
              {/* Merge posts and polls into one chronological feed by
                  createdAt/approvedAt. Each item is tagged with a `kind`
                  so the render switch can pick the right card. Polls
                  carry their `type:'poll'` discriminator from the
                  server; posts don't, hence the dual approach. */}
              {(() => {
                type FeedItem =
                  | { kind: 'post'; item: SocialPost; ts: string }
                  | { kind: 'poll'; item: PollEntry; ts: string };
                const merged: FeedItem[] = [];
                for (const p of posts) {
                  merged.push({ kind: 'post', item: p, ts: p.approvedAt || p.createdAt || '' });
                }
                for (const pl of polls) {
                  merged.push({ kind: 'poll', item: pl, ts: pl.createdAt || '' });
                }
                merged.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
                return merged.map((entry) => {
                  if (entry.kind === 'poll') {
                    const pl = entry.item;
                    return (
                      <SocialPollCard
                        key={'poll:' + pl.id}
                        poll={pl}
                        currentHandle={handle}
                        deviceId={deviceId}
                        onHandleTap={() => onSelectHandle(pl.handle)}
                      />
                    );
                  }
                  const p = entry.item;
                  return (
                    <SocialPostCard
                      key={p.id}
                      post={p}
                      currentHandle={handle}
                      deviceId={deviceId}
                      onSiteTap={() => {
                        const s = siteById.get(p.siteId);
                        if (s) onSelectSite(s);
                      }}
                      onHandleTap={() => onSelectHandle(p.handle)}
                      onHashtagTap={(tag) => onSelectHashtag(tag)}
                      onPostRemoved={(postId) => {
                        setPosts((prev) => prev.filter((x) => x.id !== postId));
                      }}
                    />
                  );
                });
              })()}
              {loadingMore && <div style={S.socialEmpty}>Loading more…</div>}
              {!nextBefore && !pollsNextBefore && (posts.length > 0 || polls.length > 0) && (
                <div style={{ ...S.socialEmpty, paddingTop: 20, paddingBottom: 40 }}>
                  <span style={{ opacity: 0.5, fontSize: 12 }}>— end of feed —</span>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ====== SEARCH sub-tab ====== */}
      {subTab === 'search' && (
        <ExposureSearchView
          allPosts={posts}
          currentHandle={handle}
          deviceId={deviceId}
          sites={sites}
          onSelectSite={onSelectSite}
          onSelectHandle={onSelectHandle}
          onSelectHashtag={onSelectHashtag}
        />
      )}

      {/* ====== PROFILE sub-tab ======
          handle is guaranteed non-null here because the account gate
          at the top of SocialView short-circuits when there's no
          handle, rendering the signup screen instead. */}
      {subTab === 'profile' && (
        <UserProfileView
          profileHandle={handle}
          currentHandle={handle}
          deviceId={deviceId}
          sites={sites}
          onSelectSite={onSelectSite}
          onSelectBadges={(h) => { /* tab-bound; ignore deep link */ void h; }}
          onSelectPost={onSelectPost}
          onSelectHandle={onSelectHandle}
          onSelectSettings={onSelectSettings}
          onBack={() => setSubTab('feed')}
          embedded
        />
      )}

      {/* ====== POST sub-tab — never renders a sub-screen, just triggers
          the camera composer via PostFromExposure handler below ====== */}

      {/* Static bottom bar — Instagram-style. Sits fixed at the bottom of
          the viewport, immune to scroll and the swipe-back gesture
          (because pointer-events: auto + z-index above the gesture
          target). Four white SVG icons; the active tab gets a brighter
          white + glow. */}
      <ExposureBottomBar
        active={subTab}
        onSelect={(tab) => {
          if (tab === 'post') {
            // ➕ opens a chooser (Photo vs Poll) — the chooser then
            // routes to ExposurePostSheet or PollComposerSheet. We don't
            // switch sub-tabs because Post is an action, not a screen.
            playSubDrop();
            setChooserOpen(true);
            return;
          }
          playSubDrop();
          setSubTab(tab);
        }}
      />

      {/* ➕ chooser — Photo, YouTube, or Poll. Tiny bottom-sheet modal
          that routes the user to the matching composer flow. */}
      {chooserOpen && (
        <ChoosePostTypeSheet
          onPickPhoto={() => {
            setChooserOpen(false);
            setPostSheetOpen(true);
          }}
          onPickPoll={() => {
            setChooserOpen(false);
            setPollSheetOpen(true);
          }}
          onPickYouTube={() => {
            setChooserOpen(false);
            setYoutubeSheetOpen(true);
          }}
          onCancel={() => setChooserOpen(false)}
        />
      )}

      {/* Post composer sheet — opened by the chooser after picking Photo.
          Runs the IG-style multi-stage camera + editor + caption flow. */}
      {postSheetOpen && (
        <ExposurePostSheet
          handle={handle}
          deviceId={deviceId}
          onClose={() => setPostSheetOpen(false)}
          onPosted={() => {
            setPostSheetOpen(false);
            showToast('Posted to DreadFeed', 'success');
            void refreshFeed();
          }}
        />
      )}

      {/* Poll composer sheet — opened by the chooser after picking Poll.
          Question + 4 options. Auto-approved server-side, no admin queue. */}
      {pollSheetOpen && (
        <PollComposerSheet
          handle={handle}
          deviceId={deviceId}
          onClose={() => setPollSheetOpen(false)}
          onPosted={() => {
            setPollSheetOpen(false);
            showToast('Poll posted', 'success');
            void refreshFeed();
          }}
        />
      )}

      {/* YouTube composer sheet — opened by the chooser after picking
          YouTube Video. URL paste + caption. Auto-approved server-side
          (YouTube already moderates), no admin queue. */}
      {youtubeSheetOpen && (
        <YouTubeComposerSheet
          handle={handle}
          deviceId={deviceId}
          onClose={() => setYoutubeSheetOpen(false)}
          onPosted={() => {
            setYoutubeSheetOpen(false);
            showToast('YouTube post shared', 'success');
            void refreshFeed();
          }}
        />
      )}
    </div>
  );
}

// Instagram-style static bottom bar for eXposure. Four icons, white
// outlined SVG. Active tab brightens + glows white. Fixed at the bottom
// of the viewport so it doesn't move with feed scroll.
function ExposureBottomBar({ active, onSelect }: {
  active: 'feed' | 'search' | 'post' | 'profile';
  onSelect: (tab: 'feed' | 'search' | 'post' | 'profile') => void;
}) {
  const Item = ({ tab, label, children }: { tab: 'feed' | 'search' | 'post' | 'profile'; label: string; children: React.ReactNode }) => {
    const isActive = active === tab;
    return (
      <button
        onClick={() => onSelect(tab)}
        aria-label={label}
        className="sinister-icon-btn"
        style={{
          ...S.exposureBarBtn,
          ...(isActive ? S.exposureBarBtnActive : {}),
        }}
      >
        {children}
      </button>
    );
  };
  return createPortal(
    <div style={S.exposureBar}>
      <Item tab="feed" label="Home">
        {/* Home icon (house) */}
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 11.5L12 4l9 7.5" />
          <path d="M5 10v9.5a.5.5 0 0 0 .5.5H10v-6h4v6h4.5a.5.5 0 0 0 .5-.5V10" />
        </svg>
      </Item>
      <Item tab="search" label="Search">
        {/* Search icon (magnifier) */}
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="6.5" />
          <line x1="16" y1="16" x2="20" y2="20" />
        </svg>
      </Item>
      <Item tab="post" label="Post">
        {/* Plus icon in a rounded square */}
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
          <line x1="12" y1="8" x2="12" y2="16" />
          <line x1="8" y1="12" x2="16" y2="12" />
        </svg>
      </Item>
      <Item tab="profile" label="Profile">
        {/* Person icon */}
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="8" r="4" />
          <path d="M4 20c0-4 4-6 8-6s8 2 8 6" />
        </svg>
      </Item>
    </div>,
    document.body
  );
}

// ---------- ExposurePostEditor ----------
// Photo editing screen that sits between 'pick' and 'caption' in the
// IG-style composer. Lets the user:
//   - Toggle a filmstrip border overlay (on by default)
//   - Drag 12 horror SVG stickers onto the photo
//   - Add a single freeform text caption (Jolly Lodger) draggable to position
//
// When the user taps "Next", we bake every layer into a flat JPEG via
// canvas and hand the resulting File back to the parent. The server-side
// pipeline (Sharp resize + EXIF strip + R2 upload) doesn't change.

// ---- Sticker library ----
// OpenMoji horror stickers via jsDelivr's GitHub CDN. Licensed CC BY-SA 4.0
// — credit in the app About page is the only obligation. SVG format,
// crisp at any size, ~5-15KB each. The /gh/ jsDelivr path serves files
// from the GitHub repo directly (the /npm/ path doesn't include the PNG
// build artifacts — only the source SVGs are published to npm).
//
// Codepoints are uppercase hex with hyphens for ZWJ-joined sequences.
type HorrorSticker = {
  id: string;
  name: string;
  url: string;
};

const OPENMOJI_BASE = 'https://cdn.jsdelivr.net/gh/hfg-gmuend/openmoji@15.1.0/color/svg';

const HORROR_STICKERS: HorrorSticker[] = [
  { id: 'skull',     name: 'Skull',           url: `${OPENMOJI_BASE}/1F480.svg` },
  { id: 'skullbones',name: 'Skull & bones',   url: `${OPENMOJI_BASE}/2620.svg` },
  { id: 'ghost',     name: 'Ghost',           url: `${OPENMOJI_BASE}/1F47B.svg` },
  { id: 'vampire',   name: 'Vampire',         url: `${OPENMOJI_BASE}/1F9DB.svg` },
  { id: 'zombie',    name: 'Zombie',          url: `${OPENMOJI_BASE}/1F9DF.svg` },
  { id: 'pumpkin',   name: 'Jack-o-lantern',  url: `${OPENMOJI_BASE}/1F383.svg` },
  { id: 'bat',       name: 'Bat',             url: `${OPENMOJI_BASE}/1F987.svg` },
  { id: 'spider',    name: 'Spider',          url: `${OPENMOJI_BASE}/1F577.svg` },
  { id: 'web',       name: 'Spider web',      url: `${OPENMOJI_BASE}/1F578.svg` },
  { id: 'crystalball',name: 'Crystal ball',   url: `${OPENMOJI_BASE}/1F52E.svg` },
  { id: 'candle',    name: 'Candle',          url: `${OPENMOJI_BASE}/1F56F.svg` },
  { id: 'coffin',    name: 'Coffin',          url: `${OPENMOJI_BASE}/26B0.svg` },
  { id: 'fire',      name: 'Fire',            url: `${OPENMOJI_BASE}/1F525.svg` },
  { id: 'eye',       name: 'Eye',             url: `${OPENMOJI_BASE}/1F441.svg` },
];

// Layers placed on the photo. Position is normalized (0-1) so layers
// rescale with the preview vs the final baked canvas. Scale is a multiplier
// of base size (stickers: 80px on preview). Rotation in degrees.
type StickerLayer = {
  kind: 'sticker';
  id: string;          // local instance id
  stickerId: string;   // index into HORROR_STICKERS
  x: number;           // 0..1 normalized center
  y: number;           // 0..1 normalized center
  scale: number;       // 1.0 = base
  rotation: number;    // degrees
};

// Editor text fonts — 6 horror-themed faces. The id is what's persisted
// on the TextLayer; the cssStack is what gets passed to ctx.font during
// bake AND to fontFamily in the live preview, so the user sees exactly
// what they'll get in the final JPEG. Bunny.net imports are issued once
// in buildStyleCss(); system fallbacks cover the cases where the user is
// offline mid-bake.
type FontId = 'jollyLodger' | 'creepster' | 'specialElite' | 'permanentMarker' | 'oswald' | 'shareTechMono';
const EDITOR_FONTS: { id: FontId; name: string; cssStack: string; weight: number }[] = [
  { id: 'jollyLodger',     name: 'Jolly Lodger', cssStack: '"Jolly Lodger", serif',                       weight: 700 },
  { id: 'creepster',       name: 'Creepster',    cssStack: '"Creepster", "Jolly Lodger", serif',          weight: 400 },
  { id: 'specialElite',    name: 'Typewriter',   cssStack: '"Special Elite", "Courier New", monospace',   weight: 400 },
  { id: 'permanentMarker', name: 'Marker',       cssStack: '"Permanent Marker", "Jolly Lodger", cursive', weight: 400 },
  { id: 'oswald',          name: 'Display',      cssStack: '"Oswald", "Impact", system-ui, sans-serif',   weight: 700 },
  { id: 'shareTechMono',   name: 'Mono',         cssStack: '"Share Tech Mono", "Courier New", monospace', weight: 400 },
];
function fontFor(id: FontId): { cssStack: string; weight: number } {
  return EDITOR_FONTS.find((f) => f.id === id) || EDITOR_FONTS[0];
}

type TextLayer = {
  kind: 'text';
  id: string;
  text: string;
  x: number;
  y: number;
  scale: number;       // font scaling
  rotation: number;
  fontId: FontId;      // which face from EDITOR_FONTS (defaults to jollyLodger for back-compat)
};

type EditorLayer = StickerLayer | TextLayer;

function makeLayerId() {
  return 'l_' + Math.random().toString(36).slice(2, 10);
}

// Filter presets — applied via canvas `filter` property at bake time
// and via the equivalent CSS filter on the live preview. Keys match the
// FILTER_PRESETS array entries.
type FilterId = 'none' | 'foundFootage' | 'polaroid' | 'nightVision' | 'vhs' | 'crimeScene' | 'cursed' | 'asylum' | 'bloodstain' | 'ouija' | 'static' | 'coldCase' | 'witness';

const FILTER_PRESETS: { id: FilterId; name: string; css: string }[] = [
  { id: 'none',         name: 'Original',      css: 'none' },
  { id: 'foundFootage', name: 'Found Footage', css: 'grayscale(0.4) sepia(0.25) hue-rotate(60deg) contrast(1.15) brightness(0.9)' },
  { id: 'polaroid',     name: 'Polaroid',      css: 'sepia(0.6) contrast(0.95) brightness(1.05) saturate(0.85)' },
  { id: 'nightVision',  name: 'Night Vision',  css: 'grayscale(1) sepia(1) hue-rotate(60deg) saturate(8) brightness(0.8) contrast(1.4)' },
  { id: 'vhs',          name: 'VHS',           css: 'contrast(1.2) saturate(1.4) brightness(0.95) hue-rotate(-5deg)' },
  { id: 'crimeScene',   name: 'Crime Scene',   css: 'contrast(1.6) brightness(0.85) saturate(0.3)' },
  { id: 'cursed',       name: 'Cursed',        css: 'contrast(1.4) saturate(1.6) hue-rotate(-15deg) brightness(0.88)' },
  // New filters added in the second editor pass.
  { id: 'asylum',       name: 'Asylum',        css: 'grayscale(0.7) sepia(0.2) hue-rotate(180deg) saturate(1.2) brightness(0.92) contrast(1.15)' },
  { id: 'bloodstain',   name: 'Bloodstain',    css: 'saturate(2) hue-rotate(-25deg) contrast(1.35) brightness(0.9)' },
  { id: 'ouija',        name: 'Ouija',         css: 'sepia(0.85) saturate(0.9) brightness(0.95) contrast(1.2) hue-rotate(-10deg)' },
  { id: 'static',       name: 'Static',        css: 'grayscale(1) contrast(1.5) brightness(1.1)' },
  { id: 'coldCase',     name: 'Cold Case',     css: 'saturate(0.5) contrast(0.95) brightness(1.05) sepia(0.15)' },
  { id: 'witness',      name: 'Witness',       css: 'blur(0.4px) contrast(1.1) brightness(0.93) saturate(1.1)' },
];

function filterCssFor(id: FilterId): string {
  return FILTER_PRESETS.find((f) => f.id === id)?.css || 'none';
}

// Crop rectangle in normalized coords (0..1 of source).
type CropRect = { x: number; y: number; w: number; h: number };
const FULL_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 };

// Bake the photo + crop + rotate + filter + filmstrip + layers into a JPEG File.
// Order: crop → rotate → filter → filmstrip → stickers/text → JPEG export.
// canvasSize targets 1200px max edge to match server Sharp resize.
async function bakePostImage(opts: {
  sourceFile: File;
  crop: CropRect;
  rotation: 0 | 90 | 180 | 270;
  filter: FilterId;
  filmstripOn: boolean;
  layers: EditorLayer[];
  stickers: HorrorSticker[];
}): Promise<File> {
  const { sourceFile, crop, rotation, filter, filmstripOn, layers, stickers } = opts;

  // Load source image
  const sourceImg = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('source image load failed'));
    img.src = URL.createObjectURL(sourceFile);
  });

  // Compute cropped pixel rect on the source image.
  const srcW = sourceImg.naturalWidth;
  const srcH = sourceImg.naturalHeight;
  const cropPxW = Math.max(1, Math.round(crop.w * srcW));
  const cropPxH = Math.max(1, Math.round(crop.h * srcH));
  const cropPxX = Math.round(crop.x * srcW);
  const cropPxY = Math.round(crop.y * srcH);

  // After rotation, dimensions may swap.
  const isPortraitFromRotation = rotation === 90 || rotation === 270;
  const postRotW = isPortraitFromRotation ? cropPxH : cropPxW;
  const postRotH = isPortraitFromRotation ? cropPxW : cropPxH;

  // Scale to max 1200 longest edge.
  const maxDim = 1200;
  let outW = postRotW;
  let outH = postRotH;
  if (outW > outH && outW > maxDim) {
    outH = Math.round(outH * (maxDim / outW));
    outW = maxDim;
  } else if (outH > maxDim) {
    outW = Math.round(outW * (maxDim / outH));
    outH = maxDim;
  }

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');

  // 1) Apply filter (via ctx.filter — Safari iOS 15+ supports this).
  // CSS filter syntax is the same we use on the preview img.
  ctx.filter = filterCssFor(filter);

  // 2) Draw crop + rotate. We rotate the canvas around its center so
  // the cropped region lands in [0,0,outW,outH] regardless of orientation.
  ctx.save();
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  // Draw the cropped region centered on the (now-rotated) canvas.
  // Source rect comes from the original image; dest rect is the unrotated bounds.
  const drawW = isPortraitFromRotation ? outH : outW;
  const drawH = isPortraitFromRotation ? outW : outH;
  ctx.drawImage(
    sourceImg,
    cropPxX, cropPxY, cropPxW, cropPxH,
    -drawW / 2, -drawH / 2, drawW, drawH
  );
  ctx.restore();

  // Reset filter so overlays draw clean.
  ctx.filter = 'none';

  // 3) Filmstrip border overlay
  if (filmstripOn) {
    const barH = Math.round(outH * 0.06);
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, outW, barH);
    ctx.fillRect(0, outH - barH, outW, barH);

    const holeW = Math.round(barH * 0.5);
    const holeH = Math.round(barH * 0.55);
    const holeY1 = Math.round((barH - holeH) / 2);
    const holeY2 = outH - barH + holeY1;
    const gap = Math.round(holeW * 1.6);
    const totalStep = holeW + gap;
    const startX = Math.round((outW % totalStep) / 2);

    ctx.fillStyle = '#F5EFE0';
    for (let x = startX; x + holeW < outW; x += totalStep) {
      const r = Math.min(holeW, holeH) * 0.25;
      const drawHole = (yPos: number) => {
        ctx.beginPath();
        ctx.moveTo(x + r, yPos);
        ctx.lineTo(x + holeW - r, yPos);
        ctx.arcTo(x + holeW, yPos, x + holeW, yPos + r, r);
        ctx.lineTo(x + holeW, yPos + holeH - r);
        ctx.arcTo(x + holeW, yPos + holeH, x + holeW - r, yPos + holeH, r);
        ctx.lineTo(x + r, yPos + holeH);
        ctx.arcTo(x, yPos + holeH, x, yPos + holeH - r, r);
        ctx.lineTo(x, yPos + r);
        ctx.arcTo(x, yPos, x + r, yPos, r);
        ctx.closePath();
        ctx.fill();
      };
      drawHole(holeY1);
      drawHole(holeY2);
    }
  }

  // 4) Draw layers (stickers + text) — these sit on top of crop/rotate/filter,
  // so they appear at the position the user dragged them on the preview.
  const stickerBase = Math.round(Math.min(outW, outH) * 0.16);

  // Pre-load PNG stickers needed by this post. crossOrigin='anonymous' so
  // the canvas doesn't get tainted (JSDelivr serves the right CORS header).
  const stickerImgs = new Map<string, HTMLImageElement>();
  await Promise.all(
    Array.from(new Set(
      layers.filter((l): l is StickerLayer => l.kind === 'sticker').map((l) => l.stickerId)
    )).map(async (sid) => {
      const def = stickers.find((s) => s.id === sid);
      if (!def) return;
      try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const im = new Image();
          im.crossOrigin = 'anonymous';
          im.onload = () => resolve(im);
          im.onerror = () => reject(new Error('sticker png load failed: ' + sid));
          im.src = def.url;
        });
        stickerImgs.set(sid, img);
      } catch (e) {
        // Silently skip stickers that fail to load — better than failing
        // the whole bake when one CDN asset is down.
        console.warn('[editor] sticker load failed', sid, e);
      }
    })
  );

  for (const layer of layers) {
    ctx.save();
    const cx = layer.x * outW;
    const cy = layer.y * outH;
    ctx.translate(cx, cy);
    ctx.rotate((layer.rotation * Math.PI) / 180);

    if (layer.kind === 'sticker') {
      const img = stickerImgs.get(layer.stickerId);
      if (img) {
        const size = stickerBase * layer.scale;
        ctx.drawImage(img, -size / 2, -size / 2, size, size);
      }
    } else if (layer.kind === 'text') {
      const fontSize = Math.round(stickerBase * 0.45 * layer.scale);
      const font = fontFor(layer.fontId);
      ctx.font = `${font.weight} ${fontSize}px ${font.cssStack}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = '#DC2626';
      ctx.shadowBlur = Math.round(fontSize * 0.15);
      ctx.shadowOffsetX = Math.round(fontSize * 0.06);
      ctx.shadowOffsetY = Math.round(fontSize * 0.06);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(layer.text, 0, 0);
    }

    ctx.restore();
  }

  // 5) Export to JPEG File. Note: if a cross-origin sticker tainted the
  // canvas, toBlob throws — we catch that and rethrow with a clearer message.
  let blob: Blob | null;
  try {
    blob = await new Promise<Blob | null>((resolve, reject) => {
      canvas.toBlob((b) => {
        if (!b) reject(new Error('toBlob returned null'));
        else resolve(b);
      }, 'image/jpeg', 0.92);
    });
  } catch (err: any) {
    throw new Error('canvas export failed (possibly CORS): ' + (err?.message || err));
  }
  if (!blob) throw new Error('canvas toBlob failed');

  const origName = sourceFile.name || 'post';
  const baseName = origName.replace(/\.[^.]+$/, '');
  return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' });
}

// ---- The editor screen ----
function ExposurePostEditor({ photoFile, onBack, onNext }: {
  photoFile: File;
  onBack: () => void;
  onNext: (editedFile: File) => void;
}) {
  const [filmstripOn, setFilmstripOn] = useState(false);
  const [filterId, setFilterId] = useState<FilterId>('none');
  const [crop, setCrop] = useState<CropRect>(FULL_CROP);
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);
  const [layers, setLayers] = useState<EditorLayer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // tray null = normal editor with stickers/text/filmstrip toolbar
  // tray 'crop' / 'filter' = full-screen sub-tool
  // tray 'stickers' / 'text' = bottom drawer
  const [tray, setTray] = useState<'stickers' | 'text' | 'crop' | 'filter' | null>(null);
  const [textInput, setTextInput] = useState('');
  // Selected font for the next text layer added. Once a layer is created, it
  // carries its own fontId so changing this doesn't retroactively affect
  // existing text layers — to change one of those, the user tags it as
  // selected and picks a new font in the tray header.
  const [selectedFont, setSelectedFont] = useState<FontId>('jollyLodger');
  const [baking, setBaking] = useState(false);

  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewUrl = useMemo(() => URL.createObjectURL(photoFile), [photoFile]);
  useEffect(() => () => URL.revokeObjectURL(previewUrl), [previewUrl]);

  // Disable the global swipe-back gesture while the editor is open.
  // Horizontal swipes inside the editor (font picker, filter strip, sticker
  // drawer scroll, dragging stickers/text across the canvas) would otherwise
  // be hijacked by the swipe-back handler and pop the user back to the
  // pick-photo screen mid-edit, losing all their work.
  useEffect(() => {
    beginSuppressSwipeBack();
    return () => { endSuppressSwipeBack(); };
  }, []);

  const addSticker = (stickerId: string) => {
    setLayers((prev) => [
      ...prev,
      { kind: 'sticker', id: makeLayerId(), stickerId, x: 0.5, y: 0.5, scale: 1, rotation: 0 },
    ]);
    setTray(null);
  };

  const addText = () => {
    const trimmed = textInput.trim();
    if (!trimmed) return;
    setLayers((prev) => [
      ...prev,
      { kind: 'text', id: makeLayerId(), text: trimmed, x: 0.5, y: 0.5, scale: 1, rotation: 0, fontId: selectedFont },
    ]);
    setTextInput('');
    setTray(null);
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    setLayers((prev) => prev.filter((l) => l.id !== selectedId));
    setSelectedId(null);
  };

  // Layer drag — pointer events normalize touch/mouse on iOS.
  const onLayerPointerDown = (e: React.PointerEvent, layerId: string) => {
    e.stopPropagation();
    setSelectedId(layerId);
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const rect = previewRef.current?.getBoundingClientRect();
    if (!rect) return;
    const move = (ev: PointerEvent) => {
      const nx = (ev.clientX - rect.left) / rect.width;
      const ny = (ev.clientY - rect.top) / rect.height;
      setLayers((prev) => prev.map((l) =>
        l.id === layerId ? { ...l, x: Math.max(0, Math.min(1, nx)), y: Math.max(0, Math.min(1, ny)) } : l
      ));
    };
    const up = () => {
      target.removeEventListener('pointermove', move as any);
      target.removeEventListener('pointerup', up as any);
      target.removeEventListener('pointercancel', up as any);
    };
    target.addEventListener('pointermove', move as any);
    target.addEventListener('pointerup', up as any);
    target.addEventListener('pointercancel', up as any);
  };

  const adjustScale = (delta: number) => {
    if (!selectedId) return;
    setLayers((prev) => prev.map((l) =>
      l.id === selectedId ? { ...l, scale: Math.max(0.3, Math.min(3, l.scale + delta)) } : l
    ));
  };
  const adjustRotation = (delta: number) => {
    if (!selectedId) return;
    setLayers((prev) => prev.map((l) =>
      l.id === selectedId ? { ...l, rotation: (l.rotation + delta) % 360 } : l
    ));
  };
  // Absolute setters used by the slider controls. Clamped the same way
  // the +/− buttons would have been. Named setLayerScale/setLayerRotation
  // to avoid colliding with the editor's overall image-rotation state.
  const setLayerScale = (value: number) => {
    if (!selectedId) return;
    const clamped = Math.max(0.3, Math.min(3, value));
    setLayers((prev) => prev.map((l) =>
      l.id === selectedId ? { ...l, scale: clamped } : l
    ));
  };
  const setLayerRotation = (value: number) => {
    if (!selectedId) return;
    // Slider range -180..180; bake's ctx.rotate accepts any radian value.
    setLayers((prev) => prev.map((l) =>
      l.id === selectedId ? { ...l, rotation: value } : l
    ));
  };
  // Re-skin the currently selected text layer with a different font face.
  // No-op if the selection is a sticker or nothing is selected. Also nudges
  // the "default for next text layer" so the user's last font choice
  // persists when they create another.
  const setLayerFont = (fontId: FontId) => {
    if (!selectedId) return;
    setLayers((prev) => prev.map((l) =>
      l.id === selectedId && l.kind === 'text' ? { ...l, fontId } : l
    ));
    setSelectedFont(fontId);
  };

  const onConfirm = async () => {
    if (baking) return;
    setBaking(true);
    try {
      const baked = await bakePostImage({
        sourceFile: photoFile,
        crop,
        rotation,
        filter: filterId,
        filmstripOn,
        layers,
        stickers: HORROR_STICKERS,
      });
      onNext(baked);
    } catch (err) {
      showToast('Could not save edits — try again', 'error');
      setBaking(false);
    }
  };

  // ---- Crop sub-view ----
  // Renders the image inside a wrapper sized to its display area, with a
  // draggable rectangle overlay. State (`crop`) is normalized 0..1 of
  // source dimensions so it's resolution-independent.
  if (tray === 'crop') {
    return (
      <ExposureCropScreen
        sourceUrl={previewUrl}
        crop={crop}
        rotation={rotation}
        onChangeCrop={setCrop}
        onChangeRotation={(r) => setRotation(r)}
        onDone={() => setTray(null)}
        onCancel={() => setTray(null)}
      />
    );
  }

  // Filter sub-view stays inline (just a horizontal scroll strip + preview).

  // Compute live preview transform: apply filter via CSS filter, and
  // rotate via CSS transform. Crop is approximated visually by
  // object-position cropping. Since we use object-fit:contain in the
  // base view, we instead show a "crop preview" mask while in editor.
  const liveFilter = filterCssFor(filterId);
  const liveTransform = rotation ? `rotate(${rotation}deg)` : undefined;

  // The crop on live preview is shown via clip-path on the image so the
  // user sees roughly what will be exported. Crop is in normalized coords
  // (0..1) of source — clip-path inset uses % of the rendered image, which
  // matches our source-normalized coords since object-fit:contain preserves
  // aspect ratio. Crop applies BEFORE rotation in the bake, but for the
  // preview we approximate with clip-path on the un-rotated image to
  // avoid coordinate confusion.
  const cropClip =
    crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1
      ? undefined
      : `inset(${crop.y * 100}% ${(1 - crop.x - crop.w) * 100}% ${(1 - crop.y - crop.h) * 100}% ${crop.x * 100}%)`;

  return (
    <>
      <div style={S.igComposerHeader}>
        <button onClick={onBack} style={S.igComposerHeaderBtn} aria-label="Back" disabled={baking}>‹</button>
        <div style={S.igComposerHeaderTitle}>Edit</div>
        <button
          onClick={onConfirm}
          disabled={baking}
          style={{ ...S.igComposerHeaderNext, color: baking ? '#1B4F7A' : '#3B9DFF', cursor: baking ? 'default' : 'pointer' }}
        >
          {baking ? '...' : 'Next'}
        </button>
      </div>

      <div
        ref={previewRef}
        style={S.editorPreviewWrap}
        onPointerDown={() => setSelectedId(null)}
      >
        <img
          src={previewUrl}
          alt=""
          style={{
            ...S.editorPreviewImg,
            filter: liveFilter,
            transform: liveTransform,
            clipPath: cropClip,
          }}
        />

        {filmstripOn && (
          <>
            <div style={S.editorFilmstripBarTop}>
              {Array.from({ length: 14 }).map((_, i) => (
                <div key={i} style={S.editorFilmstripHole} />
              ))}
            </div>
            <div style={S.editorFilmstripBarBottom}>
              {Array.from({ length: 14 }).map((_, i) => (
                <div key={i} style={S.editorFilmstripHole} />
              ))}
            </div>
          </>
        )}

        {layers.map((layer) => {
          const isSel = layer.id === selectedId;
          const transform = `translate(-50%, -50%) rotate(${layer.rotation}deg) scale(${layer.scale})`;
          const wrapStyle: React.CSSProperties = {
            position: 'absolute',
            left: `${layer.x * 100}%`,
            top: `${layer.y * 100}%`,
            transform,
            transformOrigin: 'center',
            touchAction: 'none',
            cursor: 'grab',
            outline: isSel ? '2px dashed #3B9DFF' : 'none',
            outlineOffset: 4,
            padding: 4,
          };
          if (layer.kind === 'sticker') {
            const def = HORROR_STICKERS.find((s) => s.id === layer.stickerId);
            if (!def) return null;
            return (
              <div
                key={layer.id}
                style={wrapStyle}
                onPointerDown={(e) => onLayerPointerDown(e, layer.id)}
              >
                <img
                  src={def.url}
                  alt=""
                  crossOrigin="anonymous"
                  style={{ width: 80, height: 80, display: 'block', pointerEvents: 'none' }}
                  draggable={false}
                />
              </div>
            );
          }
          return (
            <div
              key={layer.id}
              style={{
                ...wrapStyle,
                fontFamily: fontFor(layer.fontId).cssStack,
                fontWeight: fontFor(layer.fontId).weight,
                fontSize: 36,
                color: '#FFFFFF',
                textShadow: '2px 2px 0 #DC2626, 0 0 6px rgba(220,38,38,0.6)',
                whiteSpace: 'nowrap',
                userSelect: 'none',
              }}
              onPointerDown={(e) => onLayerPointerDown(e, layer.id)}
            >
              {layer.text}
            </div>
          );
        })}
      </div>

      {/* Font picker for the selected TEXT layer. Hidden when nothing is
          selected OR when the selection is a sticker. Sits above the
          layer controls; tap any font cell to re-skin the layer live. */}
      {(() => {
        if (!selectedId) return null;
        const sel = layers.find((l) => l.id === selectedId);
        if (!sel || sel.kind !== 'text') return null;
        const currentFontId = sel.fontId;
        return (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 130,
              display: 'flex',
              gap: 8,
              padding: '0 12px',
              overflowX: 'auto',
              WebkitOverflowScrolling: 'touch',
              zIndex: 10,
            }}
          >
            {EDITOR_FONTS.map((f) => {
              const isSel = currentFontId === f.id;
              return (
                <button
                  key={f.id}
                  onClick={() => setLayerFont(f.id)}
                  style={{
                    flex: '0 0 auto',
                    minWidth: 56,
                    padding: '4px 10px',
                    background: isSel ? 'rgba(255,59,92,0.18)' : 'rgba(0,0,0,0.65)',
                    border: isSel ? '2px solid #FF3B5C' : '1px solid rgba(255,255,255,0.15)',
                    borderRadius: 8,
                    color: '#FFF',
                    fontFamily: f.cssStack,
                    fontWeight: f.weight,
                    fontSize: 18,
                    lineHeight: 1.1,
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    backdropFilter: 'blur(8px)',
                    WebkitBackdropFilter: 'blur(8px)',
                  }}
                  aria-label={`Set font to ${f.name}`}
                >
                  <span>Aa</span>
                  <span style={{ fontFamily: 'system-ui, -apple-system, sans-serif', fontSize: 8, fontWeight: 400, color: '#BBB', marginTop: 1 }}>
                    {f.name}
                  </span>
                </button>
              );
            })}
          </div>
        );
      })()}

      {selectedId && (() => {
        // Read the current selected layer once so the sliders reflect
        // its actual scale/rotation. If nothing's selected the block
        // doesn't render (outer && guard).
        const sel = layers.find((l) => l.id === selectedId);
        if (!sel) return null;
        // Stop propagation on touch events so dragging the slider
        // doesn't trigger the global swipe-back gesture.
        const stopBubble = (e: React.TouchEvent | React.PointerEvent) => e.stopPropagation();
        return (
          <div style={S.editorLayerControls}>
            <div style={S.editorSliderRow}>
              <span style={S.editorSliderIcon} aria-hidden="true">⤢</span>
              <input
                type="range"
                min={0.3}
                max={3}
                step={0.01}
                value={sel.scale}
                onChange={(e) => setLayerScale(parseFloat(e.target.value))}
                onTouchStart={stopBubble}
                onTouchMove={stopBubble}
                onTouchEnd={stopBubble}
                onPointerDown={stopBubble}
                style={S.editorSlider}
                aria-label="Size"
              />
            </div>
            <div style={S.editorSliderRow}>
              <span style={S.editorSliderIcon} aria-hidden="true">↻</span>
              <input
                type="range"
                min={-180}
                max={180}
                step={1}
                value={sel.rotation}
                onChange={(e) => setLayerRotation(parseFloat(e.target.value))}
                onTouchStart={stopBubble}
                onTouchMove={stopBubble}
                onTouchEnd={stopBubble}
                onPointerDown={stopBubble}
                style={S.editorSlider}
                aria-label="Rotation"
              />
            </div>
            <button style={S.editorLayerDeleteBtn} onClick={deleteSelected} aria-label="Delete">🗑</button>
          </div>
        );
      })()}

      {/* Filter strip — horizontal scroll of preset thumbs above toolbar */}
      {tray === 'filter' && (
        <div style={S.editorFilterStrip}>
          {FILTER_PRESETS.map((p) => (
            <button
              key={p.id}
              style={{
                ...S.editorFilterCell,
                outline: filterId === p.id ? '2px solid #FF3B5C' : '1px solid rgba(255,255,255,0.1)',
              }}
              onClick={() => setFilterId(p.id)}
              aria-label={p.name}
            >
              <img
                src={previewUrl}
                alt=""
                style={{ width: 56, height: 56, objectFit: 'cover', display: 'block', filter: p.css }}
                draggable={false}
              />
              <span style={S.editorFilterLabel}>{p.name}</span>
            </button>
          ))}
        </div>
      )}

      {/* Sticker tray */}
      {tray === 'stickers' && (
        <div style={S.editorTray}>
          <div style={S.editorTrayHeader}>
            <span style={S.editorTrayTitle}>Stickers</span>
            <button onClick={() => setTray(null)} style={S.editorTrayClose}>✕</button>
          </div>
          <div style={S.editorStickerGrid}>
            {HORROR_STICKERS.map((s) => (
              <button
                key={s.id}
                style={S.editorStickerCell}
                onClick={() => addSticker(s.id)}
                aria-label={s.name}
              >
                <img
                  src={s.url}
                  alt={s.name}
                  crossOrigin="anonymous"
                  style={{ width: 48, height: 48, display: 'block' }}
                  draggable={false}
                />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Text tray */}
      {tray === 'text' && (
        <div style={S.editorTray}>
          <div style={S.editorTrayHeader}>
            <span style={S.editorTrayTitle}>Add text</span>
            <button onClick={() => setTray(null)} style={S.editorTrayClose}>✕</button>
          </div>
          {/* Font picker — horizontal scroll of 6 fonts, each rendering "Aa"
              in its own face so the user previews exactly what they'll get. */}
          <div
            style={{
              display: 'flex',
              gap: 8,
              padding: '8px 12px 4px',
              overflowX: 'auto',
              WebkitOverflowScrolling: 'touch',
            }}
          >
            {EDITOR_FONTS.map((f) => {
              const isSel = selectedFont === f.id;
              return (
                <button
                  key={f.id}
                  onClick={() => setSelectedFont(f.id)}
                  style={{
                    flex: '0 0 auto',
                    minWidth: 64,
                    padding: '6px 12px',
                    background: isSel ? 'rgba(255,59,92,0.15)' : 'rgba(255,255,255,0.05)',
                    border: isSel ? '2px solid #FF3B5C' : '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 8,
                    color: '#FFF',
                    fontFamily: f.cssStack,
                    fontWeight: f.weight,
                    fontSize: 20,
                    lineHeight: 1.2,
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                  }}
                  aria-label={f.name}
                >
                  <span>Aa</span>
                  <span style={{ fontFamily: 'system-ui, -apple-system, sans-serif', fontSize: 9, fontWeight: 400, color: '#999', marginTop: 2 }}>
                    {f.name}
                  </span>
                </button>
              );
            })}
          </div>
          <div style={{ padding: 12, display: 'flex', gap: 8 }}>
            <input
              autoFocus
              value={textInput}
              onChange={(e) => setTextInput(e.target.value.slice(0, 40))}
              placeholder="Type text..."
              style={{ ...S.editorTextInput, fontFamily: fontFor(selectedFont).cssStack, fontWeight: fontFor(selectedFont).weight }}
              onKeyDown={(e) => { if (e.key === 'Enter') addText(); }}
            />
            <button onClick={addText} style={S.editorTextAddBtn} disabled={!textInput.trim()}>
              Add
            </button>
          </div>
        </div>
      )}

      {/* Bottom toolbar — 5 tools: Crop, Filter, Frame, Stickers, Text */}
      <div style={S.editorToolbar}>
        <button
          style={{ ...S.editorToolBtn, color: (crop.w < 1 || crop.h < 1 || rotation !== 0) ? '#FF3B5C' : '#FFF' }}
          onClick={() => setTray('crop')}
        >
          <span style={S.editorToolIcon}>⊡</span>
          <span style={S.editorToolLabel}>Crop</span>
        </button>
        <button
          style={{ ...S.editorToolBtn, color: tray === 'filter' ? '#FF3B5C' : (filterId !== 'none' ? '#FF8AA3' : '#FFF') }}
          onClick={() => setTray((t) => (t === 'filter' ? null : 'filter'))}
        >
          <span style={S.editorToolIcon}>◐</span>
          <span style={S.editorToolLabel}>Filter</span>
        </button>
        <button
          style={{ ...S.editorToolBtn, color: filmstripOn ? '#FF3B5C' : '#888' }}
          onClick={() => setFilmstripOn((v) => !v)}
        >
          <span style={S.editorToolIcon}>▤</span>
          <span style={S.editorToolLabel}>Frame</span>
        </button>
        <button
          style={{ ...S.editorToolBtn, color: tray === 'stickers' ? '#FF3B5C' : '#FFF' }}
          onClick={() => setTray((t) => (t === 'stickers' ? null : 'stickers'))}
        >
          <span style={S.editorToolIcon}>💀</span>
          <span style={S.editorToolLabel}>Stickers</span>
        </button>
        <button
          style={{ ...S.editorToolBtn, color: tray === 'text' ? '#FF3B5C' : '#FFF' }}
          onClick={() => setTray((t) => (t === 'text' ? null : 'text'))}
        >
          <span style={S.editorToolIcon}>Aa</span>
          <span style={S.editorToolLabel}>Text</span>
        </button>
      </div>
    </>
  );
}

// ---------- ExposureCropScreen ----------
// Standalone full-screen crop tool. Image rendered behind a darkened
// scrim with a transparent crop window over the center. Edges/corners
// are draggable, body is draggable for repositioning. 90° rotate button
// in the top toolbar. "Done" applies the crop and returns. "Cancel"
// reverts to whatever crop was already set.
//
// Crop is in normalized image coords (0..1). The screen tracks its own
// `working` state and commits on Done.
function ExposureCropScreen({ sourceUrl, crop, rotation, onChangeCrop, onChangeRotation, onDone, onCancel }: {
  sourceUrl: string;
  crop: CropRect;
  rotation: 0 | 90 | 180 | 270;
  onChangeCrop: (c: CropRect) => void;
  onChangeRotation: (r: 0 | 90 | 180 | 270) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [working, setWorking] = useState<CropRect>(crop);
  const [workingRotation, setWorkingRotation] = useState<0 | 90 | 180 | 270>(rotation);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // We measure the rendered image bounds (object-fit:contain) so drag math
  // works in image-space, not in the wrapper's letterbox-space.
  const [imgRect, setImgRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const measure = () => {
      const wrap = wrapRef.current;
      const img = imgRef.current;
      if (!wrap || !img || !img.complete) return;
      const wrapR = wrap.getBoundingClientRect();
      // object-fit:contain — image's display rect is centered in wrap
      const naturalRatio = img.naturalWidth / img.naturalHeight;
      const wrapRatio = wrapR.width / wrapR.height;
      let dispW: number, dispH: number;
      if (naturalRatio > wrapRatio) {
        dispW = wrapR.width;
        dispH = wrapR.width / naturalRatio;
      } else {
        dispH = wrapR.height;
        dispW = wrapR.height * naturalRatio;
      }
      const left = (wrapR.width - dispW) / 2;
      const top = (wrapR.height - dispH) / 2;
      setImgRect({ left, top, width: dispW, height: dispH });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [sourceUrl]);

  // Drag handlers for crop window. Mode = which part is being dragged.
  type DragMode = 'move' | 'tl' | 'tr' | 'bl' | 'br';
  const startDrag = (e: React.PointerEvent, mode: DragMode) => {
    e.stopPropagation();
    if (!imgRect) return;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const startCrop = { ...working };
    const startX = e.clientX;
    const startY = e.clientY;

    const move = (ev: PointerEvent) => {
      if (!imgRect) return;
      const dx = (ev.clientX - startX) / imgRect.width;
      const dy = (ev.clientY - startY) / imgRect.height;
      let { x, y, w, h } = startCrop;
      if (mode === 'move') {
        x = Math.max(0, Math.min(1 - w, x + dx));
        y = Math.max(0, Math.min(1 - h, y + dy));
      } else if (mode === 'tl') {
        const newX = Math.max(0, Math.min(x + w - 0.1, x + dx));
        const newY = Math.max(0, Math.min(y + h - 0.1, y + dy));
        w = w - (newX - x);
        h = h - (newY - y);
        x = newX;
        y = newY;
      } else if (mode === 'tr') {
        const newY = Math.max(0, Math.min(y + h - 0.1, y + dy));
        const newW = Math.max(0.1, Math.min(1 - x, w + dx));
        h = h - (newY - y);
        y = newY;
        w = newW;
      } else if (mode === 'bl') {
        const newX = Math.max(0, Math.min(x + w - 0.1, x + dx));
        w = w - (newX - x);
        x = newX;
        h = Math.max(0.1, Math.min(1 - y, h + dy));
      } else if (mode === 'br') {
        w = Math.max(0.1, Math.min(1 - x, w + dx));
        h = Math.max(0.1, Math.min(1 - y, h + dy));
      }
      setWorking({ x, y, w, h });
    };
    const up = () => {
      target.removeEventListener('pointermove', move as any);
      target.removeEventListener('pointerup', up as any);
      target.removeEventListener('pointercancel', up as any);
    };
    target.addEventListener('pointermove', move as any);
    target.addEventListener('pointerup', up as any);
    target.addEventListener('pointercancel', up as any);
  };

  const applyPreset = (ratio: number | 'free' | 'original') => {
    if (ratio === 'free') return; // free leaves the crop alone
    if (ratio === 'original') {
      setWorking(FULL_CROP);
      return;
    }
    // Set a centered crop matching the requested aspect ratio.
    // Aspect ratio = w/h. We need a rectangle inside [0,1]x[0,1] of
    // the SOURCE image (which has its own aspect). The crop is in
    // normalized source-image coords, so we have to factor that in.
    const img = imgRef.current;
    const srcAspect = img && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
    // We want display crop = ratio (w/h in display pixels)
    // Source-normalized crop w / h must satisfy:
    //   (w * srcW) / (h * srcH) = ratio
    //   w / h = ratio * (srcH / srcW) = ratio / srcAspect
    const normRatio = ratio / srcAspect;
    let cw: number, ch: number;
    if (normRatio >= 1) {
      cw = 1;
      ch = 1 / normRatio;
    } else {
      ch = 1;
      cw = normRatio;
    }
    const cx = (1 - cw) / 2;
    const cy = (1 - ch) / 2;
    setWorking({ x: cx, y: cy, w: cw, h: ch });
  };

  const rotate90 = () => {
    const next: 0 | 90 | 180 | 270 = (((workingRotation + 90) % 360) as 0 | 90 | 180 | 270);
    setWorkingRotation(next);
  };

  const onDoneClick = () => {
    onChangeCrop(working);
    onChangeRotation(workingRotation);
    onDone();
  };

  // Compute crop overlay pixel rect from working state + imgRect
  const overlayRect = imgRect ? {
    left: imgRect.left + working.x * imgRect.width,
    top: imgRect.top + working.y * imgRect.height,
    width: working.w * imgRect.width,
    height: working.h * imgRect.height,
  } : null;

  return (
    <>
      <div style={S.igComposerHeader}>
        <button onClick={onCancel} style={S.igComposerHeaderBtn} aria-label="Cancel">Cancel</button>
        <div style={S.igComposerHeaderTitle}>Crop</div>
        <button onClick={onDoneClick} style={{ ...S.igComposerHeaderNext, color: '#3B9DFF', cursor: 'pointer' }}>Done</button>
      </div>

      <div ref={wrapRef} style={S.editorCropWrap}>
        <img
          ref={imgRef}
          src={sourceUrl}
          alt=""
          onLoad={() => {
            // re-measure once loaded
            const w = wrapRef.current?.getBoundingClientRect();
            const img = imgRef.current;
            if (!w || !img) return;
            const naturalRatio = img.naturalWidth / img.naturalHeight;
            const wrapRatio = w.width / w.height;
            let dispW: number, dispH: number;
            if (naturalRatio > wrapRatio) {
              dispW = w.width;
              dispH = w.width / naturalRatio;
            } else {
              dispH = w.height;
              dispW = w.height * naturalRatio;
            }
            setImgRect({ left: (w.width - dispW) / 2, top: (w.height - dispH) / 2, width: dispW, height: dispH });
          }}
          style={{
            ...S.editorCropImg,
            transform: workingRotation ? `rotate(${workingRotation}deg)` : undefined,
          }}
          draggable={false}
        />

        {/* Dark scrim everywhere except inside crop */}
        {overlayRect && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              background: `linear-gradient(rgba(0,0,0,0.55),rgba(0,0,0,0.55))`,
              WebkitMaskImage: `linear-gradient(#000, #000), linear-gradient(#000, #000)`,
              WebkitMaskComposite: 'xor' as any,
              maskComposite: 'exclude' as any,
              clipPath: `polygon(
                0% 0%, 0% 100%, ${overlayRect.left}px 100%, ${overlayRect.left}px ${overlayRect.top}px,
                ${overlayRect.left + overlayRect.width}px ${overlayRect.top}px,
                ${overlayRect.left + overlayRect.width}px ${overlayRect.top + overlayRect.height}px,
                ${overlayRect.left}px ${overlayRect.top + overlayRect.height}px,
                ${overlayRect.left}px 100%, 100% 100%, 100% 0%
              )`,
            }}
          />
        )}

        {/* Crop window */}
        {overlayRect && (
          <div
            style={{
              position: 'absolute',
              left: overlayRect.left,
              top: overlayRect.top,
              width: overlayRect.width,
              height: overlayRect.height,
              border: '1px solid rgba(255,255,255,0.9)',
              boxShadow: '0 0 0 1px rgba(0,0,0,0.4)',
              cursor: 'move',
              touchAction: 'none',
            }}
            onPointerDown={(e) => startDrag(e, 'move')}
          >
            {/* Rule-of-thirds gridlines */}
            <div style={{ position: 'absolute', left: 0, right: 0, top: '33.33%', height: 1, background: 'rgba(255,255,255,0.3)', pointerEvents: 'none' }} />
            <div style={{ position: 'absolute', left: 0, right: 0, top: '66.66%', height: 1, background: 'rgba(255,255,255,0.3)', pointerEvents: 'none' }} />
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: '33.33%', width: 1, background: 'rgba(255,255,255,0.3)', pointerEvents: 'none' }} />
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: '66.66%', width: 1, background: 'rgba(255,255,255,0.3)', pointerEvents: 'none' }} />
            {/* Corner handles */}
            {(['tl','tr','bl','br'] as const).map((c) => (
              <div
                key={c}
                style={{
                  position: 'absolute',
                  width: 28,
                  height: 28,
                  ...(c === 'tl' ? { left: -14, top: -14, cursor: 'nwse-resize' } : {}),
                  ...(c === 'tr' ? { right: -14, top: -14, cursor: 'nesw-resize' } : {}),
                  ...(c === 'bl' ? { left: -14, bottom: -14, cursor: 'nesw-resize' } : {}),
                  ...(c === 'br' ? { right: -14, bottom: -14, cursor: 'nwse-resize' } : {}),
                  touchAction: 'none',
                }}
                onPointerDown={(e) => startDrag(e, c)}
              >
                <div style={{
                  position: 'absolute',
                  inset: 8,
                  background: '#FFFFFF',
                  borderRadius: 2,
                  boxShadow: '0 0 0 2px rgba(0,0,0,0.4)',
                  pointerEvents: 'none',
                }} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Aspect ratio + rotate row */}
      <div style={S.editorCropRow}>
        <button style={S.editorCropChip} onClick={() => applyPreset('free')}>Free</button>
        <button style={S.editorCropChip} onClick={() => applyPreset('original')}>Original</button>
        <button style={S.editorCropChip} onClick={() => applyPreset(1)}>1:1</button>
        <button style={S.editorCropChip} onClick={() => applyPreset(4/5)}>4:5</button>
        <button style={S.editorCropChip} onClick={() => applyPreset(16/9)}>16:9</button>
        <button style={S.editorCropChip} onClick={() => applyPreset(9/16)}>9:16</button>
        <button style={S.editorCropChip} onClick={rotate90} aria-label="Rotate 90 degrees">⟳</button>
      </div>
    </>
  );
}

// Search sub-screen inside eXposure. Text input filters loaded posts by
// caption / handle. Below the input, a horizontal chip strip lets users
// filter by category. AND'd — both filters apply. Empty results show a
// friendly empty state.
// Instagram-style post composer. Full-screen overlay (not a small card),
// two-stage flow matching IG's New Post:
//   Stage 1 — "New post" + photo picker. ✕ left, "New post" centered,
//             "Next" disabled until a photo is selected. Big tappable
//             area in the middle that opens iOS's native picker.
//   Stage 2 — Caption screen. ← back, "New post" centered. Smaller
//             photo preview at top, "Add a caption..." field, big blue
//             "Share" button at the bottom.
function ExposurePostSheet({ handle, deviceId, onClose, onPosted }: {
  handle: string | null;
  deviceId: string | null;
  onClose: () => void;
  onPosted: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  // v1.12 multi-photo support. The first picked photo (photoFile) is
  // the "primary" — it goes through the editor (filter/frame/stickers/
  // text). Additional photos are extras that ride along untouched. IG
  // works this way: photo 1 is the cover, the rest are uploaded raw.
  // Server stores them as a carousel.
  const [extraPhotos, setExtraPhotos] = useState<File[]>([]);
  const [extraPreviews, setExtraPreviews] = useState<string[]>([]);
  // v1.13: when the user picks a video instead of a photo, this flag
  // routes the flow around the editor (which only handles images).
  // Set by onPhotoChange when a video/* file lands.
  const [isVideoPick, setIsVideoPick] = useState(false);
  const [caption, setCaption] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Three-stage flow: pick photo → edit (filmstrip/stickers/text) →
  // caption. The 'edit' stage stores the baked, flattened JPEG so
  // the original picked file is never sent — only the user's edited
  // output goes to the server. Back from 'caption' returns to 'edit'
  // (preserving the bake), back from 'edit' returns to 'pick'.
  type Stage = 'pick' | 'edit' | 'caption';
  const [stage, setStage] = useState<Stage>('pick');
  // The file we'll actually upload — the baked version from the editor.
  // Falls back to the picked file if the editor is somehow skipped.
  const [editedFile, setEditedFile] = useState<File | null>(null);
  // Preview URL for the *edited* image — used on the caption screen so
  // the user sees what they're about to share, not the unedited original.
  const [editedPreview, setEditedPreview] = useState<string | null>(null);

  const captionTrim = caption.trim();
  // Server enforces 1-280 char caption.
  const canShare = !!editedFile && captionTrim.length >= 1 && captionTrim.length <= 280 && !submitting && !!handle && !!deviceId;

  // Accept up to 10 photos OR one video in a single pick. v1.13 added
  // video support. Rules:
  //   - All photos = carousel post (1-10 slots)
  //   - One video = single-slot video post (no carousel)
  //   - Mixed photos+video in one pick = rejected (we don't render
  //     mixed carousels)
  //   - Multiple videos in one pick = first one wins, rest dropped
  // The first photo (if any) becomes the editable primary that goes
  // through the editor. Extras ride along raw.
  const MAX_PHOTOS = 10;
  const MAX_VIDEO_BYTES = 40 * 1024 * 1024;     // 40 MB hard cap, mirrors server
  const onPhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fl = e.target.files;
    if (!fl || fl.length === 0) return;
    const arr = Array.from(fl);

    // CHECK SIZE FIRST — before any other validation. The most common
    // failure mode is "I took a video and it was too big" and we want
    // the toast to tell the user exactly what happened. Done up-front
    // because the OS picker can hand us a video that's also reported
    // alongside a thumbnail (some iOS versions do this), and the
    // "mixed photo+video" check below would steal the error otherwise.
    const tooBigVideo = arr.find((f) => f.type.startsWith('video/') && f.size > MAX_VIDEO_BYTES);
    if (tooBigVideo) {
      const actualMb = Math.round(tooBigVideo.size / 1024 / 1024);
      const limitMb = Math.round(MAX_VIDEO_BYTES / 1024 / 1024);
      showToast(`Video too large: ${actualMb}MB (max ${limitMb}MB). Trim it first in Photos.`, 'error');
      // Reset the input so picking the same file again still re-triggers
      // onChange. Without this iOS won't re-fire onChange for an
      // identical pick.
      if (fileRef.current) fileRef.current.value = '';
      return;
    }

    const photos = arr.filter((f) => f.type.startsWith('image/'));
    const videos = arr.filter((f) => f.type.startsWith('video/'));

    if (photos.length > 0 && videos.length > 0) {
      showToast('Pick photos OR a video, not both', 'error');
      return;
    }
    if (videos.length > 0) {
      const v = videos[0];
      // Size already checked above; this branch is the happy path.
      // Video post path: skip the editor entirely. Store the video as
      // "photoFile" for the upload step (server routes by mimetype).
      // No extras for video posts (v1).
      setPhotoFile(v);
      setPhotoPreview(URL.createObjectURL(v));
      extraPreviews.forEach((u) => URL.revokeObjectURL(u));
      setExtraPhotos([]);
      setExtraPreviews([]);
      setIsVideoPick(true);
      return;
    }

    // Photo post path — up to 10 photos.
    const trimmed = photos.slice(0, MAX_PHOTOS);
    setPhotoFile(trimmed[0]);
    setPhotoPreview(URL.createObjectURL(trimmed[0]));
    extraPreviews.forEach((u) => URL.revokeObjectURL(u));
    const extras = trimmed.slice(1);
    setExtraPhotos(extras);
    setExtraPreviews(extras.map((f) => URL.createObjectURL(f)));
    setIsVideoPick(false);
  };

  const openPicker = () => {
    if (submitting) return;
    fileRef.current?.click();
  };

  const onNext = () => {
    if (!photoFile) return;
    if (isVideoPick) {
      // Video posts skip the editor entirely — there's nothing to edit
      // (no filters/stickers/text on video in v1). The picked video file
      // IS the file we upload, so we set it as editedFile directly and
      // jump to the caption stage.
      if (editedPreview) URL.revokeObjectURL(editedPreview);
      setEditedFile(photoFile);
      setEditedPreview(URL.createObjectURL(photoFile));
      setStage('caption');
      return;
    }
    setStage('edit');
  };

  const onEditorBack = () => {
    if (submitting) return;
    setStage('pick');
  };

  // Editor calls this with the baked JPEG. Save it, build a preview URL,
  // and advance to caption.
  const onEditorNext = (baked: File) => {
    if (editedPreview) URL.revokeObjectURL(editedPreview);
    setEditedFile(baked);
    setEditedPreview(URL.createObjectURL(baked));
    setStage('caption');
  };

  const onBackFromCaption = () => {
    if (submitting) return;
    setStage('edit');
  };

  const onShare = async () => {
    if (!canShare || !editedFile || !handle || !deviceId) return;
    setSubmitting(true);
    const result = await apiCreatePost({
      photo: editedFile,
      extras: extraPhotos,    // v1.12: carousel extras (raw, unedited)
      handle,
      deviceId,
      caption: captionTrim,
      freeform: true,
    });
    setSubmitting(false);
    if (result.ok) {
      playPostShared();
      onPosted();
    } else {
      showToast(`Post failed: ${result.reason || 'unknown error'}`, 'error');
    }
  };

  // No handle? Show a minimal error screen with the same header chrome.
  if (!handle || !deviceId) {
    return createPortal(
      <div style={S.igComposerScreen}>
        <div style={S.igComposerHeader}>
          <button onClick={onClose} style={S.igComposerHeaderBtn} aria-label="Close">✕</button>
          <div style={S.igComposerHeaderTitle}>New post</div>
          <div style={{ width: 40 }} />
        </div>
        <div style={{ padding: '40px 24px', textAlign: 'center', color: '#BBB', fontSize: 15, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
          Claim a handle to post.<br />
          <span style={{ fontSize: 13, opacity: 0.7, marginTop: 8, display: 'block' }}>
            Open Submit a Location to claim one.
          </span>
        </div>
      </div>,
      document.body
    );
  }

  return createPortal(
    <div style={S.igComposerScreen}>
      {/* Hidden file input — multi-select enabled in v1.12 for IG-style
          carousel posts. The user picks 1 to 10 photos at once; photo 1
          becomes the editable "primary" and the rest ride along as raw
          carousel extras. accept="image/*" plus no capture attribute
          lets iOS show the full picker (Photo Library / Take Photo /
          Choose File). */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*"
        multiple
        style={{ display: 'none' }}
        onChange={onPhotoChange}
      />

      {stage === 'pick' && (
        <>
          {/* Top bar — ✕ | New post | Next (Next only active when a
              photo is selected). */}
          <div style={S.igComposerHeader}>
            <button onClick={onClose} style={S.igComposerHeaderBtn} aria-label="Close">✕</button>
            <div style={S.igComposerHeaderTitle}>New post</div>
            <button
              onClick={onNext}
              disabled={!photoFile}
              style={{
                ...S.igComposerHeaderNext,
                color: photoFile ? '#3B9DFF' : '#1B4F7A',
                cursor: photoFile ? 'pointer' : 'default',
              }}
            >
              Next
            </button>
          </div>

          {/* Big preview area — either tap-to-pick prompt or the selected
              photo. Edge-to-edge, square aspect ratio like IG. v1.12:
              when the user picks multiple photos, a thumbnail strip of
              the extras shows below the primary so they can see what's
              going into the carousel. */}
          {photoPreview ? (
            <div style={S.igPickPreviewWrap}>
              {isVideoPick ? (
                <video
                  src={photoPreview}
                  style={S.igPickPreviewImg}
                  muted
                  autoPlay
                  playsInline
                  loop
                />
              ) : (
                <img src={photoPreview} alt="" style={S.igPickPreviewImg} />
              )}
              <button
                type="button"
                onClick={openPicker}
                style={S.igPickChangeBtn}
              >
                {isVideoPick
                  ? 'Video selected · Change'
                  : (extraPhotos.length > 0 ? `${extraPhotos.length + 1} photos · Change` : 'Change photo')}
              </button>
              {extraPhotos.length > 0 && (
                <div style={{
                  display: 'flex',
                  gap: 6,
                  padding: '10px 12px',
                  overflowX: 'auto',
                  WebkitOverflowScrolling: 'touch' as any,
                }}>
                  {/* Primary thumbnail with a "1" badge */}
                  <div style={{ position: 'relative', flexShrink: 0 }}>
                    <img
                      src={photoPreview}
                      alt=""
                      style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: 6, border: '2px solid #FF3B5C' }}
                    />
                  </div>
                  {extraPreviews.map((url, i) => (
                    <div key={i} style={{ position: 'relative', flexShrink: 0 }}>
                      <img
                        src={url}
                        alt=""
                        style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)' }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={openPicker}
              style={S.igPickPrompt}
            >
              {/* Subtle camera glyph + prompt. IG's empty state is more
                  elaborate (gallery grid) but this captures the same
                  intent without needing the photo library plugin. */}
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#666" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
              <div style={S.igPickPromptLabel}>Tap to choose a photo or video</div>
              <div style={S.igPickPromptHint}>From your camera or library</div>
              {/* Limits notice — keeps users from wondering why a huge
                  video silently fails to upload. Only the 40MB file
                  size is actually enforced (server + client); duration
                  is not capped, so don't mention it. */}
              <div style={S.igPickPromptHintSmall}>
                Videos: max 40MB
              </div>
            </button>
          )}
        </>
      )}

      {stage === 'edit' && photoFile && (
        <ExposurePostEditor
          photoFile={photoFile}
          onBack={onEditorBack}
          onNext={onEditorNext}
        />
      )}

      {stage === 'caption' && (
        <>
          {/* Top bar — ← | New post | (no right button) */}
          <div style={S.igComposerHeader}>
            <button onClick={onBackFromCaption} style={S.igComposerHeaderBtn} aria-label="Back">‹</button>
            <div style={S.igComposerHeaderTitle}>New post</div>
            <div style={{ width: 40 }} />
          </div>

          {/* Smaller centered preview + caption field below. For video
              posts the preview is a muted, looping <video> so the user
              sees what they're about to share. */}
          <div style={S.igCaptionBody}>
            <div style={S.igCaptionPreviewRow}>
              {editedPreview && (
                isVideoPick ? (
                  <video
                    src={editedPreview}
                    style={S.igCaptionPreviewImg}
                    muted
                    autoPlay
                    playsInline
                    loop
                  />
                ) : (
                  <img src={editedPreview} alt="" style={S.igCaptionPreviewImg} />
                )
              )}
              <textarea
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="Write a caption..."
                maxLength={280}
                style={S.igCaptionField}
                disabled={submitting}
              />
            </div>
            <div style={S.igCaptionCounter}>
              {captionTrim.length} / 280
            </div>
          </div>

          {/* Big blue Share button at the bottom, IG-style */}
          <div style={S.igShareWrap}>
            <button
              type="button"
              onClick={onShare}
              disabled={!canShare}
              style={{
                ...S.igShareBtn,
                opacity: canShare ? 1 : 0.5,
                cursor: canShare ? 'pointer' : 'default',
              }}
            >
              {submitting ? 'Sharing...' : 'Share'}
            </button>
          </div>
        </>
      )}
    </div>,
    document.body
  );
}

// Search sub-screen inside eXposure. Text input filters loaded posts by
// caption / handle. The sticky search bar lives just above the black
// bottom bar; results scroll above it.
function ExposureSearchView({ allPosts, currentHandle, deviceId, sites, onSelectSite, onSelectHandle, onSelectHashtag }: {
  allPosts: SocialPost[];
  currentHandle: string | null;
  deviceId: string | null;
  sites: SinisterSite[];
  onSelectSite: (site: SinisterSite) => void;
  onSelectHandle: (handle: string) => void;
  onSelectHashtag: (tag: string) => void;
}) {
  const [query, setQuery] = useState('');

  const siteById = useMemo(() => {
    const m = new Map<string, SinisterSite>();
    for (const s of sites) m.set(s.id, s);
    return m;
  }, [sites]);

  const q = query.trim().toLowerCase();
  const filtered = allPosts.filter((p) => {
    if (!q) return true;
    // Match against handle, caption, or site title.
    return (
      p.handle.toLowerCase().includes(q) ||
      p.caption.toLowerCase().includes(q) ||
      (p.siteTitle || '').toLowerCase().includes(q)
    );
  });

  return (
    <div style={{ paddingBottom: 120 }}>
      {/* Results — render newest-first as user types. Live above the
          sticky search input. paddingBottom on the parent div leaves
          space for the input + black bar (~120px) so the last result
          isn't hidden. */}
      {filtered.length === 0 ? (
        <div style={S.socialEmpty}>
          {q ? 'No matches.' : 'Start typing to search.'}<br />
          <span style={{ opacity: 0.6, fontSize: 12 }}>
            Try a handle, a caption keyword, or a site name.
          </span>
        </div>
      ) : (
        <div style={S.socialFeed}>
          {filtered.map((p) => (
            <SocialPostCard
              key={p.id}
              post={p}
              currentHandle={currentHandle}
              deviceId={deviceId}
              onSiteTap={() => {
                const s = siteById.get(p.siteId);
                if (s) onSelectSite(s);
              }}
              onHandleTap={() => onSelectHandle(p.handle)}
              onHashtagTap={(tag) => onSelectHashtag(tag)}
            />
          ))}
        </div>
      )}

      {/* Sticky search bar — fixed just above the black bottom bar.
          Rendered via portal to document.body so the drag wrapper's
          transform doesn't break position:fixed. */}
      {createPortal(
        <div style={S.searchStickyBar}>
          <div style={{ padding: '8px 12px' }}>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search posts, handles, sites…"
              style={S.searchInput}
            />
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// ---------- PhotoLightbox ----------
// Full-screen image viewer for tapping into a feed post photo. Renders
// the photo at its native aspect ratio, fit to screen, on a black
// backdrop. Supports:
//   - Pinch-to-zoom (1x to 4x)
//   - Pan when zoomed in
//   - Double-tap to zoom in (2x) / back to fit (1x)
//   - Swipe down to dismiss (when at 1x, not zoomed)
//   - Tap close button (X) to dismiss
//
// Implementation notes:
//   - Single-pointer touch = drag (pan if zoomed, swipe-down dismiss if not)
//   - Two-pointer touch = pinch (scale + translate around pinch center)
//   - We use raw touch events for pinch because PointerEvents don't give
//     us reliable simultaneous pinch tracking on iOS WebKit. Touch events
//     are the established cross-iOS way to handle multi-touch gestures.
//   - When zoomed out (scale=1), pan is locked and vertical drag triggers
//     dismiss. When zoomed in, pan is enabled and swipe-down is disabled
//     (otherwise the user can't pan up).
//   - Background opacity tracks dismiss-drag progress for a nice fade-out
//     feel — drag down 100px → backdrop at 70%, drag 250px → dismissed.
function PhotoLightbox({ imageUrl, onClose }: {
  imageUrl: string;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [dismissDrag, setDismissDrag] = useState(0); // y-offset while swiping to dismiss
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Refs hold gesture state between events without re-rendering.
  const gestureRef = useRef<{
    mode: 'idle' | 'pan' | 'pinch' | 'dismiss';
    startX: number;
    startY: number;
    startTx: number;
    startTy: number;
    startDist: number;
    startScale: number;
    pinchCx: number;        // pinch center at gesture start (image-space)
    pinchCy: number;
    lastTapTime: number;
  }>({
    mode: 'idle',
    startX: 0, startY: 0,
    startTx: 0, startTy: 0,
    startDist: 0, startScale: 1,
    pinchCx: 0, pinchCy: 0,
    lastTapTime: 0,
  });

  // Lock body scroll while open. Restore on unmount.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Esc to close (desktop nicety).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Helper — distance between two touches.
  const touchDist = (a: Touch, b: Touch) =>
    Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

  // Clamp pan so the image can't be dragged off-screen entirely. Bound
  // is roughly (scale-1) * half-of-container-dimension on each axis.
  const clampPan = (nextTx: number, nextTy: number, atScale: number) => {
    const c = containerRef.current;
    if (!c) return { tx: nextTx, ty: nextTy };
    const w = c.clientWidth;
    const h = c.clientHeight;
    const maxX = Math.max(0, (atScale - 1) * w / 2);
    const maxY = Math.max(0, (atScale - 1) * h / 2);
    return {
      tx: Math.max(-maxX, Math.min(maxX, nextTx)),
      ty: Math.max(-maxY, Math.min(maxY, nextTy)),
    };
  };

  const onTouchStart = (e: React.TouchEvent) => {
    const g = gestureRef.current;
    if (e.touches.length === 2) {
      // Pinch start
      const [t1, t2] = [e.touches[0], e.touches[1]];
      g.mode = 'pinch';
      g.startDist = touchDist(t1, t2);
      g.startScale = scale;
      g.startTx = tx;
      g.startTy = ty;
      g.pinchCx = (t1.clientX + t2.clientX) / 2;
      g.pinchCy = (t1.clientY + t2.clientY) / 2;
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      // Double-tap detection — two single-taps within 300ms.
      const now = Date.now();
      if (now - g.lastTapTime < 300) {
        // Toggle zoom 1x <-> 2x at tap point.
        if (scale > 1) {
          setScale(1); setTx(0); setTy(0);
        } else {
          const c = containerRef.current;
          if (c) {
            const r = c.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const newScale = 2;
            // Translate so the tapped point stays under the finger.
            const newTx = (cx - t.clientX) * (newScale - 1);
            const newTy = (cy - t.clientY) * (newScale - 1);
            const clamped = clampPan(newTx, newTy, newScale);
            setScale(newScale);
            setTx(clamped.tx);
            setTy(clamped.ty);
          }
        }
        g.lastTapTime = 0;
        g.mode = 'idle';
        return;
      }
      g.lastTapTime = now;
      g.startX = t.clientX;
      g.startY = t.clientY;
      g.startTx = tx;
      g.startTy = ty;
      // If zoomed in, single-pointer = pan. If at 1x, single-pointer =
      // candidate for swipe-down-dismiss; we wait for movement to decide.
      g.mode = scale > 1 ? 'pan' : 'dismiss';
    }
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const g = gestureRef.current;
    if (g.mode === 'pinch' && e.touches.length === 2) {
      const [t1, t2] = [e.touches[0], e.touches[1]];
      const dist = touchDist(t1, t2);
      const rawScale = g.startScale * (dist / g.startDist);
      const newScale = Math.max(1, Math.min(4, rawScale));
      // Keep the pinch center stable under the fingers.
      const cx = (t1.clientX + t2.clientX) / 2;
      const cy = (t1.clientY + t2.clientY) / 2;
      const dx = cx - g.pinchCx;
      const dy = cy - g.pinchCy;
      const clamped = clampPan(g.startTx + dx, g.startTy + dy, newScale);
      setScale(newScale);
      setTx(clamped.tx);
      setTy(clamped.ty);
    } else if (g.mode === 'pan' && e.touches.length === 1) {
      const t = e.touches[0];
      const dx = t.clientX - g.startX;
      const dy = t.clientY - g.startY;
      const clamped = clampPan(g.startTx + dx, g.startTy + dy, scale);
      setTx(clamped.tx);
      setTy(clamped.ty);
    } else if (g.mode === 'dismiss' && e.touches.length === 1) {
      const t = e.touches[0];
      const dy = t.clientY - g.startY;
      const dx = t.clientX - g.startX;
      // Only count downward drag as dismiss; horizontal swipes do nothing.
      // Allow some upward drag too so accidental tiny upward drift doesn't
      // feel sticky. Anything > 12px down enters the dismiss visual state.
      if (dy > 0 && Math.abs(dx) < dy * 1.5) {
        setDismissDrag(dy);
      } else {
        setDismissDrag(0);
      }
    }
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    const g = gestureRef.current;
    if (g.mode === 'dismiss') {
      // Commit dismiss if dragged > 120px, otherwise snap back.
      if (dismissDrag > 120) {
        onClose();
      } else {
        setDismissDrag(0);
      }
    }
    if (e.touches.length === 0) {
      g.mode = 'idle';
    } else if (e.touches.length === 1 && g.mode === 'pinch') {
      // Lifted one finger out of a pinch — convert to pan if zoomed,
      // else idle. Reset pan anchor to the remaining finger.
      const t = e.touches[0];
      g.startX = t.clientX;
      g.startY = t.clientY;
      g.startTx = tx;
      g.startTy = ty;
      g.mode = scale > 1 ? 'pan' : 'idle';
    }
  };

  // Backdrop opacity fades with dismiss drag. 1 at rest, 0 fully dragged.
  const backdropAlpha = Math.max(0.4, 1 - dismissDrag / 300);

  return createPortal(
    <div
      ref={containerRef}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onClick={(e) => {
        // Plain click on backdrop (not on image) = dismiss. We check
        // target to avoid dismissing when tapping the image itself,
        // which is the normal way users interact with the viewer.
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: `rgba(0,0,0,${backdropAlpha})`,
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        touchAction: 'none',
        userSelect: 'none',
      }}
    >
      {/* Close (X) button. Always available regardless of zoom state. */}
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        aria-label="Close"
        style={{
          position: 'absolute',
          top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
          right: 12,
          width: 40,
          height: 40,
          borderRadius: 20,
          backgroundColor: 'rgba(0,0,0,0.5)',
          border: '1px solid rgba(255,255,255,0.2)',
          color: '#fff',
          fontSize: 20,
          fontWeight: 700,
          cursor: 'pointer',
          zIndex: 2,
          backdropFilter: 'blur(6px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        ✕
      </button>

      <img
        src={imageUrl}
        alt=""
        draggable={false}
        style={{
          maxWidth: '100%',
          maxHeight: '100%',
          objectFit: 'contain',
          display: 'block',
          transform: `translate(${tx}px, ${ty + dismissDrag}px) scale(${scale})`,
          transition: gestureRef.current.mode === 'idle' ? 'transform 0.2s ease-out' : 'none',
          transformOrigin: 'center center',
          pointerEvents: 'none',
        }}
      />
    </div>,
    document.body
  );
}

// Single post card inside the feed. Owns its own like state so toggling
// is fast and doesn't trigger a parent re-render of the whole list.
function SocialPostCard({ post, currentHandle, deviceId, onSiteTap, onHandleTap, onHashtagTap, onPostRemoved }: {
  post: SocialPost;
  currentHandle: string | null;
  deviceId: string | null;
  onSiteTap: () => void;
  onHandleTap: () => void;
  // v1.14: called when the user taps a hashtag in the caption. Parent
  // should navigate to the hashtag view. Optional — if omitted, hashtag
  // taps are a no-op (still visually distinct, just don't navigate).
  onHashtagTap?: (tag: string) => void;
  // Optional. Called when the user hides or deletes this post — parent
  // should remove it from its post list so it doesn't re-render. If
  // omitted, the card hides itself locally.
  onPostRemoved?: (postId: string) => void;
}) {
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(post.likeCount || 0);
  const [likeBusy, setLikeBusy] = useState(false);
  // Local copy of the comment count so we can optimistically bump it
  // when the user posts a new comment from the sheet without round-
  // tripping back to the feed endpoint. Server is still the source of
  // truth — we sync on sheet open via apiFetchComments.length.
  const [commentCount, setCommentCount] = useState(post.commentCount || 0);
  // Whether the IG-style comment sheet is open over this post.
  const [commentsOpen, setCommentsOpen] = useState(false);
  // 3-dot menu state — action sheet open, report modal open.
  const [menuOpen, setMenuOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  // Delete confirmation modal (own posts only).
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  // Local-hide fallback when no onPostRemoved callback is wired.
  const [localHidden, setLocalHidden] = useState(false);
  // Lightbox state — tapping the photo opens a full-screen viewer with
  // pinch-zoom, pan, and swipe-down dismiss. See PhotoLightbox above.
  const [lightboxOpen, setLightboxOpen] = useState(false);
  // For multi-photo carousel posts: which slide (0-indexed) is centered.
  // Drives the page-dots indicator and the "1/N" badge in the corner.
  const [carouselIndex, setCarouselIndex] = useState(0);
  // Repost state — server-backed. Optimistic toggle on tap, rollback
  // on failure. Status is fetched on mount so reloads show the correct
  // filled/empty icon for the current user.
  const [reposted, setReposted] = useState(false);
  const [repostCount, setRepostCount] = useState(post.repostCount || 0);
  const [repostBusy, setRepostBusy] = useState(false);

  // Load this user's current repost status when the card mounts. We
  // don't block render on it — the icon starts empty and fills in if
  // the server says we've reposted.
  useEffect(() => {
    if (!currentHandle) return;
    let cancelled = false;
    apiRepostStatus({ postId: post.id, handle: currentHandle }).then((s) => {
      if (cancelled) return;
      setReposted(s.reposted);
      if (typeof s.count === 'number') setRepostCount(s.count);
    });
    return () => { cancelled = true; };
  }, [post.id, currentHandle]);

  // Follow state — only relevant for other people's posts. Inline
  // button matches IG: "Follow" → "Following" after tap. Server is the
  // source of truth, loaded once per mount.
  const [isFollowing, setIsFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);

  const isOwn = !!currentHandle && currentHandle.toLowerCase() === (post.handle || '').toLowerCase();

  // Fetch authoritative like state on mount. Server is the source of
  // truth — the post.likeCount cached on the feed is just a starting
  // point that may be slightly stale.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const status = await apiLikeStatus({ postId: post.id, handle: currentHandle });
      if (cancelled) return;
      setLiked(status.liked);
      setLikeCount(status.count);
    })();
    return () => { cancelled = true; };
  }, [post.id, currentHandle]);

  // Fetch follow status for the post author so we can render "Follow"
  // vs "Following" inline. Skipped on own posts (no follow button there).
  useEffect(() => {
    if (isOwn || !currentHandle) return;
    let cancelled = false;
    (async () => {
      const status = await apiFollowStatus({ target: post.handle, handle: currentHandle });
      if (cancelled) return;
      setIsFollowing(status.followedByYou);
    })();
    return () => { cancelled = true; };
  }, [post.handle, currentHandle, isOwn]);

  const onToggleFollow = async () => {
    if (followBusy) return;
    if (!currentHandle || !deviceId) {
      showToast('Sign in to follow', 'error');
      return;
    }
    setFollowBusy(true);
    // Optimistic flip.
    const wasFollowing = isFollowing;
    setIsFollowing(!wasFollowing);
    const r = wasFollowing
      ? await apiUnfollow({ follower: currentHandle, target: post.handle, deviceId })
      : await apiFollow({ follower: currentHandle, target: post.handle, deviceId });
    setFollowBusy(false);
    if (!r.ok) {
      // Roll back on failure.
      setIsFollowing(wasFollowing);
      showToast(r.reason || 'Follow failed', 'error');
    }
  };

  const onToggleLike = async () => {
    if (!currentHandle || !deviceId) {
      showToast('Claim a handle to like posts', 'error');
      return;
    }
    if (likeBusy) return;
    setLikeBusy(true);

    // Sound only on LIKE (not unlike) — matches IG/Twitter behavior
    // where the audible feedback fires on the positive action.
    if (!liked) playLikeBlip();

    // Optimistic update
    const prevLiked = liked;
    const prevCount = likeCount;
    setLiked(!prevLiked);
    setLikeCount(prevCount + (prevLiked ? -1 : 1));

    const result = await apiToggleLike({ postId: post.id, handle: currentHandle, deviceId });
    if (!result.ok) {
      // Revert on failure
      setLiked(prevLiked);
      setLikeCount(prevCount);
      showToast(result.reason || 'Like failed', 'error');
    } else if (typeof result.count === 'number') {
      // Trust the server's count
      setLiked(!!result.liked);
      setLikeCount(result.count);
    }
    setLikeBusy(false);
  };

  const timeAgoShort = formatTimeAgoShort(post.approvedAt || post.createdAt);

  // If the user picked "Hide post" from the 3-dot menu (and there's no
  // parent callback to remove from the list), short-circuit the render
  // so the card disappears in place.
  if (localHidden) return null;

  return (
    <div style={S.postCard}>
      {/* "Reposted by X" banner — only renders when this feed entry is a
          repost (server stamps repostedBy on the entry). Tapping the
          handle opens that user's profile. Matches IG's small grey
          line that sits above the original post card. */}
      {post.repostedBy && (
        <div style={S.repostBanner}>
          {/* Repost icon, smaller — visual cue this entry was rebroadcast. */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8a8a8a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <polyline points="17 1 21 5 17 9" />
            <path d="M3 11V9a4 4 0 0 1 4-4h14" />
            <polyline points="7 23 3 19 7 15" />
            <path d="M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
          <span style={S.repostBannerText}>
            Reposted by <span style={S.repostBannerHandle}>{post.repostedBy}</span>
          </span>
        </div>
      )}
      {/* Top row: avatar | handle · time | follow | menu */}
      <div style={S.postHeader}>
        <button onClick={onHandleTap} style={S.postAvatarBtn} aria-label={`${post.handle} profile`}>
          {/* Author avatar — server denormalizes post.avatarUrl. Falls
              back to the default exposure icon if the user hasn't picked
              a library/upload avatar yet. Wrapped in the same circular
              ring styling as before. */}
          <img
            src={resolveAvatarUrl(post.avatarUrl) || exposureIconUrl}
            alt=""
            style={S.postAvatarImg}
          />
        </button>
        <div style={S.postHeaderTextCol}>
          <div style={S.postHeaderLine1}>
            <button onClick={onHandleTap} style={S.postHandleBtn}>{post.handle}</button>
            <span style={S.postHeaderDot}>·</span>
            <span style={S.postTime}>{timeAgoShort}</span>
          </div>
          {/* Site location chip — only for site-tagged posts. Freeform
              posts (siteTitle === null) just show handle + time. */}
          {post.siteTitle && (
            <button onClick={onSiteTap} style={S.postLocationBtn}>
              {post.siteTitle}
            </button>
          )}
        </div>
        {/* IG-style inline Follow button — hides on own posts. The
            button toggles between "Follow" (filled white pill) and
            "Following" (outlined gray pill). Sits between the handle
            column and the 3-dot menu. */}
        {!isOwn && currentHandle && (
          <button
            onClick={onToggleFollow}
            disabled={followBusy}
            style={isFollowing ? S.postFollowBtnFollowing : S.postFollowBtn}
            aria-label={isFollowing ? `Unfollow ${post.handle}` : `Follow ${post.handle}`}
          >
            {isFollowing ? 'Following' : 'Follow'}
          </button>
        )}
        <button
          onClick={() => setMenuOpen(true)}
          style={S.postMenuBtn}
          aria-label="More options"
        >⋯</button>
      </div>

      {/* v1.17: YouTube video post — inline iframe with scroll-pause.
          See YouTubeEmbed component for the full behavior + WKWebView
          fix notes. Pause-on-scroll-out matches the native video post
          behavior so audio doesn't bleed across feed cards. */}
      {post.youtubeId ? (
        <YouTubeEmbed youtubeId={post.youtubeId} />
      ) : (
        /* Photo(s) — single-photo posts render one image edge-to-edge;
           multi-photo posts (v1.12 carousels) render a horizontal snap-
           scroll strip with page dots underneath. Tap any photo to open
           the full-aspect lightbox viewer with pinch-zoom and pan.
           We use CSS scroll-snap so the gesture feels native — no JS
           touch handling, no jank. */
      (() => {
        const photos = (post.photoUrls && post.photoUrls.length > 0)
          ? post.photoUrls
          : [post.photoUrl];
        // Parallel array of media types. Defaults to all 'photo' for
        // backwards-compat with pre-v1.13 posts that don't carry it.
        const types = (post.mediaTypes && post.mediaTypes.length === photos.length)
          ? post.mediaTypes
          : photos.map(() => 'photo');
        const isCarousel = photos.length > 1;

        // Renders a single slot. Photo = <img>; video = <video> with
        // autoplay-muted. v1.16: instead of looping forever, count plays
        // via onEnded and stop after 3. Saves battery + cuts the
        // annoying "video that won't stop" UX when scrolled past.
        const renderSlot = (url: string, type: string, i: number) => {
          if (type === 'video') {
            return (
              <video
                key={i}
                src={url}
                style={S.postPhoto}
                // Always mounts muted. User can tap the native mute
                // button on the controls to hear audio for that ONE
                // video. As soon as it scrolls out of view it pauses
                // AND re-mutes (see IntersectionObserver below) so
                // (a) the next video in view doesn't have lingering
                // audio carry-over, and (b) coming back to this video
                // starts silent again. Simpler than IG's remember-mute
                // model and avoids audio-blast on app reopen.
                muted
                autoPlay
                playsInline
                controls
                preload="metadata"
                // v1.17: pause when scrolled out of view (≥75% off
                // screen). On exit we also force .muted = true so the
                // next time this video comes back into view, or any
                // other video the user scrolls to, it starts silent.
                // Returning to view auto-resumes unless we hit the
                // 3-play cap.
                ref={(el) => {
                  if (!el) return;
                  if (el.dataset.viewObs === '1') return;
                  el.dataset.viewObs = '1';
                  if (typeof IntersectionObserver === 'undefined') return;
                  const io = new IntersectionObserver(
                    (entries) => {
                      for (const ent of entries) {
                        const v = ent.target as HTMLVideoElement;
                        if (ent.isIntersecting) {
                          const n = parseInt(v.dataset.playCount || '0', 10);
                          if (n < 3 && v.paused) {
                            v.play().catch(() => { /* autoplay may block — silent */ });
                          }
                        } else {
                          // Leaving the viewport: pause + reset to muted.
                          if (!v.paused) v.pause();
                          v.muted = true;
                        }
                      }
                    },
                    { threshold: 0.25 }
                  );
                  io.observe(el);
                }}
                // data attribute tracks how many full plays we've seen.
                // onEnded fires per playthrough; we manually re-trigger
                // play() up to 3 times, then stop and leave the video
                // paused on its last frame.
                onPlay={(e) => {
                  const el = e.currentTarget as HTMLVideoElement;
                  if (!el.dataset.playCount) el.dataset.playCount = '0';
                }}
                onEnded={(e) => {
                  const el = e.currentTarget as HTMLVideoElement;
                  const n = parseInt(el.dataset.playCount || '0', 10) + 1;
                  el.dataset.playCount = String(n);
                  if (n < 3) {
                    el.currentTime = 0;
                    el.play().catch(() => { /* silent — autoplay may be blocked */ });
                  }
                  // else: leave paused on final frame.
                }}
              />
            );
          }
          return <img key={i} src={url} alt="" style={S.postPhoto} draggable={false} />;
        };

        if (!isCarousel) {
          const type = types[0] || 'photo';
          if (type === 'video') {
            // Single video — render directly, no wrapping button.
            return (
              <div style={{ width: '100%', display: 'block' }}>
                {renderSlot(photos[0], 'video', 0)}
              </div>
            );
          }
          return (
            <button
              type="button"
              onClick={() => setLightboxOpen(true)}
              aria-label="View photo fullscreen"
              style={{
                padding: 0,
                margin: 0,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                display: 'block',
                width: '100%',
              }}
            >
              {renderSlot(photos[0], 'photo', 0)}
            </button>
          );
        }
        return (
          <div style={S.postCarouselWrap}>
            <div
              style={S.postCarouselScroller}
              onTouchStart={(e) => e.stopPropagation()}
              onTouchMove={(e) => e.stopPropagation()}
              onTouchEnd={(e) => e.stopPropagation()}
              onScroll={(e) => {
                const el = e.currentTarget;
                const w = el.clientWidth;
                if (w > 0) {
                  const idx = Math.round(el.scrollLeft / w);
                  if (idx !== carouselIndex) setCarouselIndex(idx);
                }
              }}
            >
              {photos.map((url, i) => {
                const type = types[i] || 'photo';
                if (type === 'video') {
                  return (
                    <div key={i} style={S.postCarouselSlide}>
                      {renderSlot(url, 'video', i)}
                    </div>
                  );
                }
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setLightboxOpen(true)}
                    aria-label={`View photo ${i + 1} of ${photos.length} fullscreen`}
                    style={S.postCarouselSlide}
                  >
                    {renderSlot(url, 'photo', i)}
                  </button>
                );
              })}
            </div>
            {/* Page dots */}
            <div style={S.postCarouselDots}>
              {photos.map((_, i) => (
                <span
                  key={i}
                  style={{
                    ...S.postCarouselDot,
                    ...(i === carouselIndex ? S.postCarouselDotActive : null),
                  }}
                />
              ))}
            </div>
            <div style={S.postCarouselBadge}>
              {carouselIndex + 1}/{photos.length}
            </div>
          </div>
        );
      })()
      )}

      {/* Actions row — Instagram-style line icons: heart, comment (disabled
          for now, real comments later), share. All outlined SVGs at equal
          weight. */}
      <div style={S.postActions}>
        <button
          onClick={onToggleLike}
          style={S.postIconBtn}
          aria-label={liked ? 'Unlike' : 'Like'}
        >
          {liked ? (
            <svg width="26" height="26" viewBox="0 0 24 24" fill="#FF3B5C" stroke="#FF3B5C" strokeWidth="1.8" strokeLinejoin="round">
              <path d="M12 21s-7.5-4.6-9.5-9.5C1 7.5 4 4 7.5 4c2 0 3.4 1 4.5 2.5C13.1 5 14.5 4 16.5 4 20 4 23 7.5 21.5 11.5 19.5 16.4 12 21 12 21Z" />
            </svg>
          ) : (
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#F0EBE0" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 21s-7.5-4.6-9.5-9.5C1 7.5 4 4 7.5 4c2 0 3.4 1 4.5 2.5C13.1 5 14.5 4 16.5 4 20 4 23 7.5 21.5 11.5 19.5 16.4 12 21 12 21Z" />
            </svg>
          )}
        </button>
        <button
          onClick={() => setCommentsOpen(true)}
          style={S.postIconBtn}
          aria-label="View comments"
        >
          {/* Comment bubble — taps open the IG-style sheet. */}
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#F0EBE0" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3a8.38 8.38 0 0 1 8.5 8.5z" />
          </svg>
          {commentCount > 0 && (
            <span style={S.postIconBtnCount}>{commentCount}</span>
          )}
        </button>
        <button
          onClick={async () => {
            if (!currentHandle || !deviceId) {
              showToast('Sign in to repost', 'error');
              return;
            }
            if (repostBusy) return;
            // Optimistic toggle so the icon flips instantly. Roll back
            // if the server rejects.
            const prev = reposted;
            const prevCount = repostCount;
            setReposted(!prev);
            setRepostCount(prev ? Math.max(0, prevCount - 1) : prevCount + 1);
            setRepostBusy(true);
            const result = await apiToggleRepost({
              postId: post.id, handle: currentHandle, deviceId,
            });
            setRepostBusy(false);
            if (!result.ok) {
              // Rollback. Show specific message if the server explained why
              // (e.g. can't repost your own post).
              setReposted(prev);
              setRepostCount(prevCount);
              showToast(result.reason || 'Repost failed', 'error');
              return;
            }
            // Sync to server's authoritative state.
            if (typeof result.reposted === 'boolean') setReposted(result.reposted);
            if (typeof result.count === 'number') setRepostCount(result.count);
            showToast(result.reposted ? 'Reposted' : 'Removed from your reposts', 'success');
          }}
          style={S.postIconBtn}
          aria-label={reposted ? 'Remove repost' : 'Repost'}
        >
          {/* Repost icon — two arrows forming a cycle, IG-style. Fills
              green when reposted for the same visual feedback as the heart. */}
          <svg
            width="26" height="26" viewBox="0 0 24 24"
            fill="none"
            stroke={reposted ? '#3DDB85' : '#F0EBE0'}
            strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
          >
            <polyline points="17 1 21 5 17 9" />
            <path d="M3 11V9a4 4 0 0 1 4-4h14" />
            <polyline points="7 23 3 19 7 15" />
            <path d="M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
          {repostCount > 0 && (
            <span style={S.postIconBtnCount}>{repostCount}</span>
          )}
        </button>
        <button
          onClick={async () => {
            try {
              const nav: any = navigator;
              if (!nav.share) {
                showToast('Sharing not available', 'error');
                return;
              }
              const shareData: any = {
                title: 'The Dread Directory',
                text: `${post.caption}\n\n${post.siteTitle || ''} — Dread Directory`,
              };
              try {
                const res = await fetch(post.photoUrl);
                const blob = await res.blob();
                const file = new File([blob], 'post.jpg', { type: blob.type || 'image/jpeg' });
                if (nav.canShare && nav.canShare({ files: [file] })) {
                  shareData.files = [file];
                }
              } catch { /* fall through to text-only share */ }
              await nav.share(shareData);
            } catch {
              // User cancelled or share threw — silent
            }
          }}
          style={S.postIconBtn}
          aria-label="Share post"
        >
          {/* Paper-airplane share icon, IG-style */}
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#F0EBE0" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>

      {/* Like count — Instagram-style bold "1,234 likes" line */}
      {likeCount > 0 && (
        <div style={S.postLikeCount}>
          {likeCount === 1 ? '1 like' : `${likeCount.toLocaleString()} likes`}
        </div>
      )}

      {/* Caption — handle in bold inline with caption text, like IG.
          v1.17 fix: caption is 2-line truncated with inline "more"
          affordance that expands in place. Tapping the caption body
          NO LONGER opens the comments sheet (was a bug). Tapping the
          handle still goes to profile; hashtag taps still go to the
          tag view via CaptionWithTags' internal stopPropagation. */}
      <CaptionExpander
        caption={post.caption}
        onTagTap={(tag) => onHashtagTap && onHashtagTap(tag)}
        handleElement={
          <button onClick={onHandleTap} style={S.postCaptionHandle}>{post.handle}</button>
        }
        baseStyle={S.postCaptionLine}
      />

      {/* "View all N comments" link, IG-style — appears below the
          caption when there's at least one comment. Tapping opens the
          same sheet as the comment-icon button. */}
      {commentCount > 0 && (
        <button onClick={() => setCommentsOpen(true)} style={S.postViewCommentsBtn}>
          View {commentCount === 1 ? '1 comment' : `all ${commentCount} comments`}
        </button>
      )}

      {/* IG-style inline preview rows — show the latest 1-2 top-level
          comments under the caption. Each row is tappable and opens
          the comment sheet just like the View-all button. Server sends
          newest-first; we reverse for display so the older of the two
          appears above the newer (more natural reading order — same as
          IG's chronological top-of-thread preview). */}
      {(post.latestComments && post.latestComments.length > 0) && (
        <div style={S.postLatestComments}>
          {[...post.latestComments].reverse().map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCommentsOpen(true)}
              style={S.postLatestCommentRow}
            >
              <span style={S.postLatestCommentHandle}>{c.handle}</span>
              <span style={S.postLatestCommentBody}> {c.body}</span>
            </button>
          ))}
        </div>
      )}

      {/* IG-style bottom-sheet comments. Rendered conditionally so the
          DOM stays small until the user actually taps. The sheet itself
          portals to body so it overlays everything. */}
      {commentsOpen && (
        <CommentSheet
          post={post}
          currentHandle={currentHandle}
          deviceId={deviceId}
          onClose={() => setCommentsOpen(false)}
          onCountChange={(n) => setCommentCount(n)}
        />
      )}

      {/* 3-dot action sheet — IG-style. About this account is always
          available; Hide is always available. Block + Report are
          surfaced only for other people's posts. Delete is surfaced
          only for the viewer's own posts. */}
      {menuOpen && (
        <ActionSheet
          onClose={() => setMenuOpen(false)}
          actions={[
            {
              label: 'About this account',
              onClick: () => onHandleTap(),
            },
            {
              label: 'Hide post',
              onClick: async () => {
                await hidePost(post.id);
                if (onPostRemoved) {
                  onPostRemoved(post.id);
                } else {
                  setLocalHidden(true);
                }
                showToast('Post hidden', 'success');
              },
            },
            ...(isOwn ? [
              {
                label: 'Delete post',
                onClick: () => setDeleteConfirmOpen(true),
                destructive: true,
              },
            ] : [
              {
                label: 'Report post',
                onClick: () => {
                  if (!currentHandle || !deviceId) {
                    showToast('Claim a handle to report', 'error');
                    return;
                  }
                  setReportOpen(true);
                },
                destructive: true,
              },
              {
                label: `Block @${post.handle}`,
                onClick: async () => {
                  if (!currentHandle || !deviceId) {
                    showToast('Claim a handle to block', 'error');
                    return;
                  }
                  const result = await apiBlock({
                    blocker: currentHandle,
                    blocked: post.handle,
                    deviceId,
                  });
                  if (result.ok) {
                    invalidateHiddenSet();
                    showToast(`Blocked @${post.handle}`, 'success');
                  } else {
                    showToast(result.reason || 'Block failed', 'error');
                  }
                },
                destructive: true,
              },
            ]),
          ]}
        />
      )}

      {/* Delete confirmation modal — only own posts. Two-step so a
          stray tap doesn't nuke a post. */}
      {deleteConfirmOpen && currentHandle && deviceId && (
        <ConfirmDeletePostModal
          onCancel={() => setDeleteConfirmOpen(false)}
          onConfirm={async () => {
            setDeleteConfirmOpen(false);
            const r = await apiDeleteMyPost({
              postId: post.id,
              handle: currentHandle,
              deviceId,
            });
            if (r.ok) {
              if (onPostRemoved) {
                onPostRemoved(post.id);
              } else {
                setLocalHidden(true);
              }
              showToast('Post deleted', 'success');
            } else {
              showToast(r.reason || 'Delete failed', 'error');
            }
          }}
        />
      )}

      {/* Report modal — only renders when user picks Report from the
          action sheet. apiReport already handles dedupe server-side. */}
      {reportOpen && currentHandle && deviceId && (
        <ReportModal
          targetType="post"
          targetId={post.id}
          handle={currentHandle}
          deviceId={deviceId}
          onClose={() => setReportOpen(false)}
          onReported={() => {
            setReportOpen(false);
            showToast('Thanks — report sent', 'success');
          }}
        />
      )}

      {/* Full-screen photo viewer — opens when user taps the post photo.
          Pinch-zoom, pan when zoomed, double-tap zoom, swipe-down dismiss. */}
      {lightboxOpen && (
        <PhotoLightbox
          imageUrl={post.photoUrl}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </div>
  );
}

// ---------- SocialPollCard ----------
// Renders a poll inline in the DreadFeed alongside SocialPostCards. The
// card has two visual states:
//   - Pre-vote (no userVote, not expired): question + 4 tappable options,
//     no results visible. Tapping an option submits the vote and the
//     card flips to the results state.
//   - Post-vote / expired: question + 4 horizontal bars showing percent
//     of total, with the user's pick highlighted. Tapping a different
//     option (if not expired) changes the vote.
// Mirrors the SocialPostCard outer chrome (header with avatar + handle)
// so the two card types feel like the same feed surface.
function SocialPollCard({ poll, currentHandle, deviceId, onHandleTap }: {
  poll: PollEntry;
  currentHandle: string | null;
  deviceId: string | null;
  onHandleTap: () => void;
}) {
  // Local optimistic state — vote updates flip the card immediately
  // without waiting for a feed refetch.
  const [userVote, setUserVote] = useState<number | null>(poll.userVote);
  const [tallies, setTallies] = useState<number[] | null>(poll.tallies);
  const [totalVotes, setTotalVotes] = useState<number | null>(poll.totalVotes);
  const [voting, setVoting] = useState(false);

  const expired = poll.expired;
  const showResults = expired || userVote !== null;
  const canVote = !expired && !!currentHandle && !!deviceId && !voting;

  // ---- Time-remaining label ("3d left" / "Ends in 4h" / "Closed") ----
  // Computed once on mount; polls don't tick in real time — staleness
  // by a few minutes is fine for a feed card.
  const timeLabel = (() => {
    if (expired) return 'Poll closed';
    const ms = new Date(poll.expiresAt).getTime() - Date.now();
    if (ms <= 0) return 'Poll closed';
    const days = Math.floor(ms / (24 * 60 * 60 * 1000));
    if (days >= 1) return `${days}d left`;
    const hours = Math.floor(ms / (60 * 60 * 1000));
    if (hours >= 1) return `${hours}h left`;
    const mins = Math.floor(ms / (60 * 1000));
    return `${Math.max(1, mins)}m left`;
  })();

  const onPick = async (idx: number) => {
    if (!canVote) {
      if (!currentHandle) {
        showToast('Claim a handle first to vote', 'error');
      }
      return;
    }
    if (idx === userVote) return;        // tapping current pick = no-op
    playPop();
    setVoting(true);
    const result = await apiVoteOnPoll({
      pollId: poll.id,
      handle: currentHandle!,
      deviceId: deviceId!,
      optionIndex: idx,
    });
    setVoting(false);
    if (result.ok) {
      setUserVote(typeof result.userVote === 'number' ? result.userVote : idx);
      if (Array.isArray(result.tallies)) setTallies(result.tallies);
      if (typeof result.totalVotes === 'number') setTotalVotes(result.totalVotes);
    } else {
      showToast(`Vote failed: ${result.reason || 'unknown'}`, 'error');
    }
  };

  // Percent for the bar, gracefully handling 0 total.
  const pct = (idx: number) => {
    if (!tallies || !totalVotes) return 0;
    if (totalVotes === 0) return 0;
    return Math.round((tallies[idx] / totalVotes) * 100);
  };

  return (
    <div style={S.pollCard}>
      {/* Card header — handle + time-remaining badge. Tapping the handle
          navigates to the user's profile (same as post cards). */}
      <div style={S.pollCardHeader}>
        <button
          onClick={onHandleTap}
          style={S.pollCardHandleBtn}
          className="sinister-icon-btn"
        >
          @{poll.handle}
        </button>
        <div style={S.pollCardBadge}>📊 Poll · {timeLabel}</div>
      </div>

      {/* Question — system font, white, generous line-height. */}
      <div style={S.pollCardQuestion}>{poll.question}</div>

      {/* Options. Two visual modes: pre-vote (plain pill buttons) or
          results (horizontal-bar fills inside each option, percent label
          on the right, viewer's pick highlighted with a red accent). */}
      <div style={S.pollCardOptions}>
        {poll.options.map((opt, idx) => {
          const isPicked = userVote === idx;
          if (!showResults) {
            return (
              <button
                key={idx}
                onClick={() => onPick(idx)}
                disabled={!canVote}
                style={S.pollOptionBtn}
                className="sinister-icon-btn"
              >
                {opt}
              </button>
            );
          }
          const p = pct(idx);
          return (
            <button
              key={idx}
              onClick={() => onPick(idx)}
              disabled={!canVote}
              style={{
                ...S.pollOptionResult,
                ...(isPicked ? S.pollOptionResultPicked : {}),
              }}
              className="sinister-icon-btn"
            >
              {/* Fill bar — width is the percentage. Sits behind the label. */}
              <div
                style={{
                  ...S.pollOptionFill,
                  width: `${p}%`,
                  ...(isPicked ? S.pollOptionFillPicked : {}),
                }}
              />
              <div style={S.pollOptionLabel}>{opt}{isPicked ? ' ✓' : ''}</div>
              <div style={S.pollOptionPct}>{p}%</div>
            </button>
          );
        })}
      </div>

      {/* Footer — total vote count when visible, or a CTA prompt when
          results are hidden. Plus expiry note for closed polls. */}
      <div style={S.pollCardFooter}>
        {showResults ? (
          <>
            <span>{totalVotes ?? 0} vote{(totalVotes ?? 0) === 1 ? '' : 's'}</span>
            {!expired && userVote !== null && (
              <span style={{ opacity: 0.6, marginLeft: 8 }}>· Tap to change your vote</span>
            )}
            {expired && (
              <span style={{ opacity: 0.6, marginLeft: 8 }}>· Final results</span>
            )}
          </>
        ) : (
          <span style={{ opacity: 0.6 }}>Vote to see results</span>
        )}
      </div>
    </div>
  );
}

// ---------- PollComposerSheet ----------
// Full-screen sheet that lets a user create a poll. Reached from the
// DreadFeed ➕ tab's type-chooser. Layout matches ExposurePostSheet's
// header chrome (✕ Cancel | "New poll" | "Share") so the two composer
// flows feel like the same surface.
//
// Fields:
//   - 1 question (3-200 chars)
//   - 4 options (1-80 chars each, all required)
// Share button enables only when all five fields pass length checks.
function PollComposerSheet({ handle, deviceId, onClose, onPosted }: {
  handle: string | null;
  deviceId: string | null;
  onClose: () => void;
  onPosted: () => void;
}) {
  const [question, setQuestion] = useState('');
  // Always 4 options. We use an array of strings indexed 0..3 so render
  // can map cleanly. Mirrors the server's OPTIONS_COUNT = 4 hard rule.
  const [options, setOptions] = useState<string[]>(['', '', '', '']);
  const [submitting, setSubmitting] = useState(false);

  const qTrim = question.trim();
  const optsTrim = options.map((o) => o.trim());
  // Mirror server validation: question 3-200, each option 1-80.
  const qValid = qTrim.length >= 3 && qTrim.length <= 200;
  const optsValid = optsTrim.every((o) => o.length >= 1 && o.length <= 80);
  const canShare = qValid && optsValid && !submitting && !!handle && !!deviceId;

  const updateOption = (idx: number, value: string) => {
    setOptions((prev) => prev.map((o, i) => (i === idx ? value : o)));
  };

  const onShare = async () => {
    if (!canShare) return;
    setSubmitting(true);
    const result = await apiCreatePoll({
      handle: handle!,
      deviceId: deviceId!,
      question: qTrim,
      options: optsTrim,
    });
    setSubmitting(false);
    if (result.ok) {
      playPostShared();
      onPosted();
    } else {
      showToast(`Poll failed: ${result.reason || 'unknown error'}`, 'error');
    }
  };

  // No handle? Match the ExposurePostSheet fallback screen.
  if (!handle || !deviceId) {
    return createPortal(
      <div style={S.igComposerScreen}>
        <div style={S.igComposerHeader}>
          <button onClick={onClose} style={S.igComposerHeaderBtn} aria-label="Close">✕</button>
          <div style={S.igComposerHeaderTitle}>New poll</div>
          <div style={{ width: 40 }} />
        </div>
        <div style={{ padding: '40px 24px', textAlign: 'center', color: '#BBB', fontSize: 15, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
          Claim a handle to post a poll.
        </div>
      </div>,
      document.body
    );
  }

  return createPortal(
    <div style={S.igComposerScreen}>
      <div style={S.igComposerHeader}>
        <button onClick={onClose} style={S.igComposerHeaderBtn} aria-label="Cancel">✕</button>
        <div style={S.igComposerHeaderTitle}>New poll</div>
        <button
          onClick={onShare}
          disabled={!canShare}
          style={{
            ...S.igComposerHeaderBtn,
            color: canShare ? '#0095F6' : '#0095F655',
            fontWeight: 700,
            fontSize: 15,
            width: 'auto',
            paddingLeft: 8,
            paddingRight: 8,
          }}
          aria-label="Share poll"
        >
          {submitting ? '…' : 'Share'}
        </button>
      </div>

      <div style={S.pollComposerBody}>
        {/* Question field. textarea so users can write longer questions
            comfortably; visually monospaced character counter on the
            right of the label so they can see how close they are to the
            200-char ceiling. */}
        <div style={S.pollComposerLabelRow}>
          <span style={S.pollComposerLabel}>Question</span>
          <span style={S.pollComposerCount}>{qTrim.length}/200</span>
        </div>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value.slice(0, 200))}
          placeholder="Ask the Dread Directory…"
          style={S.pollComposerQuestion}
          rows={2}
        />

        <div style={{ ...S.pollComposerLabelRow, marginTop: 18 }}>
          <span style={S.pollComposerLabel}>Options</span>
          <span style={S.pollComposerCount}>4 required</span>
        </div>
        {options.map((opt, idx) => (
          <div key={idx} style={S.pollComposerOptionRow}>
            <span style={S.pollComposerOptionNum}>{idx + 1}</span>
            <input
              type="text"
              value={opt}
              onChange={(e) => updateOption(idx, e.target.value.slice(0, 80))}
              placeholder={`Option ${idx + 1}`}
              style={S.pollComposerOptionInput}
            />
          </div>
        ))}

        <div style={S.pollComposerHint}>
          Polls run for 7 days. Voters can change their pick until then.
        </div>
      </div>
    </div>,
    document.body
  );
}

// ---------- YouTubeEmbed ----------
// Renders a YouTube video post inline. Uses YouTube's iframe API (via
// enablejsapi=1 + origin + postMessage) so we can pause the player when
// the iframe scrolls out of view. Without that, scrolling past a playing
// video lets it keep playing and bleed audio over other posts — exactly
// the IG/TikTok auto-pause behavior people expect from a feed.
//
// Behavior:
//   - Iframe enters viewport (>=25% visible): no auto-play (YouTube
//     blocks autoplay-with-sound anyway; user taps the player to start).
//   - Iframe leaves viewport (<25% visible): we postMessage 'pauseVideo'
//     to halt playback. User can re-enter and tap to resume.
//
// WKWebView fix bundled in: youtube-nocookie.com domain + referrerPolicy
// "origin" so the Referer survives the capacitor:// → https: scheme
// transition. Without these, YouTube returns Error 153.
//
// DIAGNOSTIC PANEL: a tappable green overlay shows live environment info
// (protocol, origin, document.referrer, iframe URL, iframe load status,
// and YouTube postMessage events). Helps debug Error 153 in the live
// app without DevTools. Tap "▾ DIAG" red button to collapse. Tap the
// panel itself to copy all contents to clipboard. Remove this panel
// once iOS playback is confirmed working.
function YouTubeEmbed({ youtubeId }: { youtubeId: string }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [messages, setMessages] = useState<string[]>([]);
  const [iframeStatus, setIframeStatus] = useState<'pending' | 'loaded' | 'error'>('pending');

  // Capture environment info once at mount. These are the fields most
  // likely to matter for Error 153 diagnosis:
  //   - location.protocol: capacitor: / https: / http: / file:
  //   - document.referrer: what's currently being sent
  //   - navigator.userAgent: WKWebView UA (iOS version + capacitor build)
  const env = useMemo(() => ({
    protocol: window.location.protocol,
    href: window.location.href,
    origin: window.location.origin,
    referrer: document.referrer || '(empty)',
    ua: navigator.userAgent,
  }), []);

  // Build the iframe URL. enablejsapi=1 + origin are REQUIRED for the
  // postMessage control plane to work (and on iOS WKWebView, omitting
  // them breaks the embed entirely).
  const iframeUrl = useMemo(
    () => `https://www.youtube-nocookie.com/embed/${youtubeId}?rel=0&modestbranding=1&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`,
    [youtubeId]
  );

  // Pause the player by posting a JSON command to the iframe's window.
  // YouTube's iframe API listens for {event:'command', func:'pauseVideo'}
  // (and 'playVideo', 'stopVideo', 'mute', etc).
  const pauseIframe = () => {
    const el = iframeRef.current;
    if (!el || !el.contentWindow) return;
    try {
      el.contentWindow.postMessage(
        JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] }),
        '*'
      );
    } catch { /* silent */ }
  };

  // Listen for postMessage events from the YouTube iframe. The player
  // posts JSON-stringified messages on init + on errors. Error messages
  // include an `info` field with the actual reason — "Embedding disabled
  // by request", a numeric code, etc. These tell us exactly what's
  // failing on iOS without DevTools.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const origin = String(e.origin || '');
      if (!/^https:\/\/(www\.)?(youtube\.com|youtube-nocookie\.com)$/.test(origin)) {
        return;
      }
      let data: any = e.data;
      let line: string;
      try {
        if (typeof data === 'string') {
          try { data = JSON.parse(data); } catch { /* leave as string */ }
        }
        line = typeof data === 'string' ? data : JSON.stringify(data);
      } catch {
        line = String(data);
      }
      setMessages((prev) => {
        const next = [...prev, `${origin}: ${line}`];
        return next.slice(-20);
      });
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // IntersectionObserver — same threshold as the native video posts so
  // pause behavior feels consistent across photo/video/YouTube posts.
  useEffect(() => {
    const el = iframeRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const ent of entries) {
          if (!ent.isIntersecting) {
            pauseIframe();
          }
        }
      },
      { threshold: 0.25 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Copy helper — uses execCommand fallback because clipboard API needs
  // user gesture + HTTPS, and capacitor:// origins fail the HTTPS check.
  const copy = (text: string) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch { /* silent */ }
  };

  const panelText = [
    `PROTOCOL: ${env.protocol}`,
    `ORIGIN: ${env.origin}`,
    `HREF: ${env.href}`,
    `REFERRER: ${env.referrer}`,
    `IFRAME URL: ${iframeUrl}`,
    `IFRAME STATUS: ${iframeStatus}`,
    `MESSAGES (${messages.length}):`,
    ...messages.map((m, i) => `[${i}] ${m}`),
    `UA: ${env.ua}`,
  ].join('\n');

  return (
    <div style={{ width: '100%', aspectRatio: '16 / 9', background: '#000', position: 'relative' }}>
      <iframe
        ref={iframeRef}
        src={iframeUrl}
        title="YouTube video"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
        referrerPolicy="origin"
        onLoad={() => setIframeStatus('loaded')}
        onError={() => setIframeStatus('error')}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          border: 'none',
          display: 'block',
        }}
      />

      {/* Diagnostic toggle — small red badge in bottom-left. */}
      <button
        onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
        style={{
          position: 'absolute',
          bottom: 4,
          left: 4,
          padding: '4px 8px',
          background: 'rgba(255,0,0,0.85)',
          color: '#fff',
          border: 'none',
          borderRadius: 4,
          fontSize: 11,
          fontFamily: 'monospace',
          zIndex: 2,
          cursor: 'pointer',
        }}
      >
        {expanded ? '▾ DIAG' : '▸ DIAG'}
      </button>

      {expanded && (
        <div
          onClick={(e) => { e.stopPropagation(); copy(panelText); }}
          style={{
            position: 'absolute',
            top: 4,
            left: 4,
            right: 4,
            maxHeight: '85%',
            overflowY: 'auto',
            background: 'rgba(0,0,0,0.92)',
            color: '#0f0',
            border: '1px solid #0f0',
            borderRadius: 4,
            padding: 6,
            fontSize: 10,
            fontFamily: 'monospace',
            lineHeight: 1.3,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            zIndex: 1,
            cursor: 'pointer',
          }}
        >
          {panelText}
          {'\n\n'}
          [tap panel to copy all]
        </div>
      )}
    </div>
  );
}


// ---------- YouTubeComposerSheet ----------
// Full-screen sheet for posting a YouTube video to DreadFeed. Reached
// from the ➕ chooser's "YouTube Video" option. Matches the IG-style
// chrome of the photo and poll composers (✕ Cancel | "New YouTube post"
// | Share).
//
// Fields:
//   - URL paste field (any YouTube URL shape; extractYouTubeId parses)
//   - Caption (1-280 chars, same rules as photo/freeform posts)
// Live thumbnail preview at 16:9 the moment a valid URL is detected.
// Share enables only when both fields pass + we have a handle/deviceId.
function YouTubeComposerSheet({ handle, deviceId, onClose, onPosted }: {
  handle: string | null;
  deviceId: string | null;
  onClose: () => void;
  onPosted: () => void;
}) {
  const [urlInput, setUrlInput] = useState('');
  const [caption, setCaption] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Re-parse on every keystroke. Cheap — it's just regex + URL().
  const youtubeId = useMemo(() => extractYouTubeId(urlInput), [urlInput]);
  const captionTrim = caption.trim();
  const captionValid = captionTrim.length >= 1 && captionTrim.length <= 280;
  const canShare = !!youtubeId && captionValid && !submitting && !!handle && !!deviceId;

  const onShare = async () => {
    if (!canShare) return;
    setSubmitting(true);
    const result = await apiCreateYouTubePost({
      handle: handle!,
      deviceId: deviceId!,
      caption: captionTrim,
      youtubeId: youtubeId!,
    });
    setSubmitting(false);
    if (result.ok) {
      playPostShared();
      onPosted();
    } else {
      showToast(`YouTube post failed: ${result.reason || 'unknown error'}`, 'error');
    }
  };

  // No handle? Match the other composers' fallback screen.
  if (!handle || !deviceId) {
    return createPortal(
      <div style={S.igComposerScreen}>
        <div style={S.igComposerHeader}>
          <button onClick={onClose} style={S.igComposerHeaderBtn} aria-label="Close">✕</button>
          <div style={S.igComposerHeaderTitle}>New YouTube post</div>
          <div style={{ width: 40 }} />
        </div>
        <div style={{ padding: '40px 24px', textAlign: 'center', color: '#BBB', fontSize: 15, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
          Claim a handle to post a YouTube video.
        </div>
      </div>,
      document.body
    );
  }

  return createPortal(
    <div style={S.igComposerScreen}>
      <div style={S.igComposerHeader}>
        <button onClick={onClose} style={S.igComposerHeaderBtn} aria-label="Cancel">✕</button>
        <div style={S.igComposerHeaderTitle}>New YouTube post</div>
        <button
          onClick={onShare}
          disabled={!canShare}
          style={{
            ...S.igComposerHeaderBtn,
            color: canShare ? '#0095F6' : '#0095F655',
            fontWeight: 700,
            fontSize: 15,
            width: 'auto',
            paddingLeft: 8,
            paddingRight: 8,
          }}
          aria-label="Share YouTube post"
        >
          {submitting ? '…' : 'Share'}
        </button>
      </div>

      <div style={S.pollComposerBody}>
        {/* URL field */}
        <div style={S.pollComposerLabelRow}>
          <span style={S.pollComposerLabel}>YouTube URL</span>
          <span style={S.pollComposerCount}>{youtubeId ? '✓ valid' : 'paste any link'}</span>
        </div>
        <input
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder="https://youtube.com/watch?v=…"
          style={S.pollComposerOptionInput}
        />

        {/* Live 16:9 thumbnail preview the moment we detect a valid ID. */}
        {youtubeId && (
          <div style={{
            width: '100%',
            aspectRatio: '16 / 9',
            background: '#000',
            borderRadius: 8,
            overflow: 'hidden',
            marginTop: 12,
            position: 'relative',
          }}>
            <img
              src={`https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`}
              alt="YouTube thumbnail"
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
            {/* Play badge overlay — purely cosmetic; tap doesn't play. */}
            <div style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 60,
              height: 60,
              borderRadius: '50%',
              background: 'rgba(0,0,0,0.6)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
            }}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="#fff">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </div>
        )}

        {/* Caption */}
        <div style={{ ...S.pollComposerLabelRow, marginTop: 18 }}>
          <span style={S.pollComposerLabel}>Caption</span>
          <span style={S.pollComposerCount}>{captionTrim.length}/280</span>
        </div>
        <textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value.slice(0, 280))}
          placeholder="Say something about this video…"
          style={S.pollComposerQuestion}
          rows={3}
        />

        <div style={S.pollComposerHint}>
          Paste any YouTube link — watch, shorts, youtu.be, or embed.
          The video plays inline in the feed.
        </div>
      </div>
    </div>,
    document.body
  );
}

// ---------- ChoosePostTypeSheet ----------
// Tiny bottom sheet that appears when the user taps ➕ on DreadFeed.
// Three options: "Photo / Video" → ExposurePostSheet, "Poll" →
// PollComposerSheet, "YouTube Video" → YouTubeComposerSheet. Matches
// the dark IG-style modal aesthetic.
function ChoosePostTypeSheet({ onPickPhoto, onPickPoll, onPickYouTube, onCancel }: {
  onPickPhoto: () => void;
  onPickPoll: () => void;
  onPickYouTube: () => void;
  onCancel: () => void;
}) {
  return createPortal(
    <div style={S.pollChooserBackdrop} onClick={onCancel}>
      <div style={S.pollChooserCard} onClick={(e) => e.stopPropagation()}>
        <div style={S.pollChooserTitle}>What are you posting?</div>
        <button onClick={onPickPhoto} style={S.pollChooserBtn} className="sinister-icon-btn">
          <span style={S.pollChooserBtnIcon}>📷</span>
          <span style={S.pollChooserBtnLabel}>Photo / Video</span>
        </button>
        <button onClick={onPickYouTube} style={S.pollChooserBtn} className="sinister-icon-btn">
          <span style={S.pollChooserBtnIcon}>▶︎</span>
          <span style={S.pollChooserBtnLabel}>YouTube Video</span>
        </button>
        <button onClick={onPickPoll} style={S.pollChooserBtn} className="sinister-icon-btn">
          <span style={S.pollChooserBtnIcon}>📊</span>
          <span style={S.pollChooserBtnLabel}>Poll</span>
        </button>
        <button onClick={onCancel} style={S.pollChooserCancel} className="sinister-icon-btn">
          Cancel
        </button>
      </div>
    </div>,
    document.body
  );
}

// ---------- ConfirmDeletePostModal ----------
// Two-step confirm before nuking your own post. Shown when the user
// picks "Delete post" from the 3-dot menu on their own post card.
function ConfirmDeletePostModal({ onCancel, onConfirm }: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return createPortal(
    <div style={S.confirmBackdrop} onClick={onCancel}>
      <div style={S.confirmCard} onClick={(e) => e.stopPropagation()}>
        <div style={S.confirmTitle}>Delete this post?</div>
        <div style={S.confirmBody}>
          The photo, caption, and all likes will be permanently removed.
          This can't be undone.
        </div>
        <div style={S.confirmActions}>
          <button onClick={onCancel} style={S.confirmCancelBtn}>Cancel</button>
          <button onClick={onConfirm} style={S.confirmDeleteBtn}>Delete</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ---------- Comment Sheet ----------
// IG-style bottom sheet that slides up over the post when the user taps
// the comment icon. Renders a scrollable list of comments (oldest first),
// an emoji quick-react row, and an input field at the bottom. Slides
// down on backdrop tap, drag handle pull-down, or X button.
//
// Visual style: black/white/grey, IG-neutral — NOT the app's purple/red
// horror palette. Drew specifically asked for IG visual parity here so
// the sheet feels familiar to users coming from Instagram. The only
// horror-app touch is the skull avatar, which we reuse from elsewhere
// since per-handle avatars don't exist yet.
function CommentSheet({ post, currentHandle, deviceId, onClose, onCountChange }: {
  post: SocialPost;
  currentHandle: string | null;
  deviceId: string | null;
  onClose: () => void;
  // Called after every successful add/delete so the parent's cached
  // count badge stays in sync without a full feed reload.
  onCountChange: (n: number) => void;
}) {
  const [comments, setComments] = useState<SocialComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Track per-comment like state in a Map keyed by comment id. Server
  // syncs on sheet open via apiCommentLikeStatus, then toggleLike below
  // optimistically updates and reverts on failure.
  const [commentLikes, setCommentLikes] = useState<Map<string, { liked: boolean; count: number }>>(new Map());
  // Drag-to-dismiss tracking. When the user touches the drag handle and
  // pulls down, we translate the sheet to follow their finger. Release
  // past the threshold = dismiss; release before = snap back.
  const [dragY, setDragY] = useState(0);
  const dragStartYRef = useRef<number | null>(null);
  // Track entrance animation. Sheet starts at translateY(100%) and
  // animates to translateY(0) on mount via a CSS transition + a
  // requestAnimationFrame state flip.
  const [mounted, setMounted] = useState(false);
  // Track exit animation. When the user taps backdrop / X / drags past
  // threshold, we flip `closing` true → CSS transitions back down → on
  // transitionend we call onClose to actually unmount.
  const [closing, setClosing] = useState(false);
  // 3-dot menu state for a single comment row. Holds the id of the
  // comment whose action sheet is open (null = closed). Report modal
  // tracks the target comment separately so the sheet can close before
  // the report modal opens.
  const [menuCommentId, setMenuCommentId] = useState<string | null>(null);
  const [reportComment, setReportComment] = useState<SocialComment | null>(null);
  // Reply state. When non-null, the composer shows a "Replying to @X"
  // pill and the next submit sends parentId pointing at this comment.
  // We always store the ROOT top-level comment id here (the server
  // would flatten it anyway), so even if the user taps Reply on a reply,
  // the next message threads correctly under the original parent.
  const [replyingTo, setReplyingTo] = useState<{ parentId: string; handle: string } | null>(null);
  // Set of top-level comment ids whose replies are currently expanded.
  // IG default: replies are hidden behind a "View N replies" toggle.
  // Tapping toggles inclusion in this set.
  const [expandedReplies, setExpandedReplies] = useState<Set<string>>(new Set());

  // Mount transition — set `mounted` true on next frame so the
  // translateY(100%) initial style gets a chance to commit before the
  // browser sees the transition target of translateY(0).
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Lock body scroll while the sheet is open. Without this, even with
  // overscrollBehavior:contain on the list, the underlying feed can
  // scroll if the user starts a drag outside the list (e.g. on the
  // composer or the emoji row). Locking the body prevents bleed-through
  // completely.
  //
  // iOS quirk: simply setting overflow:hidden visually pins the page
  // but can reset window.scrollY to 0 when restored. To prevent the
  // user being jumped back to the top of the feed after closing the
  // sheet, we snapshot the current scrollY, lock the body with a
  // negative top + fixed positioning (the IG approach), then restore
  // both styles AND scroll position on unmount. This is the only
  // reliable way on iOS Safari WebViews.
  useEffect(() => {
    const scrollY = window.scrollY;
    const prevOverflow = document.body.style.overflow;
    const prevPosition = document.body.style.position;
    const prevTop = document.body.style.top;
    const prevWidth = document.body.style.width;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = '100%';
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.position = prevPosition;
      document.body.style.top = prevTop;
      document.body.style.width = prevWidth;
      document.body.style.overflow = prevOverflow;
      // Restore the scroll position the user was at when they opened
      // the sheet. Without this, iOS visually jumps to the top.
      window.scrollTo(0, scrollY);
    };
  }, []);

  // Suppress the global swipe-back gesture while the sheet is open.
  // The emoji quick-react row, the reply font picker, and the comment
  // list itself all generate horizontal-ish swipes that the global
  // swipe-back handler would otherwise catch and pop the user out of
  // DreadFeed entirely. Reference-counted via the same helpers the post
  // editor uses.
  useEffect(() => {
    beginSuppressSwipeBack();
    return () => { endSuppressSwipeBack(); };
  }, []);

  // Track whether the scrollable comment list is at the very top. The
  // drag-to-dismiss handler only kicks in when scrollTop is 0; otherwise
  // a downward drag is just normal scrolling. IG works exactly this way.
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const isListAtTopRef = useRef(true);
  const onListScroll = (e: React.UIEvent<HTMLDivElement>) => {
    isListAtTopRef.current = (e.currentTarget.scrollTop || 0) <= 0;
  };

  // Touch handlers for drag-to-dismiss. v1.11 expanded these from the
  // top handle area to the whole panel — the user can grab anywhere
  // inside the sheet and pull down. But we only ACTUALLY start a drag
  // if either (a) the inner comment list is scrolled to the very top
  // (so we're not stealing a scroll-up gesture), OR (b) the touch
  // landed somewhere that's not the scrollable list itself (like the
  // emoji row or composer). Combining those two rules gives the IG
  // feel: scroll comments normally, OR drag anywhere else to dismiss.
  const dragLandedOnListRef = useRef(false);
  const onTouchStartHandle = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    dragStartYRef.current = e.touches[0].clientY;
    // Did the touch land on (or inside) the scrollable list? If so we
    // gate on isListAtTop. If not, we always allow the drag.
    const target = e.target as HTMLElement;
    const list = listScrollRef.current;
    dragLandedOnListRef.current = !!(list && (list === target || list.contains(target)));
  };
  const onTouchMoveHandle = (e: React.TouchEvent) => {
    if (dragStartYRef.current === null || e.touches.length !== 1) return;
    const dy = e.touches[0].clientY - dragStartYRef.current;
    // Only drag downward (positive dy). Negative just gets ignored.
    if (dy <= 0) return;
    // If the touch started inside the comment list and that list is
    // not at scroll-top, this is a normal scroll gesture — leave it
    // alone, don't translate the sheet.
    if (dragLandedOnListRef.current && !isListAtTopRef.current) return;
    setDragY(dy);
  };
  const onTouchEndHandle = () => {
    const dy = dragY;
    dragStartYRef.current = null;
    dragLandedOnListRef.current = false;
    setDragY(0);
    if (dy > 120) {
      // Past dismiss threshold — animate close.
      animateClose();
    }
  };

  // Initial load — fetch comments and seed the parent's count.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      // Fetch comments + hidden set in parallel, then filter out any
      // comments authored by handles the viewer has blocked. Comments
      // by blocked users never appear in the sheet at all.
      const [list, hidden] = await Promise.all([
        apiFetchComments(post.id),
        getHiddenSet(currentHandle),
      ]);
      if (cancelled) return;
      const visible = list.filter((c) => !hidden.has((c.handle || '').toLowerCase()));
      setComments(visible);
      setLoading(false);
      // Count reported to parent reflects visible-to-viewer count, not
      // server total. That matches IG behavior (blocked content is
      // invisible everywhere) and keeps the badge accurate to UX.
      onCountChange(visible.length);

      // Fetch like status for each comment in parallel. Skip silently
      // if there's no handle (anonymous viewer).
      if (currentHandle && visible.length > 0) {
        const results = await Promise.all(
          visible.map((c) => apiCommentLikeStatus({ commentId: c.id, handle: currentHandle }))
        );
        if (cancelled) return;
        const map = new Map<string, { liked: boolean; count: number }>();
        visible.forEach((c, i) => {
          map.set(c.id, { liked: results[i].liked, count: results[i].count });
        });
        setCommentLikes(map);
      } else {
        // No handle — seed counts from the comment records themselves.
        const map = new Map<string, { liked: boolean; count: number }>();
        list.forEach((c) => map.set(c.id, { liked: false, count: c.likeCount || 0 }));
        setCommentLikes(map);
      }
    })();
    return () => { cancelled = true; };
  }, [post.id, currentHandle]);

  // Animated close — flip `closing`, wait for transition, then unmount.
  const animateClose = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(() => onClose(), 260); // matches CSS transition duration
  };

  // Send a new comment to the server. Optimistically prepends to the
  // local list, rolls back on failure.
  const submit = async () => {
    const body = draft.trim();
    if (!body || !currentHandle || !deviceId || submitting) return;
    setSubmitting(true);
    const tempId = `temp_${Date.now()}`;
    // If we're in reply mode, capture the parentId so it lands on both
    // the optimistic row and the server request. Clearing replyingTo
    // happens after we read it, so a re-render mid-submit doesn't drop
    // the link.
    const parentIdForThisSubmit = replyingTo ? replyingTo.parentId : null;
    const optimistic: SocialComment = {
      id: tempId,
      postId: post.id,
      parentId: parentIdForThisSubmit,
      handle: currentHandle,
      body,
      createdAt: new Date().toISOString(),
      likeCount: 0,
    };
    setComments((prev) => [...prev, optimistic]);
    setCommentLikes((prev) => {
      const next = new Map(prev);
      next.set(tempId, { liked: false, count: 0 });
      return next;
    });
    setDraft('');
    // If this was a reply, auto-expand the parent so the user sees their
    // own reply appear in context instead of being hidden behind the
    // "View N replies" toggle.
    if (parentIdForThisSubmit) {
      setExpandedReplies((prev) => {
        const next = new Set(prev);
        next.add(parentIdForThisSubmit);
        return next;
      });
    }
    setReplyingTo(null);

    const result = await apiCreateComment({
      postId: post.id,
      handle: currentHandle,
      deviceId,
      body,
      parentId: parentIdForThisSubmit,
    });
    setSubmitting(false);

    if (!result.ok || !result.comment) {
      // Roll back optimistic insert.
      setComments((prev) => prev.filter((c) => c.id !== tempId));
      setCommentLikes((prev) => {
        const next = new Map(prev);
        next.delete(tempId);
        return next;
      });
      showToast(`Comment failed: ${result.reason || 'unknown'}`, 'error');
      setDraft(body); // restore the user's text so they don't retype
      return;
    }

    // Swap the temp comment for the server's real one (real id, etc).
    const real = result.comment;
    setComments((prev) => prev.map((c) => (c.id === tempId ? real : c)));
    setCommentLikes((prev) => {
      const next = new Map(prev);
      next.delete(tempId);
      next.set(real.id, { liked: false, count: 0 });
      return next;
    });
    onCountChange(comments.length + 1);
    playCommentSent();
  };

  // Toggle a heart on a single comment.
  const toggleCommentLike = async (commentId: string) => {
    if (!currentHandle || !deviceId) {
      showToast('Claim a handle to like comments', 'error');
      return;
    }
    const current = commentLikes.get(commentId);
    const prevLiked = !!current?.liked;
    const prevCount = current?.count || 0;
    // Sound on LIKE only, not unlike.
    if (!prevLiked) playLikeBlip();
    // Optimistic
    setCommentLikes((prev) => {
      const next = new Map(prev);
      next.set(commentId, { liked: !prevLiked, count: prevCount + (prevLiked ? -1 : 1) });
      return next;
    });
    const result = await apiToggleCommentLike({ commentId, handle: currentHandle, deviceId });
    if (!result.ok) {
      // Revert
      setCommentLikes((prev) => {
        const next = new Map(prev);
        next.set(commentId, { liked: prevLiked, count: prevCount });
        return next;
      });
      showToast(result.reason || 'Like failed', 'error');
    } else if (typeof result.count === 'number') {
      setCommentLikes((prev) => {
        const next = new Map(prev);
        next.set(commentId, { liked: !!result.liked, count: result.count });
        return next;
      });
    }
  };

  // Quick emoji row above the input. Tapping inserts the emoji into the
  // draft at the cursor position (or end if no cursor — simpler). v1.11
  // expanded from 8 generic emojis (hearts/smileys) to a 20-emoji horror
  // set that fits the app's tone. The row is horizontally scrollable in
  // the render so we can keep adding without the row wrapping.
  const QUICK_EMOJIS = ['💀', '👻', '👁️', '🩸', '🕯️', '🪦', '🦇', '🕷️', '🕸️', '🧛', '🧟', '🔪', '⚰️', '🎃', '🌙', '🖤', '🩻', '🧠', '🦴', '🛸'];
  const insertEmoji = (emoji: string) => setDraft((prev) => prev + emoji);

  // Body of the sheet. Combines backdrop + sliding panel. The backdrop
  // catches taps outside the panel for dismiss.
  const isAuthor = (handle: string) => handle.toLowerCase() === post.handle.toLowerCase();

  // Build the inline transform — start at 100% off-screen, slide in, then
  // track drag if user is pulling down, then animate to 100% on close.
  const translateY = closing
    ? '100%'
    : mounted
      ? `${dragY}px`
      : '100%';

  return createPortal(
    <div style={S.commentSheetOverlay}>
      {/* Backdrop — tap dismisses */}
      <div
        style={S.commentSheetBackdrop}
        onClick={animateClose}
      />
      {/* Sliding panel — touch handlers attached at panel level so the
          user can drag anywhere inside the sheet (not just the top
          handle) to dismiss. The handlers themselves gate on whether
          the touch landed on the scrollable comment list AND whether
          that list is currently at scrollTop=0; otherwise it's just a
          normal scroll gesture. */}
      <div
        style={{
          ...S.commentSheetPanel,
          transform: `translateY(${translateY})`,
          transition: dragStartYRef.current === null ? 'transform 0.26s cubic-bezier(0.32, 0.72, 0, 1)' : 'none',
        }}
        onTouchStart={onTouchStartHandle}
        onTouchMove={onTouchMoveHandle}
        onTouchEnd={onTouchEndHandle}
      >
        {/* Drag handle area — visual indicator only now. The touch
            handlers live on the panel above, not here. */}
        <div style={S.commentSheetHandleArea}>
          <div style={S.commentSheetHandlePill} />
        </div>

        {/* Header — title centered, share icon on right (placeholder, no
            handler yet — present for visual parity with IG) */}
        <div style={S.commentSheetHeader}>
          <div style={{ width: 40 }} />
          <div style={S.commentSheetTitle}>Comments</div>
          <button onClick={animateClose} style={S.commentSheetCloseBtn} aria-label="Close">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>

        {/* Scrollable comment list. ref + onScroll feed the drag-dismiss
            logic so we can tell whether a downward drag here should
            dismiss the sheet or just be normal scrolling. */}
        <div
          ref={listScrollRef}
          onScroll={onListScroll}
          style={S.commentSheetList}
        >
          {loading ? (
            <div style={S.commentSheetEmpty}>Loading…</div>
          ) : comments.length === 0 ? (
            <div style={S.commentSheetEmpty}>
              No comments yet.
              <br />
              <span style={{ opacity: 0.6, fontSize: 13 }}>Be the first to comment.</span>
            </div>
          ) : (() => {
            // Split into top-level vs replies. We keep both in stable
            // chronological order (oldest-first) since the server already
            // sorts that way; we just group replies under their parent.
            // Comments with a parentId that doesn't match any top-level
            // comment in the visible set (e.g. parent was hidden by a
            // block) fall through to render as top-level so they're not
            // lost.
            const visibleIds = new Set(comments.map((c) => c.id));
            const topLevel: SocialComment[] = [];
            const repliesByParent = new Map<string, SocialComment[]>();
            for (const c of comments) {
              if (c.parentId && visibleIds.has(c.parentId)) {
                const arr = repliesByParent.get(c.parentId) || [];
                arr.push(c);
                repliesByParent.set(c.parentId, arr);
              } else {
                topLevel.push(c);
              }
            }

            const renderCommentRow = (c: SocialComment, isReply: boolean) => {
              const likeState = commentLikes.get(c.id) || { liked: false, count: c.likeCount || 0 };
              const isOwnComment = !!currentHandle && currentHandle.toLowerCase() === (c.handle || '').toLowerCase();
              return (
                <div
                  key={c.id}
                  style={{
                    ...S.commentRow,
                    // Indent replies. paddingLeft on the row pushes the avatar
                    // and everything else right, IG-style nested look.
                    ...(isReply ? { paddingLeft: 56 } : null),
                  }}
                >
                  <img src={exposureIconUrl} alt="" style={isReply ? S.commentAvatarReply : S.commentAvatar} />
                  <div style={S.commentBodyCol}>
                    <div style={S.commentMetaLine}>
                      <span style={S.commentHandle}>{c.handle}</span>
                      <span style={S.commentTime}>{formatTimeAgoShort(c.createdAt)}</span>
                      {isAuthor(c.handle) && (
                        <span style={S.commentAuthorBadge}>Author</span>
                      )}
                    </div>
                    <div style={S.commentBodyText}>{c.body}</div>
                    {/* Reply link — visible on every comment (top-level OR
                        reply). Replies-to-replies are flattened by the
                        server, but the UX of replying to a specific person
                        in a thread still feels natural. We prefill the
                        composer with @handle to give the new comment
                        social context. */}
                    {!!currentHandle && (
                      <button
                        type="button"
                        onClick={() => {
                          // For replies, we want the threading to attach
                          // to the same ROOT as the comment being replied
                          // to. parentId on a reply already points at
                          // root; on a top-level it's null, so use the
                          // comment's own id.
                          const rootId = c.parentId || c.id;
                          setReplyingTo({ parentId: rootId, handle: c.handle });
                          // Prefill draft with @handle if not already
                          // there, leaving a trailing space so the user
                          // can start typing immediately.
                          setDraft((prev) => {
                            const tag = `@${c.handle} `;
                            return prev.includes(tag) ? prev : tag;
                          });
                        }}
                        style={S.commentReplyBtn}
                      >Reply</button>
                    )}
                  </div>
                  <button
                    onClick={() => toggleCommentLike(c.id)}
                    style={S.commentLikeBtn}
                    aria-label={likeState.liked ? 'Unlike comment' : 'Like comment'}
                  >
                    {likeState.liked ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="#FF3B5C" stroke="#FF3B5C" strokeWidth="1.8" strokeLinejoin="round">
                        <path d="M12 21s-7.5-4.6-9.5-9.5C1 7.5 4 4 7.5 4c2 0 3.4 1 4.5 2.5C13.1 5 14.5 4 16.5 4 20 4 23 7.5 21.5 11.5 19.5 16.4 12 21 12 21Z" />
                      </svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#888888" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 21s-7.5-4.6-9.5-9.5C1 7.5 4 4 7.5 4c2 0 3.4 1 4.5 2.5C13.1 5 14.5 4 16.5 4 20 4 23 7.5 21.5 11.5 19.5 16.4 12 21 12 21Z" />
                      </svg>
                    )}
                    {likeState.count > 0 && (
                      <span style={S.commentLikeCount}>{likeState.count}</span>
                    )}
                  </button>
                  {!isOwnComment && (
                    <button
                      onClick={() => setMenuCommentId(c.id)}
                      style={S.commentMenuBtn}
                      aria-label="More options"
                    >⋯</button>
                  )}
                </div>
              );
            };

            return topLevel.map((c) => {
              const replies = repliesByParent.get(c.id) || [];
              const isExpanded = expandedReplies.has(c.id);
              return (
                <div key={c.id}>
                  {renderCommentRow(c, false)}
                  {replies.length > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setExpandedReplies((prev) => {
                            const next = new Set(prev);
                            if (next.has(c.id)) next.delete(c.id);
                            else next.add(c.id);
                            return next;
                          });
                        }}
                        style={S.commentRepliesToggle}
                      >
                        <span style={S.commentRepliesToggleLine} />
                        {isExpanded
                          ? `Hide replies`
                          : `View ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`}
                      </button>
                      {isExpanded && replies.map((r) => renderCommentRow(r, true))}
                    </>
                  )}
                </div>
              );
            });
          })()}
        </div>

        {/* Emoji quick-react row */}
        <div style={S.commentSheetEmojiRow}>
          {QUICK_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              onClick={() => insertEmoji(emoji)}
              style={S.commentSheetEmojiBtn}
            >
              {emoji}
            </button>
          ))}
        </div>

        {/* "Replying to @X" pill — shown only when replyingTo is set.
            Tapping the X clears the reply state and the @prefix from
            the draft, returning the composer to top-level mode. */}
        {replyingTo && (
          <div style={S.commentReplyPill}>
            <span style={S.commentReplyPillText}>Replying to <span style={S.commentReplyPillHandle}>@{replyingTo.handle}</span></span>
            <button
              type="button"
              onClick={() => {
                setReplyingTo(null);
                // Strip the @handle prefix if it's still at the start of
                // the draft. Leave any text the user typed after it.
                setDraft((prev) => {
                  const tag = `@${replyingTo.handle} `;
                  return prev.startsWith(tag) ? prev.slice(tag.length) : prev;
                });
              }}
              style={S.commentReplyPillClose}
              aria-label="Cancel reply"
            >✕</button>
          </div>
        )}

        {/* Composer row — avatar + input + Post button */}
        <div style={S.commentSheetComposer}>
          <img src={exposureIconUrl} alt="" style={S.commentSheetComposerAvatar} />
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={currentHandle ? (replyingTo ? `Reply to ${replyingTo.handle}...` : `Add a comment for ${post.handle}...`) : 'Claim a handle to comment'}
            disabled={!currentHandle || submitting}
            maxLength={500}
            style={S.commentSheetComposerInput}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {draft.trim().length > 0 && (
            <button
              onClick={submit}
              disabled={submitting}
              style={S.commentSheetComposerPostBtn}
            >
              {submitting ? '...' : (replyingTo ? 'Reply' : 'Post')}
            </button>
          )}
        </div>

        {/* 3-dot action sheet for a comment row. Open state holds the
            comment id; the matching comment is looked up below to feed
            the Block/Report actions with the right handle/target. */}
        {menuCommentId && (() => {
          const target = comments.find((c) => c.id === menuCommentId);
          if (!target) return null;
          return (
            <ActionSheet
              onClose={() => setMenuCommentId(null)}
              actions={[
                {
                  label: 'Report comment',
                  onClick: () => {
                    if (!currentHandle || !deviceId) {
                      showToast('Claim a handle to report', 'error');
                      return;
                    }
                    setReportComment(target);
                  },
                  destructive: true,
                },
                {
                  label: `Block @${target.handle}`,
                  onClick: async () => {
                    if (!currentHandle || !deviceId) {
                      showToast('Claim a handle to block', 'error');
                      return;
                    }
                    const result = await apiBlock({
                      blocker: currentHandle,
                      blocked: target.handle,
                      deviceId,
                    });
                    if (result.ok) {
                      invalidateHiddenSet();
                      // Immediately remove blocked user's comments from
                      // the visible list so the sheet reflects the action.
                      setComments((prev) =>
                        prev.filter((c) => (c.handle || '').toLowerCase() !== target.handle.toLowerCase())
                      );
                      showToast(`Blocked @${target.handle}`, 'success');
                    } else {
                      showToast(result.reason || 'Block failed', 'error');
                    }
                  },
                  destructive: true,
                },
              ]}
            />
          );
        })()}

        {/* Comment Report modal — opens when user picks Report from the
            action sheet for a non-own comment. */}
        {reportComment && currentHandle && deviceId && (
          <ReportModal
            targetType="comment"
            targetId={reportComment.id}
            handle={currentHandle}
            deviceId={deviceId}
            onClose={() => setReportComment(null)}
            onReported={() => {
              setReportComment(null);
              showToast('Thanks — report sent', 'success');
            }}
          />
        )}
      </div>
    </div>,
    document.body
  );
}


// Instagram-style compact relative-time formatter. "5m" / "3h" / "1d" /
// "2w". No "ago" suffix, no spelling out — just unit-letter pairs.
function formatTimeAgoShort(iso: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  const secs = Math.max(0, (Date.now() - t) / 1000);
  if (secs < 60) return 'now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 52) return `${weeks}w`;
  return `${Math.floor(weeks / 52)}y`;
}

// Compact relative-time formatter. "5m ago", "3h ago", "2d ago".
function formatTimeAgo(iso: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  const secs = Math.max(0, (Date.now() - t) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

// Shared brand header for every eXposure screen (Feed, Search, Post-tab,
// Profile, Post Detail, and other-user profiles). Sticky black bar with
// the eXposure brand on top and a short tagline below — keeps the
// app's identity visible no matter where you've drilled in.
// DreadFeed brand header with optional notification bell on the right.
// Bell shows a red dot when unreadCount > 0. Tap routes to NotificationsView.
function ExposureBrandHeader({ unreadCount, dmUnreadCount, onTapBell, onTapInbox }: {
  unreadCount?: number;
  dmUnreadCount?: number;
  onTapBell?: () => void;
  onTapInbox?: () => void;
} = {}) {
  return (
    <div style={S.exposureBrandHeader}>
      <div style={S.exposureBrandTitleRow}>
        <div
          style={S.exposureBrandTitle}
          className="sinister-glitch"
          data-text="DreadFeed"
        >
          DreadFeed
        </div>
      </div>
      {/* Right side icons: bell (notifications) + airplane (DMs). The
          airplane (v1.15) sits to the left of the bell. Both render only
          if their on-tap handler is provided. */}
      {onTapInbox && (
        <button
          onClick={onTapInbox}
          style={S.exposureInboxBtn}
          aria-label={dmUnreadCount && dmUnreadCount > 0 ? `Messages (${dmUnreadCount} unread)` : 'Messages'}
        >
          {/* IG-style paper-airplane glyph */}
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
          {!!dmUnreadCount && dmUnreadCount > 0 && (
            <span style={S.exposureBellBadge}>
              {dmUnreadCount > 99 ? '99+' : String(dmUnreadCount)}
            </span>
          )}
        </button>
      )}
      {onTapBell && (
        <button
          onClick={onTapBell}
          style={S.exposureBellBtn}
          aria-label={unreadCount && unreadCount > 0 ? `Notifications (${unreadCount} unread)` : 'Notifications'}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
          {!!unreadCount && unreadCount > 0 && (
            <span style={S.exposureBellBadge}>
              {unreadCount > 99 ? '99+' : String(unreadCount)}
            </span>
          )}
        </button>
      )}
    </div>
  );
}

// ---------- User Profile (per-handle eXposure profile) ----------
// Instagram-style profile page. Same template for every handle — the
// user's own profile (from the eXposure Profile tab) and any other
// handle tapped from a post card both render this view.
//
// Layout (top to bottom):
//   1. Header bar — @handle centered, neon purple in Jolly Lodger
// ---- CaptionWithTags (v1.14) ----
// Splits a caption string into plain text + tappable hashtag spans. Used
// in feed cards and post-detail captions. The regex matches the same
// shape the server extracts: # followed by 2-30 word chars, at start or
// preceded by whitespace. Render-only — does not mutate the caption.
function CaptionWithTags({
  text,
  onTagTap,
  baseStyle,
  tagStyle,
}: {
  text: string;
  onTagTap?: (tag: string) => void;
  baseStyle?: React.CSSProperties;
  tagStyle?: React.CSSProperties;
}) {
  // Tokenize. Walk the string; every match becomes a tag span, every gap
  // becomes a text span. Preserve whitespace by including the leading
  // separator char inside the text span (split-at-match approach).
  const re = /(^|\s)#([A-Za-z0-9_]{2,30})/g;
  const parts: Array<{ kind: 'text'; value: string } | { kind: 'tag'; value: string }> = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const matchStart = m.index;
    const sep = m[1];           // leading whitespace or empty
    const tag = m[2];
    const textBefore = text.slice(lastIdx, matchStart) + sep;
    if (textBefore) parts.push({ kind: 'text', value: textBefore });
    parts.push({ kind: 'tag', value: tag });
    lastIdx = matchStart + m[0].length;
  }
  if (lastIdx < text.length) parts.push({ kind: 'text', value: text.slice(lastIdx) });

  // No hashtags — render plain text in one span. Avoids a wrapper.
  if (parts.length === 0 || parts.every((p) => p.kind === 'text')) {
    return <span style={baseStyle}>{text}</span>;
  }

  return (
    <span style={baseStyle}>
      {parts.map((p, i) => {
        if (p.kind === 'text') return <span key={i}>{p.value}</span>;
        return (
          <button
            key={i}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (onTagTap) onTagTap(p.value);
            }}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              margin: 0,
              color: '#3FA9FF',
              cursor: 'pointer',
              font: 'inherit',
              ...tagStyle,
            }}
          >
            #{p.value}
          </button>
        );
      })}
    </span>
  );
}

// ---------- CaptionExpander ----------
// IG-style caption with 2-line truncate + inline "more" affordance.
// Tapping "more" expands the caption in place — does NOT navigate to
// the comments sheet (previous bug). Once expanded, stays expanded for
// the lifetime of the component (no "less" toggle, matching IG).
//
// Implementation: render with -webkit-line-clamp: 2 by default; measure
// scrollHeight vs clientHeight after layout to decide whether the
// "more" button is needed. Captions short enough to fit in 2 lines
// never show "more". Re-measures if the text changes (e.g. caption
// edit in the future).
function CaptionExpander({
  caption,
  onTagTap,
  handleElement,
  baseStyle,
}: {
  caption: string;
  onTagTap?: (tag: string) => void;
  // Rendered inline before the caption (the bold @handle button). Kept
  // as a prop so the layout stays a single inline flow — line-clamp
  // counts the handle width when wrapping.
  handleElement: React.ReactNode;
  baseStyle?: React.CSSProperties;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Measure once after layout, and again if the caption changes. Using
  // useLayoutEffect so the measurement happens BEFORE the browser
  // paints — avoids a single-frame flash of "more" appearing.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // scrollHeight > clientHeight means the line-clamp is hiding text.
    // Add a 1px slop because sub-pixel rounding occasionally lies.
    setOverflowing(el.scrollHeight - el.clientHeight > 1);
  }, [caption]);

  const clampStyle: React.CSSProperties = expanded
    ? {}
    : {
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      };

  return (
    <div style={{ ...baseStyle, ...clampStyle }} ref={ref}>
      {handleElement}
      {' '}
      <CaptionWithTags text={caption} onTagTap={onTagTap} />
      {!expanded && overflowing && (
        <>
          {' '}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(true);
            }}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              margin: 0,
              color: '#8A8A8A',
              cursor: 'pointer',
              font: 'inherit',
            }}
          >
            more
          </button>
        </>
      )}
    </div>
  );
}

// ---- HashtagView (v1.14) ----
// Dedicated screen shown when the user taps a hashtag anywhere in the
// app (feed caption, post detail caption, etc). Loads /posts/hashtag/:tag
// and renders the IG-style 3-column thumbnail grid. Tap a thumbnail to
// open the post in the standard post detail view.
function HashtagView({
  tag,
  onSelectPost,
  onBack,
}: {
  tag: string;
  onSelectPost: (postId: string, postList?: string[], preloadedPosts?: SocialPost[]) => void;
  onBack: () => void;
}) {
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetchPostsByHashtag(tag).then((p) => {
      if (cancelled) return;
      setPosts(p);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [tag]);

  return (
    <div style={S.hashtagViewWrap}>
      {/* Header — back arrow + #tag title + count */}
      <div style={S.hashtagHeader}>
        <button
          type="button"
          onClick={onBack}
          style={S.hashtagBackBtn}
          aria-label="Back"
        >
          ←
        </button>
        <div style={S.hashtagHeaderText}>
          <div style={S.hashtagHeaderTitle}>#{tag}</div>
          <div style={S.hashtagHeaderSub}>
            {loading ? 'Loading…' : `${posts.length} ${posts.length === 1 ? 'post' : 'posts'}`}
          </div>
        </div>
      </div>

      {/* Grid — same 3-column shape as profile grid */}
      {!loading && posts.length === 0 ? (
        <div style={S.hashtagEmpty}>
          No posts yet for #{tag}.
        </div>
      ) : (
        <div style={S.profileGrid}>
          {posts.map((p) => {
            const firstType =
              (Array.isArray((p as any).mediaTypes) && (p as any).mediaTypes[0]) ||
              (/\.(mp4|mov)(\?|$)/i.test(p.photoUrl) ? 'video' : 'photo');
            const isVideo = firstType === 'video';
            const isYouTube = !!p.youtubeId;
            return (
              <button
                key={p.id}
                onClick={() => onSelectPost(p.id, posts.map((x) => x.id), posts)}
                style={S.profileGridCell}
                aria-label={`Open post: ${p.caption.slice(0, 40)}`}
              >
                {isYouTube ? (
                  <>
                    <img
                      src={`https://i.ytimg.com/vi/${p.youtubeId}/hqdefault.jpg`}
                      alt=""
                      style={S.profileGridImg}
                      loading="lazy"
                    />
                    <div style={S.profileGridVideoBadge} aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="#ffffff">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </div>
                  </>
                ) : isVideo ? (
                  <>
                    <video
                      src={`${p.photoUrl}#t=0.1`}
                      style={S.profileGridImg}
                      preload="metadata"
                      muted
                      playsInline
                      onLoadedMetadata={(e) => {
                        try { e.currentTarget.currentTime = 0.1; } catch { /* silent */ }
                      }}
                    />
                    <div style={S.profileGridVideoBadge} aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="#ffffff">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </div>
                  </>
                ) : (
                  <img src={p.photoUrl} alt="" style={S.profileGridImg} loading="lazy" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- DMInboxView (v1.15) ----
// IG-style inbox screen. Lists every conversation the current user has,
// newest activity first. Tap a row → opens DMThreadView. Polls inbox
// every 8 seconds while open so new messages show up without manual
// refresh. (Polling, not WebSockets — keeps the server stateless.)
function DMInboxView({
  currentHandle,
  deviceId,
  onSelectThread,
  onBack,
}: {
  currentHandle: string;
  deviceId: string;
  onSelectThread: (convId: string, otherHandle: string) => void;
  onBack: () => void;
}) {
  const [conversations, setConversations] = useState<DMConversation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const list = await apiFetchInbox(currentHandle);
      if (cancelled) return;
      setConversations(list);
      setLoading(false);
    };
    load();
    const id = window.setInterval(load, 8000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [currentHandle]);

  return (
    <div style={S.hashtagViewWrap}>
      <div style={S.hashtagHeader}>
        <button type="button" onClick={onBack} style={S.hashtagBackBtn} aria-label="Back">←</button>
        <div style={S.hashtagHeaderText}>
          <div style={S.hashtagHeaderTitle}>Messages</div>
          <div style={S.hashtagHeaderSub}>
            {loading ? 'Loading…' : `${conversations.length} ${conversations.length === 1 ? 'conversation' : 'conversations'}`}
          </div>
        </div>
      </div>

      {!loading && conversations.length === 0 ? (
        <div style={S.hashtagEmpty}>
          No messages yet. Go to someone's profile and tap Message to start a conversation.
        </div>
      ) : (
        <div style={S.dmInboxList}>
          {conversations.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelectThread(c.id, c.otherHandle)}
              style={S.dmInboxRow}
            >
              <div style={S.dmInboxAvatar}>
                {c.otherHandle.slice(0, 1).toUpperCase()}
              </div>
              <div style={S.dmInboxBody}>
                <div style={S.dmInboxHandle}>{c.otherHandle}</div>
                <div style={{
                  ...S.dmInboxPreview,
                  ...(c.unread > 0 ? S.dmInboxPreviewUnread : null),
                }}>
                  {c.lastMessageBy && c.lastMessageBy.toLowerCase() === currentHandle.toLowerCase()
                    ? `You: ${c.lastMessageText || ''}`
                    : (c.lastMessageText || 'No messages yet')}
                </div>
              </div>
              {c.unread > 0 && (
                <div style={S.dmInboxBadge}>{c.unread}</div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- DMThreadView (v1.15) ----
// 1:1 conversation view — message bubbles + composer at the bottom.
// Polls every 4 seconds while open to pick up new incoming messages.
// Sending appends locally (optimistic) and re-fetches on confirm.
function DMThreadView({
  conversationId,
  otherHandle: initialOtherHandle,
  currentHandle,
  deviceId,
  onBack,
}: {
  conversationId: string;
  otherHandle: string;
  currentHandle: string;
  deviceId: string;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<DMMessage[]>([]);
  const [otherHandle, setOtherHandle] = useState(initialOtherHandle);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // v1.16: track the last server-side message ID we've seen so the
  // polling effect can detect freshly-arrived incoming messages and
  // play a receive sound. Initial fetch should NOT chime — only deltas
  // after the first load do.
  const lastSeenIdRef = useRef<string | null>(null);
  const firstLoadDoneRef = useRef(false);

  // Initial load + polling.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const r = await apiFetchThread(conversationId, currentHandle);
      if (cancelled) return;
      // Detect new incoming messages from the OTHER party since last
      // poll. We only chime for messages whose ID we hadn't seen before
      // AND that aren't from us. Skip the very first load so opening
      // a thread doesn't chime for backlog.
      if (firstLoadDoneRef.current) {
        const latest = r.messages.length > 0 ? r.messages[r.messages.length - 1] : null;
        if (latest
          && latest.id !== lastSeenIdRef.current
          && latest.from.toLowerCase() !== currentHandle.toLowerCase()
          && !latest.id.startsWith('local_')) {
          playBell();
        }
      }
      if (r.messages.length > 0) {
        lastSeenIdRef.current = r.messages[r.messages.length - 1].id;
      }
      firstLoadDoneRef.current = true;
      setMessages(r.messages);
      if (r.otherHandle) setOtherHandle(r.otherHandle);
      setLoading(false);
    };
    load();
    const id = window.setInterval(load, 4000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [conversationId, currentHandle]);

  // Auto-scroll to bottom when messages change.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  const canSend = draft.trim().length > 0 && draft.trim().length <= 2000 && !sending;

  const onSend = async () => {
    if (!canSend) return;
    const body = draft.trim();
    setSending(true);
    // v1.16: play send sound immediately on tap, mirrors comment-send
    // behavior. Optimistic UI = instant audio + instant visual append.
    playCommentSent();
    // Optimistic append — gives instant feedback. We don't generate a
    // proper ID; server will return the real one on the next poll.
    setMessages((prev) => [...prev, {
      id: `local_${Date.now()}`,
      from: currentHandle.toLowerCase(),
      body,
      createdAt: new Date().toISOString(),
    }]);
    setDraft('');
    const result = await apiSendDM({ handle: currentHandle, deviceId, toHandle: otherHandle, body });
    setSending(false);
    if (!result.ok) {
      // Roll back the optimistic append on failure.
      setMessages((prev) => prev.filter((m) => !m.id.startsWith('local_')));
      showToast(`Send failed: ${result.reason || 'unknown error'}`, 'error');
    }
    // Otherwise the next 4s poll picks up the real message and replaces
    // the local one (it'll dedupe naturally because server messages have
    // real IDs).
  };

  return (
    <div style={S.dmThreadWrap}>
      <div style={S.hashtagHeader}>
        <button type="button" onClick={onBack} style={S.hashtagBackBtn} aria-label="Back">←</button>
        <div style={S.hashtagHeaderText}>
          <div style={S.hashtagHeaderTitle}>{otherHandle}</div>
        </div>
      </div>

      <div ref={scrollRef} style={S.dmThreadScroll}>
        {loading ? (
          <div style={S.hashtagEmpty}>Loading…</div>
        ) : messages.length === 0 ? (
          <div style={S.hashtagEmpty}>
            No messages yet. Say hi!
          </div>
        ) : (
          messages.map((m) => {
            const isOwn = m.from.toLowerCase() === currentHandle.toLowerCase();
            return (
              <div
                key={m.id}
                style={{
                  ...S.dmBubbleRow,
                  justifyContent: isOwn ? 'flex-end' : 'flex-start',
                }}
              >
                <div style={{
                  ...S.dmBubble,
                  ...(isOwn ? S.dmBubbleOwn : S.dmBubbleOther),
                }}>
                  {m.body}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div style={S.dmComposer}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message..."
          maxLength={2000}
          rows={1}
          style={S.dmComposerInput}
          disabled={sending}
          // Stop touch propagation so horizontal scroll/drag doesn't
          // trigger swipe-back while the user is in the textarea.
          onTouchStart={(e) => e.stopPropagation()}
        />
        <button
          type="button"
          onClick={onSend}
          disabled={!canSend}
          style={{
            ...S.dmComposerSend,
            opacity: canSend ? 1 : 0.4,
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

// ---- UserProfileView ----
// Profile screen for a single handle. Shows:
//   1. Header — large avatar on left, Posts/Visits counts on right
//   2. Bio line
//   3. Action row — "View Badges" button (and a Share button placeholder)
//   4. Tab strip — single grid icon for now (active)
//   5. 3-column square grid of approved post thumbnails
//   6. Tap a thumbnail → opens single-post detail view
//
// Data sources:
//   - GET /badges/:handle for visit count
//   - GET /posts/handle/:handle for the grid
function UserProfileView({ profileHandle, currentHandle, deviceId, sites, onSelectSite, onSelectBadges, onSelectPost, onSelectHandle, onSelectDMThread, onSelectExposureTab, onSelectSettings, onBack, embedded }: {
  profileHandle: string;
  currentHandle: string | null;
  deviceId: string | null;
  sites: SinisterSite[];
  onSelectSite: (site: SinisterSite) => void;
  onSelectBadges: (handle: string) => void;
  onSelectPost: (postId: string, postList?: string[], preloadedPosts?: SocialPost[]) => void;
  // Tapping a handle inside the followers/following list sheet — routes
  // to that handle's profile. Required so the sheet doesn't just close
  // with no nav.
  onSelectHandle: (handle: string) => void;
  // v1.15: open a DM thread with a specific handle. Called by the
  // Message button on other users' profiles. Optional because the
  // embedded profile in your own DreadFeed Profile tab doesn't surface
  // a Message button (you can't DM yourself).
  onSelectDMThread?: (conversationId: string, otherHandle: string) => void;
  // Optional — only passed when this view is dispatched as a standalone
  // route (e.g. tapped @handle from a feed card). Embedded inside the
  // DreadFeed profile tab, the parent SocialView handles tab nav itself.
  onSelectExposureTab?: (tab: 'feed' | 'search' | 'post' | 'profile') => void;
  // Optional — opens the Settings screen from a gear icon shown only on
  // the current user's own profile. Plumbed through SocialView when
  // embedded; not used on standalone profile views.
  onSelectSettings?: () => void;
  onBack: () => void;
  embedded?: boolean;
}) {
  const [stats, setStats] = useState<{ visitCount: number; submitCount: number; badgeCount: number } | null>(null);
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [loading, setLoading] = useState(true);
  // The profile's current avatar URL (raw server form — 'library:xxx',
  // full https URL, or null). Resolved via resolveAvatarUrl() at render
  // time. Fetched on mount and refreshed when the user (if it's their
  // own profile) picks a new avatar from the picker.
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  // Display name / bio / link — IG-style profile fields. Fetched on
  // mount alongside the avatar via /handles/profile/:handle. Editable
  // on own profile via EditProfileModal.
  const [displayName, setDisplayName] = useState<string>('');
  const [bio, setBio] = useState<string>('');
  const [link, setLink] = useState<string>('');
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  // Follow status: follower count, following count, and whether the
  // current user follows the profile being viewed. Loaded from
  // /follows/status/:target on mount.
  const [followStatus, setFollowStatus] = useState<FollowStatus>({ followedByYou: false, followerCount: 0, followingCount: 0 });
  const [followBusy, setFollowBusy] = useState(false);
  // Which handle-list sheet (if any) is open. null when closed.
  const [listSheet, setListSheet] = useState<'followers' | 'following' | null>(null);
  // Block state — derived from the viewer's hidden set on mount.
  // Toggling flips immediately and persists via apiBlock / apiUnblock.
  const [isBlocked, setIsBlocked] = useState(false);
  const [blockBusy, setBlockBusy] = useState(false);
  // Avatar picker visibility. Only relevant on your own profile.
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);

  const isMe = !!currentHandle && currentHandle.toLowerCase() === profileHandle.toLowerCase();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      // Fetch badge stats + posts + follow status + hidden set + profile
      // (which carries displayName, bio, link, avatarUrl) in parallel.
      const [badgeData, handlePosts, fStatus, hidden, profile] = await Promise.all([
        apiGetBadges(profileHandle),
        apiFetchPostsByHandle(profileHandle),
        apiFollowStatus({ target: profileHandle, handle: currentHandle }),
        getHiddenSet(currentHandle),
        apiGetProfile(profileHandle),
      ]);
      if (cancelled) return;
      setStats({
        visitCount: badgeData.visitCount,
        submitCount: badgeData.submitCount,
        badgeCount: badgeData.badges.length,
      });
      setPosts(handlePosts);
      setFollowStatus(fStatus);
      setIsBlocked(hidden.has(profileHandle.toLowerCase()));
      if (profile) {
        setAvatarUrl(profile.avatarUrl);
        setDisplayName(profile.displayName || '');
        setBio(profile.bio || '');
        setLink(profile.link || '');
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [profileHandle, currentHandle]);

  // Toggle block — flips state, calls the appropriate API, invalidates
  // the hidden-set cache so feeds reflect immediately. If a viewer
  // blocks someone they're currently following, the follow row stays
  // server-side (server doesn't auto-unfollow on block); the block
  // alone is enough to hide their content.
  const toggleBlock = async () => {
    if (isMe || !currentHandle || !deviceId || blockBusy) return;
    setBlockBusy(true);
    const result = isBlocked
      ? await apiUnblock({ blocker: currentHandle, blocked: profileHandle, deviceId })
      : await apiBlock({ blocker: currentHandle, blocked: profileHandle, deviceId });
    if (result.ok) {
      invalidateHiddenSet();
      setIsBlocked(!isBlocked);
      showToast(isBlocked ? `Unblocked @${profileHandle}` : `Blocked @${profileHandle}`, 'success');
    } else {
      showToast(result.reason || 'Action failed', 'error');
    }
    setBlockBusy(false);
  };

  // Toggle follow on the profile being viewed. Optimistic update — the
  // button flips immediately, counts adjust, and we revert if the
  // server rejects.
  const toggleFollow = async () => {
    if (isMe) return;
    if (!currentHandle || !deviceId) {
      showToast('Claim a handle to follow people', 'error');
      return;
    }
    if (followBusy) return;
    setFollowBusy(true);

    const prev = followStatus;
    // Optimistic: flip the local state.
    setFollowStatus({
      followedByYou: !prev.followedByYou,
      followerCount: prev.followerCount + (prev.followedByYou ? -1 : 1),
      followingCount: prev.followingCount,
    });

    const result = prev.followedByYou
      ? await apiUnfollow({ follower: currentHandle, target: profileHandle, deviceId })
      : await apiFollow({ follower: currentHandle, target: profileHandle, deviceId });

    if (!result.ok) {
      // Revert
      setFollowStatus(prev);
      showToast(result.reason || 'Could not update follow', 'error');
    } else if (!prev.followedByYou) {
      // Newly followed — same audible feedback as a like, IG-style.
      playLikeBlip();
    }
    setFollowBusy(false);
  };

  // Mark variables as intentionally unused — they're part of the
  // standard profile prop bag but this layout doesn't surface them.
  // (sites is used indirectly via onSelectSite; deviceId is reserved
  // for future actions like "Edit profile" or following.)
  void sites; void onSelectSite; void onSelectBadges; void stats;

  return (
    <div style={embedded ? { paddingBottom: 80 } : S.socialViewWrap}>
      {/* Brand header only when standalone — when embedded inside the
          eXposure tab, SocialView already renders it above. */}
      {!embedded && <ExposureBrandHeader />}

      {/* Settings gear — only shown on YOUR OWN profile and only when
          this view is embedded in the DreadFeed Profile tab (settings
          isn't reachable from a standalone profile view because that
          flow is for viewing others). */}
      {isMe && embedded && onSelectSettings && (
        <div style={S.profileSettingsBar}>
          <button
            onClick={onSelectSettings}
            style={S.profileSettingsBtn}
            aria-label="Settings"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      )}

      {/* ---- IG-style profile row: big avatar + stats ----
          Avatar is wrapped in profileAvatarWrap (no overflow clipping)
          so the +badge can poke outside the circle. The actual clipped
          circle is profileAvatarCircle inside. Badge sits as a sibling
          of the circle so it's not clipped. */}
      <div style={S.profileTopRow}>
        <div style={S.profileAvatarWrap}>
          {isMe ? (
            <button
              onClick={() => setAvatarPickerOpen(true)}
              style={S.profileAvatarEditBtn}
              aria-label="Change avatar"
            >
              <div style={S.profileAvatarCircle}>
                <img
                  src={resolveAvatarUrl(avatarUrl) || exposureIconUrl}
                  alt=""
                  style={S.profileAvatarImg}
                />
              </div>
              <span style={S.profileAvatarEditBadge}>＋</span>
            </button>
          ) : (
            <div style={S.profileAvatarCircle}>
              <img
                src={resolveAvatarUrl(avatarUrl) || exposureIconUrl}
                alt=""
                style={S.profileAvatarImg}
              />
            </div>
          )}
        </div>
        <div style={S.profileStatsCluster}>
          {/* Posts count — not tappable; shows the count of approved
              posts for this handle. */}
          <div style={S.profileStatItem}>
            <div style={S.profileStatNum}>{posts.length}</div>
            <div style={S.profileStatLabel}>Posts</div>
          </div>
          {/* Followers — tappable, opens the follower list sheet. */}
          <button
            onClick={() => setListSheet('followers')}
            style={{ ...S.profileStatItem, cursor: 'pointer', background: 'transparent', border: 'none' }}
            aria-label="View followers"
          >
            <div style={S.profileStatNum}>{followStatus.followerCount}</div>
            <div style={S.profileStatLabel}>Followers</div>
          </button>
          {/* Following — tappable, opens the following list sheet. */}
          <button
            onClick={() => setListSheet('following')}
            style={{ ...S.profileStatItem, cursor: 'pointer', background: 'transparent', border: 'none' }}
            aria-label="View following"
          >
            <div style={S.profileStatNum}>{followStatus.followingCount}</div>
            <div style={S.profileStatLabel}>Following</div>
          </button>
        </div>
      </div>

      {/* ---- Display name / bio (placeholder until handles get bios) ---- */}
      {/* ---- Display name / bio / link block ---- */}
      <div style={S.profileBioWrap}>
        {/* Display name — falls back to the handle if not set. Always
            renders so the layout doesn't jump when an empty profile
            saves its first display name. */}
        <div style={S.profileDisplayName}>{displayName || profileHandle}</div>
        {/* Bio — only renders if present. Multi-line, preserves
            newlines via whitespace: pre-wrap. */}
        {bio && <div style={S.profileBio}>{bio}</div>}
        {/* Link — only renders if present. Opens externally. */}
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            style={S.profileLink}
          >
            {link.replace(/^https?:\/\/(www\.)?/, '')}
          </a>
        )}
      </div>

      {/* ---- Action button row (IG-style) ---- */}
      {/* For your own profile: Edit profile + Share Profile side by side.
          For someone else's: Follow / Following toggle + Share Profile + Block. */}
      <div style={S.profileActionsRow}>
        {isMe ? (
          <button
            onClick={() => setEditProfileOpen(true)}
            style={{ ...S.profileActionBtn, flex: 1 }}
          >
            Edit profile
          </button>
        ) : (
          <button
            onClick={toggleFollow}
            disabled={followBusy}
            style={followStatus.followedByYou ? S.profileFollowingBtn : S.profileFollowBtn}
          >
            {followStatus.followedByYou ? 'Following' : 'Follow'}
          </button>
        )}
        {/* Message button (v1.15) — only on other people's profiles when
            you have a handle and the viewer hasn't blocked them. Opens a
            DM thread with this user; if no conversation exists yet, the
            thread view shows an empty state until the first message is
            sent. */}
        {!isMe && currentHandle && deviceId && onSelectDMThread && !isBlocked && (
          <button
            onClick={() => {
              const convId = dmConversationId(currentHandle, profileHandle);
              onSelectDMThread(convId, profileHandle);
            }}
            style={{ ...S.profileActionBtn, flex: 1 }}
          >
            Message
          </button>
        )}
        <button
          onClick={() => {
            // Lightweight share: copy a "view my profile" line. No
            // deep-link scheme yet, so just put the handle on the
            // clipboard. Good enough as a v1 — wire to a proper share
            // sheet once profile URLs exist.
            try {
              navigator.clipboard.writeText(`@${profileHandle} on The Dread Directory`);
              showToast('Copied to clipboard', 'success');
            } catch {
              showToast('Could not copy', 'error');
            }
          }}
          style={{ ...S.profileActionBtn, flex: 1 }}
        >
          Share Profile
        </button>
        {/* Block / Unblock — only on other people's profiles. Visually
            de-emphasized vs Follow so it doesn't dominate the row; this
            is a destructive control most users never touch. */}
        {!isMe && currentHandle && deviceId && (
          <button
            onClick={toggleBlock}
            disabled={blockBusy}
            style={S.profileBlockBtn}
            aria-label={isBlocked ? 'Unblock user' : 'Block user'}
          >
            {isBlocked ? 'Unblock' : 'Block'}
          </button>
        )}
      </div>

      {/* Followers / Following list sheet — opens when a stat is tapped.
          Tapping a row routes to that handle's profile via onSelectHandle. */}
      {listSheet && (
        <HandleListSheet
          mode={listSheet}
          forHandle={profileHandle}
          currentHandle={currentHandle}
          onClose={() => setListSheet(null)}
          onSelectHandle={(h) => {
            setListSheet(null);
            // Don't re-navigate if the user tapped themselves.
            if (h.toLowerCase() === profileHandle.toLowerCase()) return;
            onSelectHandle(h);
          }}
        />
      )}


      {/* ---- Tab strip (only grid for now, but kept for IG familiarity) ---- */}
      <div style={S.profileTabStrip}>
        <div style={S.profileTabActive}>
          {/* 3x3 grid icon */}
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="3" width="6" height="6" />
            <rect x="11" y="3" width="6" height="6" />
            <rect x="3" y="11" width="6" height="6" />
            <rect x="11" y="11" width="6" height="6" />
            <rect x="3" y="19" width="0.1" height="0.1" />
          </svg>
        </div>
      </div>

      {/* ---- The grid itself ---- */}
      {loading ? (
        <div style={S.socialEmpty}>Loading…</div>
      ) : posts.length === 0 ? (
        <div style={S.socialEmpty}>
          {isMe ? 'You haven\u2019t posted to DreadFeed yet.' : 'No posts yet.'}
          <br />
          <span style={{ opacity: 0.7, fontSize: 13 }}>
            {isMe ? 'Visit a site and tap "Post to DreadFeed" to share.' : 'Check back later.'}
          </span>
        </div>
      ) : (
        <div style={S.profileGrid}>
          {posts.map((p) => {
            // Detect video posts. Server sends mediaTypes parallel to
            // photoUrls; if not present (pre-v1.13 posts), default to
            // photo. We also sniff the URL extension as a fallback for
            // posts whose mediaTypes got dropped somewhere along the
            // way. For the grid we only care about the FIRST slot —
            // carousels show their cover here.
            const firstType =
              (Array.isArray((p as any).mediaTypes) && (p as any).mediaTypes[0]) ||
              (/\.(mp4|mov)(\?|$)/i.test(p.photoUrl) ? 'video' : 'photo');
            const isVideo = firstType === 'video';
            const isYouTube = !!p.youtubeId;
            return (
              <button
                key={p.id}
                onClick={() => onSelectPost(p.id, posts.map((x) => x.id), posts)}
                style={S.profileGridCell}
                aria-label={`Open post: ${p.caption.slice(0, 40)}`}
              >
                {isYouTube ? (
                  // YouTube grid thumbnail. hqdefault is the safest size —
                  // available for every video and renders the same 16:9
                  // aspect cropped to the grid cell.
                  <>
                    <img
                      src={`https://i.ytimg.com/vi/${p.youtubeId}/hqdefault.jpg`}
                      alt=""
                      style={S.profileGridImg}
                      loading="lazy"
                    />
                    <div style={S.profileGridVideoBadge} aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="#ffffff">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </div>
                  </>
                ) : isVideo ? (
                  // Static first-frame thumbnail. preload="metadata"
                  // tells the browser to fetch just enough bytes for
                  // the poster frame, NOT the whole video. No autoplay,
                  // no controls — this is a grid thumbnail, not a
                  // player. Tap goes to the full post view where it
                  // plays properly.
                  <>
                    <video
                      // Append #t=0.1 to the URL — iOS Safari treats this
                      // as a media fragment "seek to 0.1s on load" and
                      // renders that frame as the poster. Without this,
                      // mobile Safari shows a black frame until the user
                      // presses play (which we don't want here — it's a
                      // grid thumbnail, never played in place).
                      src={`${p.photoUrl}#t=0.1`}
                      style={S.profileGridImg}
                      preload="metadata"
                      muted
                      playsInline
                      // Belt-and-suspenders: if the hash trick is ignored
                      // for any reason, force a tiny seek once metadata
                      // is available. Either path renders the first
                      // frame.
                      onLoadedMetadata={(e) => {
                        try { e.currentTarget.currentTime = 0.1; } catch { /* silent */ }
                      }}
                    />
                    {/* ▶ overlay in the corner so users see it's a video */}
                    <div style={S.profileGridVideoBadge} aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="#ffffff">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </div>
                  </>
                ) : (
                  <img src={p.photoUrl} alt="" style={S.profileGridImg} loading="lazy" />
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Render the DreadFeed bottom bar only when this view is dispatched
          standalone (e.g. tapped @handle from a feed card). When embedded
          inside the DreadFeed Profile tab, SocialView already renders the
          bar so doubling it up would stack two bars. */}
      {!embedded && onSelectExposureTab && (
        <ExposureBottomBar
          active="profile"
          onSelect={(tab) => {
            if (tab === 'post') {
              // Post composer requires SocialView's GPS + nearest-site
              // logic; route to feed instead.
              onSelectExposureTab('feed');
              return;
            }
            onSelectExposureTab(tab);
          }}
        />
      )}

      {/* Avatar picker — only mounted when the user (on their own
          profile) tapped the edit badge. Library tab + Upload tab.
          On successful change, the picker calls onChanged with the
          new server-form URL so the profile updates without a refetch. */}
      {avatarPickerOpen && isMe && currentHandle && deviceId && (
        <AvatarPickerModal
          handle={currentHandle}
          deviceId={deviceId}
          currentAvatarUrl={avatarUrl}
          onClose={() => setAvatarPickerOpen(false)}
          onChanged={(newUrl) => {
            setAvatarUrl(newUrl);
            setAvatarPickerOpen(false);
            showToast('Avatar updated', 'success');
          }}
        />
      )}

      {/* Edit profile modal — only mounted when the user taps Edit profile
          on their own profile. Saves displayName/bio/link; on success
          the local state updates immediately so the view reflects the
          change without a refetch. */}
      {editProfileOpen && isMe && currentHandle && deviceId && (
        <EditProfileModal
          handle={currentHandle}
          deviceId={deviceId}
          initialDisplayName={displayName}
          initialBio={bio}
          initialLink={link}
          onClose={() => setEditProfileOpen(false)}
          onSaved={(p) => {
            setDisplayName(p.displayName);
            setBio(p.bio);
            setLink(p.link);
            setEditProfileOpen(false);
            showToast('Profile updated', 'success');
          }}
        />
      )}
    </div>
  );
}


// ---------- Avatar Picker Modal ----------
// Upload-only avatar picker. User taps "Choose photo", picks an image
// from their camera roll, server resizes to 256x256 JPEG + strips EXIF
// + stores in R2. "Reset to default" reverts to the placeholder.
//
// Calls onChanged(newServerUrl) on success — caller updates its avatar
// state without a refetch. Server URLs come back as full https://...
// (custom upload) or null (default).
function AvatarPickerModal({ handle, deviceId, currentAvatarUrl, onClose, onChanged }: {
  handle: string;
  deviceId: string;
  currentAvatarUrl: string | null;
  onClose: () => void;
  onChanged: (newUrl: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const hasCustom = !!(currentAvatarUrl && currentAvatarUrl.startsWith('http'));

  const onFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files && e.target.files[0];
    // Reset the input so picking the same file twice in a row still fires.
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!file) return;
    if (busy) return;
    setBusy(true);
    setErr(null);
    const r = await apiUploadAvatar({ handle, deviceId, photo: file });
    setBusy(false);
    if (!r.ok) {
      setErr(r.reason || 'Upload failed.');
      return;
    }
    onChanged(r.avatarUrl ?? null);
  };

  const onRemove = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    const r = await apiRemoveAvatar({ handle, deviceId });
    setBusy(false);
    if (!r.ok) {
      setErr(r.reason || 'Failed to remove avatar.');
      return;
    }
    onChanged(null);
  };

  return createPortal(
    <div style={S.avatarPickerBackdrop} onClick={onClose}>
      <div style={S.avatarPickerSheet} onClick={(e) => e.stopPropagation()}>
        <div style={S.avatarPickerHeader}>
          <button onClick={onClose} style={S.avatarPickerCancelBtn}>Cancel</button>
          <div style={S.avatarPickerTitle}>Change avatar</div>
          <div style={{ width: 60 }} />
        </div>

        {err && <div style={S.avatarPickerErr}>{err}</div>}

        <div style={S.avatarPickerUploadPane}>
          <div style={S.avatarPickerUploadHint}>
            Pick a photo from your camera roll. We'll resize and crop it
            to a square. Avatars are public — don't upload anything you
            don't want others to see.
          </div>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            style={S.avatarPickerUploadBtn}
          >{busy ? 'Uploading…' : 'Choose photo'}</button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={onFilePicked}
            style={{ display: 'none' }}
          />
        </div>

        {hasCustom && (
          <button
            onClick={onRemove}
            disabled={busy}
            style={S.avatarPickerRemoveBtn}
          >Reset to default</button>
        )}
      </div>
    </div>,
    document.body
  );
}

// ---------- NotificationsView ----------
// Standalone screen showing all of the user's likes/follows/comments
// notifications, newest first. Tapping a row routes to the relevant
// destination (post for likes/comments, profile for follows).
// Mark-read is called on mount so the bell badge clears.
function NotificationsView({ handle, deviceId, onSelectHandle, onSelectPost, onBack }: {
  handle: string;
  deviceId: string;
  onSelectHandle: (handle: string) => void;
  onSelectPost: (postId: string) => void;
  onBack: () => void;
}) {
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const resp = await apiFetchNotifications(handle);
      if (cancelled) return;
      setItems(resp ? resp.notifications : []);
      setLoading(false);
      // Mark all as read in the background so the bell clears next poll.
      apiMarkNotificationsRead({ handle, deviceId }).catch(() => { /* silent */ });
    })();
    return () => { cancelled = true; };
  }, [handle, deviceId]);

  return (
    <div style={S.notifWrap}>
      <div style={S.notifHeader}>
        <button onClick={onBack} style={S.notifBackBtn} aria-label="Back">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div style={S.notifHeaderTitle}>Notifications</div>
        <div style={{ width: 40 }} />
      </div>

      {loading ? (
        <div style={S.notifEmpty}>Loading…</div>
      ) : !items || items.length === 0 ? (
        <div style={S.notifEmpty}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🔕</div>
          <div>No notifications yet.</div>
          <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6 }}>
            You'll see likes, follows, and comments here.
          </div>
        </div>
      ) : (
        <div style={S.notifList}>
          {items.map((n) => (
            <NotificationRow
              key={n.id}
              item={n}
              onSelectHandle={onSelectHandle}
              onSelectPost={onSelectPost}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NotificationRow({ item, onSelectHandle, onSelectPost }: {
  item: NotificationItem;
  onSelectHandle: (handle: string) => void;
  onSelectPost: (postId: string) => void;
}) {
  // Tapping the row routes contextually: likes/comments → the post,
  // follows → the actor's profile. Avatar is always tappable to actor.
  const onRowTap = () => {
    if ((item.type === 'liked_post' || item.type === 'commented') && item.postId) {
      onSelectPost(item.postId);
    } else {
      onSelectHandle(item.actor);
    }
  };

  const verb = item.type === 'liked_post'
    ? 'liked your post'
    : item.type === 'commented'
      ? `commented: ${item.commentSnippet || ''}`
      : 'started following you';

  return (
    <button
      onClick={onRowTap}
      style={{ ...S.notifRow, ...(item.unread ? S.notifRowUnread : {}) }}
    >
      <button
        onClick={(e) => { e.stopPropagation(); onSelectHandle(item.actor); }}
        style={S.notifAvatarBtn}
        aria-label={`${item.actor} profile`}
      >
        <img
          src={resolveAvatarUrl(item.actorAvatarUrl) || exposureIconUrl}
          alt=""
          style={S.notifAvatarImg}
        />
      </button>
      <div style={S.notifBodyCol}>
        <div style={S.notifBodyText}>
          <span style={S.notifActorName}>{item.actor}</span>
          <span style={S.notifVerb}> {verb}</span>
        </div>
        <div style={S.notifTime}>{formatTimeAgoShort(item.createdAt)}</div>
      </div>
      {item.postThumbUrl && (
        <img src={item.postThumbUrl} alt="" style={S.notifThumb} />
      )}
    </button>
  );
}

// ---------- Edit Profile Modal ----------
// Three editable fields: display name, bio, link. Each maps 1:1 to
// the server's /handles/profile/update endpoint. Cancel discards
// unsaved changes; Save validates client-side then submits. Server
// also validates — client validation is just for fast feedback.
function EditProfileModal({ handle, deviceId, initialDisplayName, initialBio, initialLink, onClose, onSaved }: {
  handle: string;
  deviceId: string;
  initialDisplayName: string;
  initialBio: string;
  initialLink: string;
  onClose: () => void;
  onSaved: (p: { displayName: string; bio: string; link: string }) => void;
}) {
  const DISPLAY_NAME_MAX = 30;
  const BIO_MAX = 150;

  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [bio, setBio] = useState(initialBio);
  const [link, setLink] = useState(initialLink);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onSave = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    const r = await apiUpdateProfile({
      handle,
      deviceId,
      displayName,
      bio,
      link,
    });
    setBusy(false);
    if (!r.ok || !r.profile) {
      setErr(r.reason || 'Save failed.');
      return;
    }
    onSaved({
      displayName: r.profile.displayName,
      bio: r.profile.bio,
      link: r.profile.link,
    });
  };

  return createPortal(
    <div style={S.editProfileBackdrop} onClick={onClose}>
      <div style={S.editProfileSheet} onClick={(e) => e.stopPropagation()}>
        <div style={S.editProfileHeader}>
          <button onClick={onClose} style={S.editProfileCancelBtn}>Cancel</button>
          <div style={S.editProfileTitle}>Edit profile</div>
          <button onClick={onSave} disabled={busy} style={S.editProfileSaveBtn}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>

        {err && <div style={S.editProfileErr}>{err}</div>}

        <div style={S.editProfileBody}>
          <div style={S.editProfileFieldLabel}>Display name</div>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value.slice(0, DISPLAY_NAME_MAX))}
            placeholder="Your name"
            style={S.editProfileInput}
            maxLength={DISPLAY_NAME_MAX}
          />
          <div style={S.editProfileCounter}>{displayName.length} / {DISPLAY_NAME_MAX}</div>

          <div style={S.editProfileFieldLabel}>Bio</div>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value.slice(0, BIO_MAX))}
            placeholder="Tell people about yourself"
            style={S.editProfileTextarea}
            rows={4}
            maxLength={BIO_MAX}
          />
          <div style={S.editProfileCounter}>{bio.length} / {BIO_MAX}</div>

          <div style={S.editProfileFieldLabel}>Link</div>
          <input
            type="url"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="youtube.com/@yourchannel"
            style={S.editProfileInput}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <div style={S.editProfileHint}>
            We'll add https:// if you leave it off.
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ---------- Handle List Sheet ----------
// IG-style bottom sheet showing a list of handles (followers or
// following). Same slide-up animation + dismiss patterns as the
// CommentSheet. Tapping a handle row currently just closes the sheet
// — full @handle navigation from inside the sheet would need extra
// plumbing to thread `setView` down here, deferred for now.
function HandleListSheet({ mode, forHandle, currentHandle, onClose, onSelectHandle }: {
  mode: 'followers' | 'following';
  forHandle: string;
  currentHandle: string | null;
  onClose: () => void;
  onSelectHandle: (handle: string) => void;
}) {
  const [list, setList] = useState<HandleEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [mounted, setMounted] = useState(false);
  const [closing, setClosing] = useState(false);
  const [dragY, setDragY] = useState(0);
  const dragStartYRef = useRef<number | null>(null);

  void currentHandle; // reserved for future "Follow back" indicators

  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const data = mode === 'followers'
        ? await apiFollowers(forHandle)
        : await apiFollowing(forHandle);
      if (cancelled) return;
      setList(data);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [mode, forHandle]);

  const animateClose = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(() => onClose(), 260);
  };

  const onTouchStartHandle = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    dragStartYRef.current = e.touches[0].clientY;
  };
  const onTouchMoveHandle = (e: React.TouchEvent) => {
    if (dragStartYRef.current === null || e.touches.length !== 1) return;
    const dy = e.touches[0].clientY - dragStartYRef.current;
    if (dy > 0) setDragY(dy);
  };
  const onTouchEndHandle = () => {
    const dy = dragY;
    dragStartYRef.current = null;
    setDragY(0);
    if (dy > 120) animateClose();
  };

  const translateY = closing ? '100%' : mounted ? `${dragY}px` : '100%';
  const title = mode === 'followers' ? 'Followers' : 'Following';

  return createPortal(
    <div style={S.commentSheetOverlay}>
      <div style={S.commentSheetBackdrop} onClick={animateClose} />
      <div
        style={{
          ...S.commentSheetPanel,
          transform: `translateY(${translateY})`,
          transition: dragStartYRef.current === null ? 'transform 0.26s cubic-bezier(0.32, 0.72, 0, 1)' : 'none',
        }}
      >
        <div
          style={S.commentSheetHandleArea}
          onTouchStart={onTouchStartHandle}
          onTouchMove={onTouchMoveHandle}
          onTouchEnd={onTouchEndHandle}
        >
          <div style={S.commentSheetHandlePill} />
        </div>
        <div style={S.commentSheetHeader}>
          <div style={{ width: 40 }} />
          <div style={S.commentSheetTitle}>{title}</div>
          <div style={{ width: 40 }} />
        </div>
        <div style={S.commentSheetList}>
          {loading ? (
            <div style={S.commentSheetEmpty}>Loading…</div>
          ) : list.length === 0 ? (
            <div style={S.commentSheetEmpty}>
              {mode === 'followers' ? 'No followers yet.' : 'Not following anyone yet.'}
            </div>
          ) : (
            list.map((entry) => (
              <button
                key={entry.handle}
                onClick={() => onSelectHandle(entry.handle)}
                style={S.handleListRow}
              >
                <img src={exposureIconUrl} alt="" style={S.commentAvatar} />
                <div style={S.commentBodyCol}>
                  <div style={S.commentHandle}>{entry.handle}</div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ---------- Single Post Detail ----------
// Opened when the user taps a thumbnail in a profile grid. Renders all
// of the profile's posts as a native vertical scrollable feed, scrolled
// to the tapped post on mount. Up/down navigation is just native scroll
// — same smooth momentum scrolling as the eXposure feed. Swipe-right
// pops back to the profile via the standard back gesture.
//
// Why a feed instead of a single card with snap-swipe handlers?
//   The previous implementation tried to detect vertical swipes and
//   navigate between posts by re-mounting the view. That worked but felt
//   "snappy" — discrete jumps instead of the continuous scroll users
//   expect from IG. A native scrollable feed gets momentum, inertia, and
//   rubber-banding for free, and matches the eXposure feed sub-tab.
//
// Preloaded posts arrive from the caller (UserProfileView already has
// them). Falls back to fetching when no preload is available (e.g. deep
// link in the future).
function PostDetailView({ postId, postList, preloadedPosts, currentHandle, deviceId, sites, onSelectSite, onSelectHandle, onSelectHashtag, onSelectExposureTab, onBack }: {
  postId: string;
  postList?: string[];
  preloadedPosts?: SocialPost[];
  currentHandle: string | null;
  deviceId: string | null;
  sites: SinisterSite[];
  onSelectSite: (site: SinisterSite) => void;
  onSelectHandle: (handle: string) => void;
  onSelectHashtag: (tag: string) => void;
  onSelectExposureTab: (tab: 'feed' | 'search' | 'post' | 'profile') => void;
  onBack: () => void;
}) {
  // If the caller preloaded the post objects, use them directly — no
  // network round-trip needed. Otherwise fall back to fetching just the
  // target post by id.
  const [posts, setPosts] = useState<SocialPost[]>(preloadedPosts || []);
  const [loading, setLoading] = useState(!preloadedPosts || preloadedPosts.length === 0);

  // Refs keyed by post id so we can scroll the right card into view on
  // mount. data-postid attribute is the lookup mechanism — simpler than
  // managing a Map of refs.
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (preloadedPosts && preloadedPosts.length > 0) return;
    // No preload — fetch just the one post.
    let cancelled = false;
    (async () => {
      setLoading(true);
      const p = await apiFetchPost(postId);
      if (cancelled) return;
      setPosts(p ? [p] : []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [postId, preloadedPosts]);

  // After the feed renders, scroll the target post's card into view.
  // 'auto' (not 'smooth') because we want it to land instantly — the
  // user tapped a thumbnail and expects to see that post, not watch it
  // scroll to itself.
  useEffect(() => {
    if (loading || posts.length === 0) return;
    // Wait one paint so layout is settled before measuring.
    const id = requestAnimationFrame(() => {
      const root = containerRef.current;
      if (!root) return;
      const target = root.querySelector(`[data-postid="${postId}"]`) as HTMLElement | null;
      if (target) {
        target.scrollIntoView({ block: 'start', behavior: 'auto' });
      }
    });
    return () => cancelAnimationFrame(id);
  }, [loading, posts, postId]);

  const siteById = useMemo(() => {
    const m = new Map<string, SinisterSite>();
    for (const s of sites) m.set(s.id, s);
    return m;
  }, [sites]);

  // Ensure we only render posts that are part of postList (if provided)
  // and in postList's order. Defensive — preloadedPosts SHOULD already
  // match, but this guarantees ordering and filters out anything weird.
  const orderedPosts = useMemo(() => {
    if (!postList || postList.length === 0) return posts;
    const byId = new Map<string, SocialPost>();
    for (const p of posts) byId.set(p.id, p);
    const out: SocialPost[] = [];
    for (const id of postList) {
      const p = byId.get(id);
      if (p) out.push(p);
    }
    return out.length > 0 ? out : posts;
  }, [postList, posts]);

  void onBack; // swipe-right gesture handles back

  return (
    <div style={S.socialViewWrap} ref={containerRef}>
      <ExposureBrandHeader />

      {loading ? (
        <div style={S.socialEmpty}>Loading…</div>
      ) : orderedPosts.length === 0 ? (
        <div style={S.socialEmpty}>
          Post not found.
          <br />
          <span style={{ opacity: 0.7, fontSize: 13 }}>
            It may have been removed.
          </span>
        </div>
      ) : (
        <div style={{ ...S.socialFeed, paddingBottom: 80 }}>
          {orderedPosts.map((p) => (
            <div key={p.id} data-postid={p.id}>
              <SocialPostCard
                post={p}
                currentHandle={currentHandle}
                deviceId={deviceId}
                onSiteTap={() => {
                  const s = siteById.get(p.siteId);
                  if (s) onSelectSite(s);
                }}
                onHandleTap={() => onSelectHandle(p.handle)}
                onHashtagTap={(tag) => onSelectHashtag(tag)}
              />
            </div>
          ))}
        </div>
      )}

      {/* Reuse the eXposure bottom bar so navigation feels continuous
          while viewing a post. Tapping any tab returns to the eXposure
          tab; the parent dispatcher sets the sub-tab memory first so we
          land on the right sub-screen rather than flickering through
          'feed'. The Post tab dispatches as 'feed' since there's no
          composer accessible from outside SocialView — it would need
          GPS + nearest-site logic to open. */}
      <ExposureBottomBar
        active="profile"
        onSelect={(tab) => {
          if (tab === 'post') {
            // Post-composer isn't reachable from this view (it requires
            // SocialView's GPS + nearest-site logic). Route to feed
            // instead — user can hit Post again from there.
            onSelectExposureTab('feed');
            return;
          }
          onSelectExposureTab(tab);
        }}
      />
    </div>
  );
}


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
    for (const cat of VISIBLE_CATEGORIES) {
      const allowed = new Set<CategoryKey>(categoriesForKey(cat.key));
      const count = sites.filter(s => allowed.has(s.category as CategoryKey) && siteMatches(s)).length;
      if (count > 0) rows.push({ cat, count });
    }
    return rows;
  }, [sites, q]);

  // Level 2: list of states for the chosen category, with matching counts.
  const stateRows = useMemo(() => {
    if (level.kind !== 'states') return [];
    const allowed = new Set<CategoryKey>(categoriesForKey(level.category));
    const filtered = sites.filter(s => allowed.has(s.category as CategoryKey) && siteMatches(s));
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
      .filter(s => {
        const allowed = new Set<CategoryKey>(categoriesForKey(level.category));
        return allowed.has(s.category as CategoryKey) && s.state === level.state && siteMatches(s);
      })
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
            style={S.localeSearchInput}
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
                return (
                  <button
                    key={cat.key}
                    style={S.listCategoryRow}
                    onClick={() => { playSubDrop(); setLevel({ kind: 'states', category: cat.key }); }}
                  >
                    <span style={S.listRowDot} />
                    <span style={S.listRowTitle}>{cat.label}</span>
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
                return stateRows.map(({ state, count }) => (
                  <button
                    key={state}
                    style={S.listRow}
                    onClick={() => { playSubDrop(); setLevel({ kind: 'sites', category: level.category, state }); }}
                  >
                    <span style={S.listRowDot} />
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
                return siteRows.map((site) => (
                  <button
                    key={site.id}
                    style={S.listRow}
                    onClick={() => { playSubDrop(); onSelectSite(site); }}
                  >
                    <span style={S.listRowDot} />
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

function HomeView({ sites, onSelectCategory, onSelectSite, onSubmit, onAbout, onLeaders, onList }: {
  sites: SinisterSite[];
  onSelectCategory: (key: CategoryKey) => void;
  onSelectSite: (site: SinisterSite) => void;
  onSubmit: () => void;
  onAbout: () => void;
  onLeaders: () => void;
  onList: () => void;
}) {
  // onSubmit + onLeaders are kept in the prop bag for back-compat with
  // the dispatcher signature but are no longer rendered inside HomeView
  // (Submit moved to the bottom bar; Dread Leaders was removed entirely).
  void onSubmit; void onLeaders;
  const counts: Record<string, number> = {};
  for (const s of sites) counts[s.category] = (counts[s.category] || 0) + 1;
  // Use VISIBLE_CATEGORIES so hidden categories (UFO, serial killers,
  // grave sites) don't appear in the home filmstrip. Data stays intact;
  // we're only filtering the home grid display.
  const ordered = [...VISIBLE_CATEGORIES].sort((a, b) => a.gridIndex - b.gridIndex);

  // For categories that absorb others on the home page (True Crime
  // absorbing Serial Killers), sum the counts so the badge reflects the
  // merged total. Anything not in CATEGORY_HOME_MERGE just uses its own
  // count.
  const mergedCount = (key: CategoryKey): number => {
    const keys = categoriesForKey(key);
    return keys.reduce((sum, k) => sum + (counts[k] || 0), 0);
  };

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
    count: mergedCount(cat.key),
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

      {/* Latest Submission spotlight — sits fixed above the home bottom
          bar where the SUBMIT A LOCATION button used to live. Drew moved
          submit to the bottom-bar icon, freeing this prime real estate
          to surface the freshest community contribution. Tapping it opens
          that location's detail page. */}
      <div style={S.spotlightFixedWrap}>
        <LatestSubmissionSpotlight sites={sites} onSelectSite={onSelectSite} />
      </div>
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
  // Site counts per state for this category. Honors CATEGORY_HOME_MERGE
  // so True Crime's counts include serial killer sites.
  const counts: Record<string, number> = {};
  const allowedCats = new Set<CategoryKey>(categoriesForKey(category));
  for (const s of sites) {
    if (allowedCats.has(s.category as CategoryKey)) counts[s.state] = (counts[s.state] || 0) + 1;
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
                    fontSize: 18,
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
        <p style={S.aboutCreatedBy}>
          Created by <b>Drew Krotzer</b>
        </p>

        <div style={S.aboutDonateBlock}>
          <div style={S.aboutDonateHeader}>Please consider donating</div>
          <p style={S.aboutDonatePara}>
            The Dread Directory was built by one person and is offered completely free —
            no ads, no paywalls, no subscriptions. Every site, every story, every feature
            is here because I love this stuff and wanted to put it in your pocket.
          </p>
          <p style={S.aboutDonatePara}>
            If the app brings you a moment of dread, a fun night out, or a story you didn't
            know was buried in your own neighborhood, a small donation helps keep the
            servers running, the map updated, and new locations rolling in. Every dollar
            goes back into the app.
          </p>
          <a
            href="https://www.paypal.com/donate/?hosted_button_id=S2MWGSUQNR5YS"
            target="_blank"
            rel="noopener noreferrer"
            style={S.aboutDonateBtn}
          >
            Donate via PayPal
          </a>
        </div>

        <p style={S.aboutPara}>
          <b>The Dread Directory</b> is a field guide to the macabre — historic crimes, hauntings, and
          horror film locations hiding all around you.
        </p>

        <div style={S.aboutSectionHeader}>What this app does</div>

        <p style={S.aboutPara}>
          <b>Notifies you when you're near a Dread Location.</b> The app runs in the background and pings
          you when you come within range of a haunting, crime scene, or other macabre location — even when
          the app is closed. Set location access to "Always" for this to work.
        </p>
        <p style={S.aboutPara}>
          <b>Tells the story behind every location.</b> Each site has its full history, exact coordinates,
          and turn-by-turn directions in your maps app.
        </p>
        <p style={S.aboutPara}>
          <b>Lets you add your own locations.</b> Found a Dread Location we don't have? Submit it while
          you're physically on-site — the app verifies your GPS and requires an on-site photo.
        </p>
        <p style={S.aboutPara}>
          <b>DreadFeed.</b> An in-app social feed for posting horror photos, captioning your visits,
          commenting, and reacting to other users' posts.
        </p>

        <div style={S.aboutSectionHeader}>Getting started</div>

        <p style={S.aboutPara}>
          <b>1. Just open the app.</b> No account needed to browse Dread Locations, see the map, or read
          DreadFeed. Jump in and look around.
        </p>
        <p style={S.aboutPara}>
          <b>2. Grant location access.</b> Choose "Allow While Using App" the first time you open the map.
          For background notifications when you're near a Dread Location, {isIOS()
            ? 'go to iOS Settings → The Dread Directory → Location → and switch to "Always".'
            : 'go to your device Settings → Apps → The Dread Directory → Permissions → Location → and choose "Allow all the time".'}
        </p>
        <p style={S.aboutPara}>
          <b>3. Allow notifications.</b> This lets the app ping you when you walk within range of a site,
          even if the app is closed.
        </p>
        <p style={S.aboutPara}>
          <b>4. Claim a handle when you're ready to participate.</b> To post to DreadFeed, comment, submit
          a new Dread Location, or like other people's posts, you'll need a handle. Tap any of those
          actions and the app will walk you through {isIOS()
            ? 'Sign in with Apple — it takes one tap.'
            : 'a quick email sign-up.'}
        </p>

        <div style={S.aboutSectionHeader}>Browsing Dread Locations</div>

        <p style={S.aboutPara}>
          <b>The List.</b> Tap the list icon on the home screen to browse by category — True Crime,
          Hauntings, and Film Locations. Drill into a category, then a state, then a site to see its
          full lore.
        </p>
        <p style={S.aboutPara}>
          <b>The Map.</b> Tap the map icon on a category screen to see all sites in that category around
          you. Pinch to zoom, tap any pin for a quick preview, tap "View Details" for the full story.
        </p>
        <p style={S.aboutPara}>
          <b>Directions.</b> On any site's detail page, tap Directions to open Apple Maps with turn-by-turn
          routing to that exact spot.
        </p>

        <div style={S.aboutSectionHeader}>Submitting a new site</div>

        <p style={S.aboutPara}>
          <b>Be physically on-site.</b> Submission requires GPS verification within 100 meters of the
          location you're claiming. This keeps the directory honest.
        </p>
        <p style={S.aboutPara}>
          <b>Tap Submit.</b> From the home screen, tap the submit option. The app opens the camera,
          captures your current GPS, and walks you through naming the site, picking a category, writing
          its lore, and adding a verification photo.
        </p>
        <p style={S.aboutPara}>
          <b>Wait for approval.</b> Every submission goes to admin review for moderation. Once approved,
          your site appears in the directory permanently — credited to your handle.
        </p>

        <div style={S.aboutSectionHeader}>Using DreadFeed</div>

        <p style={S.aboutPara}>
          <b>The feed.</b> Tap the DreadFeed icon on the home screen to see a chronological feed of horror
          photos posted by other users. Tap a photo to see it full-size with its caption.
        </p>
        <p style={S.aboutPara}>
          <b>Posting from a site.</b> On any site's detail page (after you've physically been there), tap
          "Post to DreadFeed" to attach a photo and caption to that location. These posts are GPS-verified
          and admin-moderated.
        </p>
        <p style={S.aboutPara}>
          <b>Freeform posts.</b> Tap the ➕ icon on the DreadFeed tab to post any horror photo with a
          caption — no location required. Add stickers, text, filters, and frames in the in-app editor.
        </p>
        <p style={S.aboutPara}>
          <b>Comments and replies.</b> Tap the comment icon under any post to read the thread. Tap Reply
          under a comment to thread your response. Comments support 20 horror emojis from the quick row.
        </p>
        <p style={S.aboutPara}>
          <b>Reporting and blocking.</b> Tap the ⋯ on any post or comment to report content that violates
          the rules or block the user who posted it. Blocked users' content disappears across the whole
          app for you.
        </p>

        <div style={S.aboutSectionHeader}>Account &amp; privacy</div>

        <p style={S.aboutPara}>
          <b>What we store.</b> Your handle, the sites you've submitted, the posts you've made, your
          comments, your likes, and the device that owns your handle. That's it. No email, no real name,
          no contacts.
        </p>
        <p style={S.aboutPara}>
          <b>Delete everything.</b> From the home screen, go to Account → Delete account. This permanently
          removes your handle, all your posts, all your comments, every site you submitted, and every
          like you cast. It cannot be undone.
        </p>

        <div style={S.aboutSectionHeader}>About</div>

        <p style={S.aboutPara}>
          Part of the Sinister family — alongside Sinister Trivia and the Sinister Vids YouTube channel.
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
const MAPKIT_JS_TOKEN = 'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IkdYTFVDNUJKNlMifQ.eyJpc3MiOiI4SzZUOTc3N1I5IiwiaWF0IjoxNzc4NDI1Mzc5LCJleHAiOjE3OTM5NzczNzksIm9yaWdpbiI6IioiLCJtYXBJZCI6Im1hcHMuY29tLnNpbmlzdGVydHJpdmlhLmxvY2F0aW9ucyJ9.vasaEZU_W43UpH3sgfyTv2_Ed-UM9CXYS10GkPY9_IL6HZ7yMvTODRproN3cbIjFxJPLLf0ZgwvZtZ933C8F9A';
// Radius selector for NearbyView. The map view used to be locked at 20mi
// but as the catalog grew and the home cells started routing here per-
// category, users in less-dense areas needed a way to widen the search.
// 25 is the default — drivable for an evening trip without being so wide
// that distant pins dominate the screen.
const RADIUS_OPTIONS_MILES = [5, 10, 25, 50, 100] as const;
const DEFAULT_RADIUS_MILES = 25;
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
  ufo:        '🛸',
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

function NearbyView({ sites, currentLocation, onSelectSite, onBack, categoryFilter, categoryLabel, initialPinCenter, initialRadiusMi, onStateChange }: {
  sites: SinisterSite[];
  currentLocation: { lat: number; lng: number } | null;
  onSelectSite: (site: SinisterSite) => void;
  onBack: () => void;
  // When set, only render pins for sites in this category. Used by the home
  // category cells, which now route directly to a filtered map instead of
  // the old scrollable category list. When unset (e.g. the bottom-bar
  // "Locations Near Me" button), every category shows up on the map.
  categoryFilter?: CategoryKey;
  // Display label for the filtered category (e.g. "Hauntings"). Used in the
  // header so the user sees what they're looking at; falls back to the
  // generic "Locations Near Me" when no filter is set.
  categoryLabel?: string;
  // Restored state from the previous time this category's map was open.
  // Lets the view pick up where the user left off after a Detail → swipe
  // back round trip (instead of resetting the search center to their
  // real location every time).
  initialPinCenter?: { lat: number; lng: number } | null;
  initialRadiusMi?: number;
  onStateChange?: (state: { pinCenter: { lat: number; lng: number } | null; radiusMi: number }) => void;
}) {
  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const userAnnotationRef = useRef<any>(null);
  const siteAnnotationsRef = useRef<any[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  // State flag that flips true once the MapKit map object exists on
  // mapRef. Several effects that touch the map need to re-run after
  // it's ready — without a state flag, they'd race the async map
  // creation and bail with `if (!map) return`, then never fire again
  // because their actual data deps haven't changed. This is the root
  // cause of the "pins don't appear until I touch the radius" bug.
  const [mapReady, setMapReady] = useState(false);
  const [livePos, setLivePos] = useState<{ lat: number; lng: number } | null>(currentLocation);
  // Currently-tapped pin's site + distance. When non-null, a slide-up
  // preview card renders over the bottom of the map. Tapping the map
  // background, the card's × button, or another pin updates this.
  const [selectedSite, setSelectedSite] = useState<{ site: SinisterSite; distMi: number } | null>(null);
  // Search radius in miles — user picks from RADIUS_OPTIONS_MILES via chips
  // above the map. Initial value comes from the parent's per-category
  // cache so swipe-back from Detail restores what the user had set.
  const [radiusMi, setRadiusMi] = useState<number>(initialRadiusMi ?? DEFAULT_RADIUS_MILES);
  // Optional drag-pin location. When the user drags their dot, we set
  // this to the new coordinate and the radius search re-centers on it.
  // Tap Reset (or the dot itself) to clear and snap back to real location.
  // Initial value also restored from the parent's cache.
  const [pinCenter, setPinCenter] = useState<{ lat: number; lng: number } | null>(initialPinCenter ?? null);

  // Sync state changes back to the parent so it can restore them on
  // re-entry (e.g. user taps a pin → Detail → swipes back, the parent
  // re-mounts this component and reads pinCenter/radiusMi from the cache).
  useEffect(() => {
    if (onStateChange) onStateChange({ pinCenter, radiusMi });
  }, [pinCenter, radiusMi, onStateChange]);

  // The effective search center is the drop-pin if one is set, otherwise
  // the user's real location.
  //
  // CRITICAL: this memo must be stable against GPS jitter. livePos updates
  // every few seconds even when the user is stationary (the underlying
  // Geolocation watcher emits a fresh object on each fix). If we memoized
  // on the object identity of livePos, every tick would invalidate
  // `effectiveCenter`, then `nearbySites`, then the annotation rebuild
  // effect — causing pins to be removed and re-added several times per
  // second. MapKit's cluster engine sees the churn as "many new
  // annotations" each cycle and visibly thrashes between expanded
  // individual pins and the collapsed cluster circle. That's the
  // "flickering pin glitch" the user sees on the Hauntings map.
  //
  // Fix: read lat/lng primitives, round to ~10m precision, and only emit
  // a new effectiveCenter when those rounded values actually change.
  // Pinned mode is exact (no rounding) because dragging needs precision.
  const livePosLatRounded = livePos ? Math.round(livePos.lat * 10000) / 10000 : null;
  const livePosLngRounded = livePos ? Math.round(livePos.lng * 10000) / 10000 : null;
  const effectiveCenter = useMemo(
    () => {
      if (pinCenter) return pinCenter;
      if (livePosLatRounded === null || livePosLngRounded === null) return null;
      return { lat: livePosLatRounded, lng: livePosLngRounded };
    },
    // Depend on the ROUNDED primitives, not the livePos object. A GPS
    // tick that doesn't move the rounded coords keeps the same memoized
    // reference, which keeps nearbySites stable, which keeps the
    // annotation rebuild effect from firing in a loop.
    [pinCenter, livePosLatRounded, livePosLngRounded],
  );

  // Compute nearby sites with the current radius and effective center.
  // Sort by distance so the closest sites are reasoned about first, but
  // render ALL of them — MapKit's clustering handles dense areas by
  // collapsing overlapping pins into numbered cluster circles. There's
  // no longer a hard cap, since clustering keeps even 200+ pins readable.
  const nearbySites = useMemo(() => {
    if (!effectiveCenter) return [] as { site: SinisterSite; distMi: number }[];
    const radiusM = radiusMi * METERS_PER_MILE;
    // Honor CATEGORY_HOME_MERGE so True Crime pulls in serial killer
    // sites alongside crime sites. Other categories filter as before.
    const allowedCats = categoryFilter ? new Set<CategoryKey>(categoriesForKey(categoryFilter)) : null;
    const source = allowedCats
      ? sites.filter((s) => allowedCats.has(s.category as CategoryKey))
      : sites;
    return source
      .map((s) => ({
        site: s,
        distM: distanceMeters(effectiveCenter.lat, effectiveCenter.lng, s.coords.lat, s.coords.lng),
      }))
      .filter((x) => x.distM <= radiusM)
      .sort((a, b) => a.distM - b.distM)
      .map((x) => ({ site: x.site, distMi: x.distM / METERS_PER_MILE }));
  }, [sites, effectiveCenter, categoryFilter, radiusMi]);

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
        // Cluster annotation factory — called by MapKit when two or more
        // site pins overlap at the current zoom level. We render a colored
        // marker whose glyph is the count (e.g. "12"). Color is taken from
        // the clusteringIdentifier, which we set to the category key when
        // building each site pin — that way clusters match category color
        // even on the all-category map. Falls back to a neutral red if
        // somehow no identifier is set.
        map.annotationForCluster = (clusterAnnotation: any) => {
          const id: string = clusterAnnotation.clusteringIdentifier || '';
          const color = (CATEGORY_COLOR as any)[id] || '#d92a2a';
          const count = clusterAnnotation.memberAnnotations?.length || 0;
          return new mk.MarkerAnnotation(clusterAnnotation.coordinate, {
            color,
            glyphText: String(count),
            title: `${count} sites`,
            subtitle: '',
            selected: false,
            calloutEnabled: false,
            animates: false,
            // Mark this annotation so the select handler can recognize
            // it as a cluster and zoom in instead of opening a card.
            data: { isCluster: true, members: clusterAnnotation.memberAnnotations },
          });
        };
        mapRef.current = map;
        // Flip the state flag so dependent effects (annotation rebuild,
        // initial center, etc.) re-run now that the map is real.
        setMapReady(true);
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
  // Subsequent recenters happen when the user changes the radius (zoom
  // out to fit the new span) or drops a pin (jump to the pin's location).
  const didInitialCenterRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    const mk = (window as any).mapkit;
    if (!map || !mk || !livePos) return;

    // First fix — center the map and set the visible region to the radius.
    // If pinCenter was restored from the cache (returning from a Detail
    // round trip), center on that instead of the user's real location so
    // they pick up exactly where they left off.
    if (!didInitialCenterRef.current) {
      const initCenter = pinCenter || livePos;
      const center = new mk.Coordinate(initCenter.lat, initCenter.lng);
      // Convert miles to meters for span. CoordinateRegion uses degrees,
      // so we approximate: 1 deg lat ~= 111km. Span = 2 * radius.
      const spanDeg = (radiusMi * 2 * METERS_PER_MILE) / 111000;
      map.region = new mk.CoordinateRegion(
        center,
        new mk.CoordinateSpan(spanDeg, spanDeg),
      );
      didInitialCenterRef.current = true;
    }

    // Update or create the user dot. We use a custom MarkerAnnotation so
    // we can color it blue and override the glyph. The dot is DRAGGABLE
    // — dragging it sets pinCenter to the new coordinate, which moves the
    // radius search to that spot. When pinCenter is null the dot sits at
    // the real location (blue); when pinCenter is set the dot is at the
    // dragged location (recolored red by the dragged-state effect below).
    // Tapping a Reset button or the dot itself clears pinCenter and snaps
    // it back to the real location.
    if (userAnnotationRef.current) {
      // Only sync to livePos when we're NOT in dragged mode AND not
      // currently mid-drag. If pinCenter is null the user either
      // hasn't dragged at all (sync OK), OR they're partway through
      // a drag where pinCenter hasn't been committed yet (sync NOT
      // OK — we'd snap the dot out from under the finger). The
      // dragInProgressRef flag, set by the drag-start listener below,
      // is what tells us about that second case.
      if (!pinCenter && !dragInProgressRef.current) {
        userAnnotationRef.current.coordinate = new mk.Coordinate(livePos.lat, livePos.lng);
      }
    } else {
      const dot = new mk.MarkerAnnotation(
        new mk.Coordinate(livePos.lat, livePos.lng),
        {
          color: '#2a8aff',
          glyphColor: '#ffffff',
          title: 'Drag me to search elsewhere',
          subtitle: '',
          selected: false,
          calloutEnabled: false,
          draggable: true,
        },
      );
      map.addAnnotation(dot);
      userAnnotationRef.current = dot;
    }
  }, [livePos, pinCenter, mapReady]);

  // Drag-end handler — when the user releases the dragged dot, capture
  // the new coordinate as pinCenter. MapKit's drag-end fires on the
  // annotation, not the map, so we attach it once after the dot exists.
  // We use a layout effect tied to a sentinel so it re-binds if the dot
  // is ever recreated.
  //
  // CRITICAL: we ALSO bind drag-start. While a drag is in progress,
  // GPS updates keep arriving and the effects above/below would happily
  // overwrite dot.coordinate with livePos, yanking the dot back to the
  // user's real location mid-drag. The dragInProgressRef flag lets those
  // effects skip the sync while the finger is down.
  const dragHandlerBoundRef = useRef(false);
  const dragInProgressRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    const mk = (window as any).mapkit;
    const dot = userAnnotationRef.current;
    if (!map || !mk || !dot || dragHandlerBoundRef.current) return;
    const onDragStart = () => {
      dragInProgressRef.current = true;
    };
    const onDragEnd = () => {
      dragInProgressRef.current = false;
      const c = dot.coordinate;
      if (!c) return;
      playPop();
      setPinCenter({ lat: c.latitude, lng: c.longitude });
      setSelectedSite(null);
    };
    try {
      dot.addEventListener('drag-start', onDragStart);
      dot.addEventListener('drag-end', onDragEnd);
      dragHandlerBoundRef.current = true;
    } catch { /* silent */ }
    return () => {
      try {
        dot.removeEventListener('drag-start', onDragStart);
        dot.removeEventListener('drag-end', onDragEnd);
      } catch { /* silent */ }
      dragHandlerBoundRef.current = false;
      dragInProgressRef.current = false;
    };
  }, [livePos, mapReady]); // re-evaluate after first livePos arrives (when dot gets created)

  // Recolor the user dot to reflect dragged vs. at-real-location state.
  // Red = you've dragged it to search a different area. Blue = at your
  // real GPS location. Also moves the dot to pinCenter when dragged.
  // Skipped entirely while a drag is in progress — the dot's coordinate
  // is being controlled by the user's finger right now; touching it
  // from here would snap it out from under them.
  useEffect(() => {
    const mk = (window as any).mapkit;
    const dot = userAnnotationRef.current;
    if (!mk || !dot) return;
    if (dragInProgressRef.current) return;
    if (pinCenter) {
      dot.coordinate = new mk.Coordinate(pinCenter.lat, pinCenter.lng);
      dot.color = '#d92a2a';
      dot.title = 'Search center — drag to move';
    } else if (livePos) {
      dot.coordinate = new mk.Coordinate(livePos.lat, livePos.lng);
      dot.color = '#2a8aff';
      dot.title = 'Drag me to search elsewhere';
    }
  }, [pinCenter, livePos, mapReady]);

  // Re-zoom the visible region only when the USER changes something —
  // a radius chip tap, or a drag-end on the user dot (which updates
  // pinCenter). We deliberately exclude effectiveCenter from this
  // effect's dep array because effectiveCenter is recomputed whenever
  // livePos ticks via GPS; including it would forcibly re-center the
  // map every few seconds and fight the user's manual pan/zoom.
  useEffect(() => {
    const map = mapRef.current;
    const mk = (window as any).mapkit;
    if (!map || !mk) return;
    // Skip the very first frame — the initial-center effect already set
    // the region; running this immediately afterward would double-set it.
    if (!didInitialCenterRef.current) return;
    // Use the freshest center available at the moment of the user action,
    // but read it imperatively so changes to it later don't re-trigger us.
    const center = pinCenter || livePos;
    if (!center) return;
    const mkCenter = new mk.Coordinate(center.lat, center.lng);
    const spanDeg = (radiusMi * 2 * METERS_PER_MILE) / 111000;
    try {
      map.setRegionAnimated(
        new mk.CoordinateRegion(mkCenter, new mk.CoordinateSpan(spanDeg, spanDeg)),
        true,
      );
    } catch {
      map.region = new mk.CoordinateRegion(mkCenter, new mk.CoordinateSpan(spanDeg, spanDeg));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [radiusMi, pinCenter]);

  // Drop-pin and long-press code used to live here. Both are now obsolete:
  // the user dot is draggable, so dragging it serves the same purpose as a
  // separate drop pin would have. MapKit JS does not actually emit a
  // `long-press` event despite earlier attempts to use one, so that handler
  // was a no-op and has been removed.

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
          // Cluster pins that share the same category so dense areas
          // collapse to numbered circles. The cluster factory on the
          // map reads this identifier to pick the cluster's color.
          clusteringIdentifier: site.category,
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
    // Special cases:
    //   - Tapping the user dot when it's been dragged clears the search
    //     center and snaps back to the real location.
    //   - Tapping a cluster zooms in to break the cluster apart instead
    //     of opening a slide-up card (clusters represent multiple sites,
    //     not one).
    const onSelect = (e: any) => {
      const ann = e?.annotation;
      if (!ann) return;
      if (ann === userAnnotationRef.current) {
        if (pinCenter) {
          playBackSound();
          setPinCenter(null);
          setSelectedSite(null);
        }
        return;
      }
      // Cluster annotations get a `data.isCluster` flag from the factory
      // in the map init. Members are the underlying site annotations the
      // cluster collapsed; we compute a region that bounds them and zoom
      // in. MapKit will then re-cluster (or break clusters apart) for
      // the new zoom level automatically.
      if (ann.data?.isCluster) {
        playPop();
        const mk = (window as any).mapkit;
        const members: any[] = ann.data.members || [];
        if (mk && members.length > 1) {
          // Compute lat/lng bounds of the cluster's members + a small
          // pad so the pins don't sit flush against the viewport edge.
          let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
          for (const m of members) {
            const c = m.coordinate;
            if (!c) continue;
            if (c.latitude < minLat) minLat = c.latitude;
            if (c.latitude > maxLat) maxLat = c.latitude;
            if (c.longitude < minLng) minLng = c.longitude;
            if (c.longitude > maxLng) maxLng = c.longitude;
          }
          const padLat = Math.max((maxLat - minLat) * 0.4, 0.005);
          const padLng = Math.max((maxLng - minLng) * 0.4, 0.005);
          const center = new mk.Coordinate((minLat + maxLat) / 2, (minLng + maxLng) / 2);
          const span = new mk.CoordinateSpan(
            (maxLat - minLat) + padLat * 2,
            (maxLng - minLng) + padLng * 2,
          );
          try { map.setRegionAnimated(new mk.CoordinateRegion(center, span), true); }
          catch { map.region = new mk.CoordinateRegion(center, span); }
        }
        setSelectedSite(null);
        return;
      }
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
  }, [nearbySites, pinCenter, mapReady]);

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
          data-text={categoryLabel || "Locations Near Me"}
        >
          {categoryLabel || "Locations Near Me"}
        </div>
        <div style={S.listSubtitle}>
          {nearbySites.length} {nearbySites.length === 1 ? 'site' : 'sites'} within {radiusMi} mi
          {pinCenter && ' · from dropped pin'}
        </div>
        {/* Radius chips — let the user widen or narrow the search without
            leaving the map. Long-pressing the map drops a search-center
            pin; the Reset chip appears next to the radius row when a drop
            pin is active so the user can snap back to their real location. */}
        <div style={S.radiusRow}>
          {RADIUS_OPTIONS_MILES.map((r) => {
            const active = r === radiusMi;
            return (
              <button
                key={r}
                style={{ ...S.radiusChip, ...(active ? S.radiusChipActive : {}) }}
                onClick={() => { playPop(); setRadiusMi(r); }}
                aria-pressed={active}
              >
                {r} mi
              </button>
            );
          })}
          {pinCenter && (
            <button
              style={{ ...S.radiusChip, ...S.radiusChipReset }}
              onClick={() => { playBackSound(); setPinCenter(null); setSelectedSite(null); }}
              aria-label="Reset search center to my location"
            >
              ↻ Reset
            </button>
          )}
        </div>
      </header>

      {loadError ? (
        <div style={S.leaderBody}>
          <p style={{ ...S.aboutPara, color: '#d97a7a' }}>
            {loadError}
          </p>
          <p style={S.aboutPara}>
            Once the token is set, the map will load Apple Maps with your live position
            and every site within the selected radius.
          </p>
        </div>
      ) : (
        <>
          <div
            ref={mapElRef}
            style={{
              width: '100%',
              height: 'calc(100vh - 280px)',
              minHeight: 320,
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
              No sites within {radiusMi} miles{pinCenter ? ' of that spot' : ''}. Try a wider radius{pinCenter ? ' or tap Reset' : ''}.
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
                style={S.localeSearchInput}
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
                  <div style={{
                    ...S.emptyState,
                    // Fill the filmstrip's full height (filmstripOuter is 776px)
                    // and center vertically so the empty-state copy sits in the
                    // mask's fully-opaque middle band, well below the giant
                    // category title which lives in the faded top region.
                    minHeight: 776,
                    justifyContent: 'center' as const,
                  }}>
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

  // ---- Guestbook state ----
  // Guestbook is loaded once on mount and refetched whenever a new signing
  // succeeds. List is ordered with rank 1 (the Keeper) first.
  const [guestbook, setGuestbook] = useState<GuestbookSignature[]>([]);
  const [guestbookLoaded, setGuestbookLoaded] = useState(false);
  // Modal state: when the user taps "Sign the Guestbook" we open a small
  // composer for an optional 30-char inscription. The Sign button on the
  // modal triggers the actual API call.
  const [signModalOpen, setSignModalOpen] = useState(false);
  const [inscriptionDraft, setInscriptionDraft] = useState('');

  useEffect(() => {
    let cancelled = false;
    apiGetGuestbook(site.id).then((sigs) => {
      if (!cancelled) {
        setGuestbook(sigs);
        setGuestbookLoaded(true);
      }
    });
    return () => { cancelled = true; };
  }, [site.id]);

  // Sync local visited flag if parent's set updates (e.g. new visits loaded
  // from server while this view is mounted).
  useEffect(() => {
    if (alreadyVisited) setVisited(true);
  }, [alreadyVisited]);

  // Open the inscription modal. Triggered by the "Sign the Guestbook"
  // button. Pre-checks GPS/handle so the user finds out about problems
  // before composing.
  const openSignModal = () => {
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
    setClaimError(null);
    setInscriptionDraft('');
    setSignModalOpen(true);
  };

  // Actually sign the guestbook. Called from inside the modal once the
  // user confirms. Uses inscriptionDraft (possibly empty string).
  const handleClaimVisit = async () => {
    if (!handle || !deviceId || !currentLocation) {
      setSignModalOpen(false);
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
      inscription: inscriptionDraft.trim(),
    });
    setClaiming(false);
    setSignModalOpen(false);
    if (result.ok) {
      setVisited(true);
      onVisited(site.id);
      // Refresh the guestbook list so the new signature shows up.
      apiGetGuestbook(site.id).then((sigs) => setGuestbook(sigs));
      if (result.alreadyClaimed) {
        showToast(`Already signed ${site.title}`, 'default');
      } else if (result.isKeeper) {
        // Keeper status — first signer ever at this site.
        showToast(`🗝️ You are the Keeper of ${site.title}`, 'success');
      } else if (typeof result.signingRank === 'number') {
        showToast(`✓ Signed the guestbook at ${site.title} (#${result.signingRank})`, 'success');
      } else {
        showToast(`✓ Signed the guestbook at ${site.title}`, 'success');
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
      setClaimError(fail.message || 'Could not sign the guestbook');
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
              ✓ You've Signed the Guestbook
            </div>
          ) : inRange ? (
            <button
              onClick={openSignModal}
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
              {claiming ? 'Signing…' : "I'm Here — Sign the Guestbook"}
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
                fontSize: 18,
              }}
            >
              {distM != null ? 'Get within 100m to sign the guestbook' : 'Locating…'}
            </div>
          )
        )}
        {claimError && (
          <div style={{ color: '#d97a7a', fontSize: 13, textAlign: 'center', marginBottom: 12 }}>
            {claimError}
          </div>
        )}

        {/* ---- Guestbook section ----
            Displays signatures left at this site, with the Keeper (rank 1)
            pinned at the top. Visible to everyone viewing DetailView, even
            if they haven't signed it themselves — the point is for sites
            to feel inhabited and visited. Empty sites show the "be the
            first" prompt to invite the first visitor to claim the site. */}
        <div style={{ marginTop: 24, marginBottom: 12 }}>
          <div style={{
            fontSize: 14,
            fontFamily: 'system-ui, -apple-system, sans-serif',
            color: '#888',
            letterSpacing: 2,
            textTransform: 'uppercase',
            textAlign: 'center',
            marginBottom: 10,
          }}>
            ⸻ Guestbook ⸻
          </div>
          {!guestbookLoaded ? (
            <div style={{ color: '#666', fontSize: 13, textAlign: 'center', padding: '10px 0' }}>
              Reading the guestbook…
            </div>
          ) : guestbook.length === 0 ? (
            <div style={{
              border: '1px dashed #2a2a2a',
              borderRadius: 8,
              padding: '14px 16px',
              textAlign: 'center',
              color: '#888',
              fontSize: 13,
              fontStyle: 'italic',
              fontFamily: 'Georgia, serif',
            }}>
              This site is unclaimed.<br />Be the first to sign.
            </div>
          ) : (
            <div style={{
              border: '1px solid #1f1f1f',
              borderRadius: 8,
              padding: '8px 0',
              backgroundColor: '#0a0a0a',
              maxHeight: 280,
              overflowY: 'auto',
            }}>
              {guestbook.map((sig, idx) => {
                const isKeeper = sig.signingRank === 1;
                const dateStr = sig.signedAt ? new Date(sig.signedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
                return (
                  <div
                    key={`${sig.handle}-${idx}`}
                    style={{
                      padding: '8px 14px',
                      borderBottom: idx < guestbook.length - 1 ? '1px solid #1a1a1a' : 'none',
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 8,
                      backgroundColor: isKeeper ? '#15100a' : 'transparent',
                    }}
                  >
                    <div style={{ fontSize: 14, flexShrink: 0, width: 22, textAlign: 'center' }}>
                      {isKeeper ? '🗝️' : <span style={{ color: '#555', fontSize: 11 }}>#{sig.signingRank ?? '?'}</span>}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontFamily: 'Georgia, serif',
                        fontSize: 14,
                        color: isKeeper ? '#e0c98a' : '#c0c0c0',
                        fontWeight: isKeeper ? 600 : 400,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {sig.handle}
                        {isKeeper && <span style={{ fontSize: 10, marginLeft: 8, color: '#a89060', letterSpacing: 1, textTransform: 'uppercase' }}>Keeper</span>}
                      </div>
                      {sig.inscription && (
                        <div style={{
                          fontFamily: 'Georgia, serif',
                          fontSize: 12,
                          fontStyle: 'italic',
                          color: '#888',
                          marginTop: 2,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}>
                          “{sig.inscription}”
                        </div>
                      )}
                    </div>
                    <div style={{ fontSize: 10, color: '#555', flexShrink: 0 }}>{dateStr}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Add Photo (Social post) button.
            Shown when:
              - GPS fix available AND user is within 100m of the site
              - User has a claimed handle (otherwise no identity to post under)
            Hidden when:
              - User is out of range (button just won't render)
              - User has no handle (renders a disabled "Claim a handle to post" hint
                instead, so they know what's missing)
            This is the entry point to the in-app camera + caption composer that
            creates a new feed post via POST /posts. */}
        {currentLocation && inRange && (
          handle && deviceId ? (
            <AddPhotoButton
              site={site}
              handle={handle}
              deviceId={deviceId}
              currentLocation={currentLocation}
              onPosted={() => {
                showToast('Post submitted for review', 'success');
              }}
            />
          ) : (
            <div style={S.addPhotoBtnDisabled}>
              Claim a handle to share photos
            </div>
          )
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

      {/* ---- Sign the Guestbook modal ----
          Overlay that lets the user compose an optional 30-char inscription
          before signing. Tap Skip to sign without one. Tap Sign to commit. */}
      {signModalOpen && (
        <div
          onClick={() => { if (!claiming) setSignModalOpen(false); }}
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.82)',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              backgroundColor: '#0c0c0c',
              border: `1px solid ${SUBMIT_RED}55`,
              borderRadius: 14,
              padding: '22px 22px 18px',
              maxWidth: 360,
              width: '100%',
              boxShadow: `0 0 40px ${SUBMIT_RED}33`,
              fontFamily: 'system-ui, -apple-system, sans-serif',
            }}
          >
            <div style={{
              fontFamily: 'Georgia, serif',
              fontSize: 22,
              color: WHITE,
              textAlign: 'center',
              marginBottom: 6,
              letterSpacing: 1,
            }}>
              Sign the Guestbook
            </div>
            <div style={{
              fontSize: 13,
              color: '#888',
              textAlign: 'center',
              marginBottom: 18,
              fontStyle: 'italic',
              fontFamily: 'Georgia, serif',
            }}>
              {site.title}
            </div>
            <div style={{ fontSize: 12, color: '#999', marginBottom: 8 }}>
              Leave a mark (optional, up to 30 chars):
            </div>
            <input
              type="text"
              value={inscriptionDraft}
              onChange={(e) => {
                const v = e.target.value;
                if (v.length <= 30) setInscriptionDraft(v);
              }}
              placeholder="Here lies…"
              maxLength={30}
              disabled={claiming}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                backgroundColor: '#1a1a1a',
                border: '1px solid #333',
                borderRadius: 6,
                padding: '10px 12px',
                color: WHITE,
                fontSize: 15,
                fontFamily: 'Georgia, serif',
                fontStyle: 'italic',
                marginBottom: 6,
                outline: 'none',
              }}
            />
            <div style={{
              fontSize: 11,
              color: '#666',
              textAlign: 'right',
              marginBottom: 18,
            }}>
              {inscriptionDraft.length}/30
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => { if (!claiming) setSignModalOpen(false); }}
                disabled={claiming}
                style={{
                  flex: 1,
                  padding: '12px 0',
                  backgroundColor: 'transparent',
                  border: '1px solid #2a2a2a',
                  borderRadius: 8,
                  color: '#888',
                  fontSize: 14,
                  fontFamily: 'system-ui, -apple-system, sans-serif',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleClaimVisit}
                disabled={claiming}
                style={{
                  flex: 2,
                  padding: '12px 0',
                  backgroundColor: claiming ? '#3a0a0a' : '#5a0000',
                  border: `1px solid ${SUBMIT_RED}`,
                  borderRadius: 8,
                  color: WHITE,
                  fontSize: 14,
                  fontWeight: 600,
                  fontFamily: 'system-ui, -apple-system, sans-serif',
                  textShadow: `0 0 8px ${SUBMIT_RED}`,
                  boxShadow: `0 0 14px ${SUBMIT_RED}55`,
                  cursor: claiming ? 'wait' : 'pointer',
                  letterSpacing: 1,
                  textTransform: 'uppercase',
                }}
              >
                {claiming ? 'Signing…' : (inscriptionDraft.trim() ? 'Sign' : 'Sign Anonymously')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Add Photo button + composer (Social post creation) ----------
// Standalone component used inside DetailView when the user is in range.
// Manages its own composer modal state — the file input, the photo preview,
// the caption, and the "also share externally" toggle.
//
// Flow:
//   1) User taps "Add Photo" → opens hidden <input type="file" capture="environment">
//   2) Native camera opens (capture="environment" forces back camera, no gallery)
//   3) On capture, composer modal opens with preview + caption + share toggle
//   4) User taps "Post" → POST /posts (multipart, server verifies GPS + queues)
//   5) On success, if "also share" was toggled, open native share sheet
//   6) Show toast confirming submission
//
// This mirrors the SubmitView photo flow (same <input> + capture pattern) so
// users get the same camera UX they already know from site submission.
function AddPhotoButton({ site, handle, deviceId, currentLocation, onPosted }: {
  site: SinisterSite;
  handle: string;
  deviceId: string;
  currentLocation: { lat: number; lng: number };
  onPosted: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [alsoShare, setAlsoShare] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const captionTrim = caption.trim();
  const canSubmit = !!photoFile && captionTrim.length >= 1 && captionTrim.length <= 280 && !submitting;

  const onPhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setPhotoFile(f);
    const url = URL.createObjectURL(f);
    setPhotoPreview(url);
  };

  const closeComposer = () => {
    if (submitting) return;
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoFile(null);
    setPhotoPreview(null);
    setCaption('');
    setAlsoShare(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const onSubmit = async () => {
    if (!canSubmit || !photoFile) return;
    setSubmitting(true);
    const result = await apiCreatePost({
      photo: photoFile,
      handle,
      deviceId,
      siteId: site.id,
      caption: captionTrim,
      captureLat: currentLocation.lat,
      captureLng: currentLocation.lng,
    });
    setSubmitting(false);

    if (!result.ok) {
      showToast(result.reason || 'Post failed', 'error');
      return;
    }

    playPostShared();

    // Optional external share. We pass the photo as a File so iOS picks
    // image-friendly destinations (Instagram, Messages photo share, etc).
    if (alsoShare && typeof navigator !== 'undefined' && (navigator as any).share) {
      try {
        const shareData: any = {
          title: 'Dread Directory',
          text: `${captionTrim}\n\n${site.title} — Dread Directory`,
        };
        // navigator.canShare with files only works in some browsers; gracefully
        // fall back to text-only share if not supported.
        if ((navigator as any).canShare && (navigator as any).canShare({ files: [photoFile] })) {
          shareData.files = [photoFile];
        }
        await (navigator as any).share(shareData);
      } catch {
        // User cancelled share sheet — not an error, the post is already submitted.
      }
    }

    onPosted();
    closeComposer();
  };

  return (
    <>
      {/* Hidden file input. capture="environment" forces back camera on iOS
          and avoids the photo picker entirely. */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onPhotoChange}
        style={{ display: 'none' }}
      />

      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        style={S.addPhotoBtn}
      >
        📷 Post to DreadFeed
      </button>

      {/* Composer modal — appears after the user captures a photo. */}
      {photoPreview && (
        <div style={S.postComposerOverlay} onClick={(e) => { if (e.target === e.currentTarget) closeComposer(); }}>
          <div style={S.postComposerCard}>
            <div style={S.postComposerTitle}>New Post</div>
            <img src={photoPreview} alt="preview" style={S.postComposerPreview} />
            <textarea
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="One sentence about being here..."
              maxLength={280}
              style={S.postCaptionInput}
            />
            <div style={{ color: '#666', fontSize: 11, textAlign: 'right', marginTop: -8 }}>
              {captionTrim.length}/280
            </div>
            <label style={S.postShareToggleRow}>
              <input
                type="checkbox"
                checked={alsoShare}
                onChange={(e) => setAlsoShare(e.target.checked)}
                style={{ accentColor: '#FFFFFF', width: 16, height: 16 }}
              />
              Also share to Messages / Instagram / X
            </label>
            <div style={S.postComposerBtnRow}>
              <button
                type="button"
                onClick={closeComposer}
                disabled={submitting}
                style={S.postComposerCancel}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onSubmit}
                disabled={!canSubmit}
                style={canSubmit ? S.postComposerSubmit : S.postComposerSubmitDisabled}
              >
                {submitting ? 'Posting…' : 'Post'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ---------- Inline handle claim UI for SubmitView ----------
// If the user has a server-claimed handle, just shows it read-only. If not,
// shows a CTA pointing them at the DreadFeed claim screen — that's the
// canonical signup path now (Apple Sign In or email-verified handle). We
// don't allow handle creation here anymore because it bypassed email
// recovery, leaving users stranded on reinstall.
function HandleField({ deviceId, handle, submitter, setSubmitter, onClaimed, onGoToClaim }: {
  deviceId: string | null;
  handle: string | null;
  submitter: string;
  setSubmitter: (v: string) => void;
  onClaimed: (h: string) => void;
  // Optional — parent SubmitView passes a callback that navigates to the
  // DreadFeed claim screen. If not provided we fall back to a static
  // message (this path should be reached, hence the prop is optional for
  // backward compat).
  onGoToClaim?: () => void;
}) {
  // Marks unused props quiet for the linter — these stick around so the
  // call-site doesn't change. Once everyone's on the new flow we can
  // simplify the prop list.
  void deviceId; void submitter; void setSubmitter; void onClaimed;

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

  // No handle yet — point them at the DreadFeed claim screen.
  return (
    <Field label="Your Handle" valid={false} hint="You need a handle to submit a site">
      <div style={{
        ...S.input,
        display: 'flex', flexDirection: 'column', gap: 10,
        padding: 14,
      }}>
        <div style={{ color: BONE, fontSize: 14, lineHeight: 1.4 }}>
          You don't have a handle yet. Create one in DreadFeed — {isIOS()
            ? 'it takes one tap with Sign in with Apple, or you can use email.'
            : 'sign up with email in a few seconds.'}
        </div>
        {onGoToClaim && (
          <button
            type="button"
            onClick={onGoToClaim}
            style={{
              ...S.input,
              backgroundColor: SUBMIT_RED,
              color: WHITE,
              border: 'none',
              fontWeight: 700,
              cursor: 'pointer',
              padding: '10px 16px',
              borderRadius: 8,
              alignSelf: 'flex-start',
            }}
          >
            Go to DreadFeed →
          </button>
        )}
      </div>
    </Field>
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
function SubmitView({ currentLocation, deviceId, handle, onHandleClaimed, onBack, onGoToSocial }: {
  currentLocation: { lat: number; lng: number } | null;
  deviceId: string | null;
  handle: string | null;
  onHandleClaimed: (h: string) => void;
  onBack: () => void;
  // Used by HandleField when the user has no handle yet — sends them to
  // the DreadFeed claim screen, which is the canonical signup path now.
  onGoToSocial?: () => void;
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
            {VISIBLE_CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
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
          onGoToClaim={onGoToSocial}
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
    // Natural flex-flow positioning: this sits as a flex child between
    // homeFilmHeader (title block) and homeReelCenter (filmstrip), inside
    // homeReelGroup. It claims its own vertical slot in the column flex
    // layout instead of fighting absolute-position math. Margin-top
    // controls the gap below BY SINISTER. The filmstrip below is itself
    // position: fixed so it doesn't care how tall this banner is.
    position: 'relative',
    marginTop: 0,
    backgroundColor: 'rgba(10,10,10,0.55)',
    border: `1px solid ${SINISTER_RED}55`,
    borderRadius: 10,
    padding: '4px 16px',
    minWidth: 220,
    maxWidth: '86vw',
    cursor: 'pointer',
    pointerEvents: 'auto',
    color: BONE,
    textAlign: 'center' as const,
    boxShadow: `0 0 16px ${SINISTER_RED}33, 0 0 4px ${BLACK}99`,
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
    // Trimmed from 3 — every pixel counts since fonts stay fixed.
    marginBottom: 1,
  },
  latestSpotlightTitle: {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: 18,
    fontWeight: 700,
    letterSpacing: '0.06em',
    color: WHITE,
    textShadow: `0 0 10px ${WHITE}66, 1px 1px 0 ${BLACK}`,
    // Tightened from 1.2 — reduces row height without affecting glyph size.
    lineHeight: 1.05,
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
    // Trimmed from 3 — same reasoning as the label marginBottom.
    marginTop: 1,
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
    fontSize: 18,
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
    // Nudged +6px to 116 for a hair more breathing room above the icons.
    bottom: 116,
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
  // Wrapper that pins the LatestSubmissionSpotlight at the spot where the
  // SUBMIT A LOCATION button used to live, centered above the home bar.
  // The inner spotlight component sits with position: relative, so this
  // fixed-position wrapper does the bottom-anchoring without changing the
  // spotlight's intrinsic layout.
  //
  // Lifted from bottom: 116 to bottom: 150 when the bottom bar icons grew
  // from 58px to 70px tall — the taller bar would otherwise overlap the
  // spotlight chip.
  spotlightFixedWrap: {
    position: 'fixed' as const,
    left: '50%',
    bottom: 150,
    transform: 'translateX(-50%)',
    zIndex: 3,
    display: 'flex',
    justifyContent: 'center',
    pointerEvents: 'none' as const,
    // The spotlight inside re-enables pointer events via its own style,
    // so taps land on the chip but not on this transparent wrapper.
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
  // ---- Home bottom bar (4 custom-icon buttons) ----
  // Replaces the prior 3-pill socialBar (List View / eXposure / More).
  // Sits at the bottom of the home screen, icons + small labels. The
  // icons are full rounded-square iOS-style app icons so they read as
  // a row of mini-apps rather than UI chrome.
  homeBar: {
    position: 'fixed' as const,
    left: 0, right: 0,
    // Anchor at the very bottom edge (with safe-area padding handling
    // the home-indicator clearance via paddingBottom below). This
    // pulls the icons down significantly vs the old bottom: 14 which
    // was pushing them up into the Submit button's space.
    bottom: 0,
    zIndex: 10,
    display: 'flex',
    justifyContent: 'space-around',
    alignItems: 'flex-end',
    gap: 4,
    padding: '0 8px 4px 8px',
    boxSizing: 'border-box' as const,
    paddingBottom: 'env(safe-area-inset-bottom, 0px)' as any,
  },
  homeBarBtn: {
    flex: 1,
    // Raised cap from 96 to 120 so each of the 4 buttons can claim
    // ~25% of a typical iPhone width (390 / 4 ≈ 97 + gap room). With
    // the bigger 70px icons below this lets them breathe instead of
    // being capped tiny.
    maxWidth: 120,
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 2,
    padding: '4px 0 0 0',
    // iOS-style press feedback: scale-down + dim on tap. Uses CSS class
    // "sinister-icon-btn" defined in the global stylesheet so :active
    // pseudo-state can drive the animation (inline styles can't).
    WebkitTapHighlightColor: 'transparent' as any,
    WebkitTouchCallout: 'none' as any,        // disables iOS long-press "Save Image"
    WebkitUserSelect: 'none' as any,
    userSelect: 'none' as const,
  },
  homeBarIcon: {
    // Bumped from 58 to 70 to match real iPhone home-screen icon size
    // (~60pt rendered, which on @2x retina is around 60-70px visible).
    width: 70,
    height: 70,
    borderRadius: 16,
    display: 'block',
    objectFit: 'cover' as const,
    filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.6))',
    // Belt-and-suspenders: disable iOS long-press / drag on the
    // image itself, not just its parent button.
    WebkitTouchCallout: 'none' as any,
    WebkitUserSelect: 'none' as any,
    userSelect: 'none' as const,
    pointerEvents: 'none' as const,           // taps go to the button, not the img
  },
  // Visual-balance override for icons whose source PNG art fills more of
  // the canvas (List View, Submit/location). Renders them slightly smaller
  // so they appear the same VISUAL size as the more padded icons (DreadFeed,
  // About). The button slot stays the same width so layout doesn't shift —
  // only the image inside is smaller. Margin keeps the smaller icons
  // visually centered relative to the larger ones' baseline.
  homeBarIconSmall: {
    // Scaled proportionally with the 58→70 base bump: 50/58 ≈ 0.86,
    // 0.86 × 70 ≈ 60. Margin scales similarly to keep visual centering.
    width: 60,
    height: 60,
    margin: 5,
  },
  // Visual-balance override for icons whose source PNG art has EXTRA
  // padding inside the canvas (currently just About — the cracked-skull-
  // question-mark sits with ~10% black padding around it, while DreadFeed's
  // skull-and-crossbones fills its canvas to the edges). Renders About
  // bigger so the visible artwork matches DreadFeed's visible artwork
  // size. Negative margin pulls the bigger image back inside the button's
  // bounds without changing the slot width.
  homeBarIconLarge: {
    width: 80,
    height: 80,
    margin: -5,
  },
  homeBarLabel: {
    // Slightly larger label to match the bigger icons — bumped from 11
    // to 12. Stays tight enough to fit "List View" / "DreadFeed" on a
    // single line under each icon.
    fontSize: 12,
    color: '#F0EBE0',
    letterSpacing: '0.04em',
    textAlign: 'center' as const,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontWeight: 600,
    textShadow: '0 1px 3px rgba(0,0,0,0.8)',
    maxWidth: '100%',
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
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
    fontFamily: '"Jolly Lodger", system-ui, serif',
    fontSize: 18,
    fontWeight: 400,
    letterSpacing: '0.04em',
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
  // Neon-purple variant used by the middle "eXposure" button on the home
  // bottom bar. Same shape as socialBtn but with a magenta-purple outline +
  // glow so the live community feed entry point pops against the
  // monochrome List View / More buttons flanking it. Jolly Lodger font
  // (vs system-ui) lets the lowercase-e / capital-X treatment of
  // "eXposure" render properly — no textTransform uppercase mangling.
  socialBtnHighlight: {
    flex: 1,
    maxWidth: 200,
    backgroundColor: 'rgba(0,0,0,0.45)',
    border: `1.5px solid #FFFFFF`,
    color: '#FFFFFF',
    fontFamily: '"Jolly Lodger", system-ui, serif',
    fontSize: 18,
    fontWeight: 400,
    letterSpacing: '0.04em',
    padding: '10px 12px',
    borderRadius: 14,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    boxShadow: `0 0 14px #FFFFFF44, inset 0 0 8px #FFFFFF22`,
    textShadow: `0 0 8px #FFFFFFaa`,
    backdropFilter: 'blur(2px)',
  },
  socialLabelHighlight: { fontSize: 18, color: '#FFFFFF' },
  socialIcon: { fontSize: 16, lineHeight: 1 },
  socialLabel: { fontSize: 18 },

  // ---- Social feed view ----
  socialViewWrap: {
    minHeight: '100vh',
    paddingBottom: 60,
    position: 'relative',
    zIndex: 2,
  },
  socialHeader: {
    position: 'sticky',
    top: 0,
    zIndex: 5,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '14px 16px',
    backgroundColor: 'rgba(10,10,10,0.85)',
    backdropFilter: 'blur(8px)',
    borderBottom: `1px solid #FFFFFF33`,
  },
  // ---- Permanent eXposure brand header ----
  // Solid black bar with a two-line treatment: large neon-purple "eXposure"
  // brand on top, small grey tagline beneath. Sticky so it pins to the
  // top of the viewport on every eXposure sub-screen.
  //
  // The paddingTop uses env(safe-area-inset-top) so on iOS the brand title
  // sits BELOW the status bar (clock / wifi / battery) rather than behind
  // it. Extra padding-top beyond the inset adds breathing room so the
  // header doesn't feel cramped against the status bar — IG centers its
  // brand a comfortable distance below the safe area, which this matches.
  exposureBrandHeader: {
    position: 'sticky' as const,
    top: 0,
    zIndex: 6,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 'calc(env(safe-area-inset-top, 44px) + 16px)' as any,
    paddingBottom: 12,
    paddingLeft: 16,
    paddingRight: 16,
    backgroundColor: '#000',
    borderBottom: `1px solid #FFFFFF44`,
    boxShadow: '0 2px 12px rgba(0,0,0,0.6)',
  },
  // Full-width row that holds the brand title, centered. By making this
  // row span the entire header width and centering its content, the
  // DreadFeed title is anchored to the true horizontal center of the
  // header — the absolutely-positioned bell button on the right
  // doesn't shift it.
  exposureBrandTitleRow: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none' as const,
  },
  exposureBrandTitle: {
    color: '#FFFFFF',
    // LivingHell to match the home page "Dread Directory" title — keeps
    // the brand typography consistent across the whole app. Sized down
    // from the home page's 84pt to fit comfortably in the DreadFeed
    // header bar without dominating the screen.
    fontSize: 40,
    fontFamily: '"LivingHell", "Jolly Lodger", system-ui, serif',
    fontWeight: 400,
    letterSpacing: '0.04em',
    // White text with purple glow keeps DreadFeed visually tied to the
    // rest of the app's purple accents.
    textShadow: `0 0 14px #FFFFFFcc, 0 0 4px #FFFFFF88`,
    lineHeight: 1,
  },
  // Bell button — absolute-positioned in the top-right of the brand
  // header. Sized to be tap-friendly (~44pt) but visually small.
  exposureBellBtn: {
    position: 'absolute' as const,
    right: 12,
    top: 'calc(env(safe-area-inset-top, 44px) + 14px)' as any,
    width: 36,
    height: 36,
    background: 'transparent',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Airplane (DMs) sits to the LEFT of the bell. Same vertical position,
  // shifted left by enough to clear the bell + a small gap.
  exposureInboxBtn: {
    position: 'absolute' as const,
    right: 52,
    top: 'calc(env(safe-area-inset-top, 44px) + 14px)' as any,
    width: 36,
    height: 36,
    background: 'transparent',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Red unread-count badge in the bell's top-right corner.
  exposureBellBadge: {
    position: 'absolute' as const,
    top: -2,
    right: -2,
    minWidth: 16,
    height: 16,
    padding: '0 4px',
    background: '#FF3B5C',
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: 700 as const,
    borderRadius: 8,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    pointerEvents: 'none' as const,
  },
  // ---- NotificationsView ----
  notifWrap: {
    minHeight: '100vh',
    background: '#000',
    color: '#FFFFFF',
    paddingBottom: 'env(safe-area-inset-bottom, 0)' as any,
  },
  notifHeader: {
    position: 'sticky' as const,
    top: 0,
    zIndex: 5,
    background: '#000',
    borderBottom: '1px solid #1a1a1a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 'calc(env(safe-area-inset-top, 44px) + 8px) 12px 8px' as any,
  },
  notifBackBtn: {
    width: 40,
    height: 40,
    background: 'transparent',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  notifHeaderTitle: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: 600 as const,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  notifEmpty: {
    padding: '80px 24px',
    textAlign: 'center' as const,
    color: '#888',
    fontSize: 14,
  },
  notifList: {
    display: 'flex',
    flexDirection: 'column' as const,
  },
  notifRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 14px',
    background: 'transparent',
    border: 'none',
    borderBottom: '1px solid #111',
    cursor: 'pointer',
    width: '100%',
    textAlign: 'left' as const,
  },
  notifRowUnread: {
    background: 'rgba(255, 59, 92, 0.06)',
  },
  notifAvatarBtn: {
    width: 44,
    height: 44,
    minWidth: 44,
    padding: 0,
    background: 'transparent',
    border: 'none',
    borderRadius: '50%',
    overflow: 'hidden',
    cursor: 'pointer',
  },
  notifAvatarImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover' as const,
    pointerEvents: 'none' as const,
  },
  notifBodyCol: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
    minWidth: 0,
  },
  notifBodyText: {
    color: '#F0EBE0',
    fontSize: 14,
    lineHeight: 1.35,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    overflow: 'hidden',
    textOverflow: 'ellipsis' as const,
  },
  notifActorName: {
    fontWeight: 700 as const,
    color: '#FFFFFF',
  },
  notifVerb: {
    color: '#aaa',
  },
  notifTime: {
    color: '#666',
    fontSize: 11,
  },
  notifThumb: {
    width: 44,
    height: 44,
    minWidth: 44,
    objectFit: 'cover' as const,
    borderRadius: 4,
    pointerEvents: 'none' as const,
  },
  exposureBrandTagline: {
    color: '#888',
    fontSize: 11,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    letterSpacing: '0.12em',
    textTransform: 'uppercase' as const,
    marginTop: 4,
  },
  // Pull-to-refresh indicator. Sits above the header, height grows as the
  // user drags down. Background matches the page so it visually "pulls
  // out" from behind the header. Transitions smoothly back to 0 on
  // release or refresh completion.
  pullIndicator: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    overflow: 'hidden',
    backgroundColor: 'transparent',
    color: '#FFFFFF',
    fontFamily: '"Jolly Lodger", system-ui, serif',
    fontSize: 16,
    letterSpacing: '0.04em',
    transition: 'height 200ms ease, opacity 150ms ease',
    textShadow: `0 0 6px #FFFFFFaa`,
  },
  pullIndicatorText: {
    padding: '8px 12px',
  },
  // Category filter chip strip. Horizontally scrollable row of pill
  // buttons; the active one is filled purple, others are outlined.
  // ---- Static black bottom bar inside eXposure ----
  // Fixed at the bottom of the viewport, never moves on scroll. 4 white
  // SVG icons. Active tab brightens and gets a subtle glow.
  exposureBar: {
    position: 'fixed' as const,
    left: 0, right: 0, bottom: 0,
    height: 56,
    backgroundColor: '#000000',
    borderTop: '1px solid #1a1a1a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-around',
    zIndex: 20,
    paddingBottom: 'env(safe-area-inset-bottom, 0px)' as any,
  },
  exposureBarBtn: {
    flex: 1,
    height: '100%',
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#888',
    padding: 0,
  },
  exposureBarBtnActive: {
    color: '#FFFFFF',
    filter: 'drop-shadow(0 0 6px rgba(255,255,255,0.5))',
  },
  searchInput: {
    width: '100%',
    backgroundColor: '#1a1a1a',
    border: '1px solid #333',
    borderRadius: 10,
    color: '#F0EBE0',
    fontSize: 15,
    padding: '10px 14px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    boxSizing: 'border-box' as const,
    outline: 'none',
  },
  // Sticky search controls — sits directly above the black bottom bar
  // (which is fixed at bottom: 0, height 56). Bottom: 56 anchors this
  // strip right above it. Z-index 19 so it sits under the bar's 20 (so
  // any chip glow doesn't bleed onto the bar visually).
  searchStickyBar: {
    position: 'fixed' as const,
    left: 0, right: 0,
    bottom: 56,
    zIndex: 19,
    backgroundColor: 'rgba(10,10,10,0.95)',
    backdropFilter: 'blur(8px)',
    borderTop: '1px solid #1a1a1a',
    paddingBottom: 'env(safe-area-inset-bottom, 0px)' as any,
  },
  // ---- User profile (IG-style layout) ----
  // Top row: big avatar circle on left, posts/visits/badges stats on right.
  // Matches Instagram's profile header rhythm — avatar size ~86px, stats
  // distributed across the remaining width with center-aligned numbers
  // stacked above small caps labels.
  profileTopRow: {
    display: 'flex',
    alignItems: 'center',
    padding: '18px 16px 10px 16px',
    gap: 16,
    backgroundColor: 'rgba(10,10,10,0.5)',
  },
  // Outer wrap — does NOT clip overflow so the +badge can poke outside
  // the circle. Sized to the same 86x86 as the visible circle since
  // there's no extra space needed; the badge sits in negative-coords
  // territory.
  profileAvatarWrap: {
    width: 86,
    height: 86,
    minWidth: 86,
    position: 'relative' as const,
  },
  // Inner element that actually does the circle clipping. Holds the
  // avatar image. The previous overflow:hidden on the outer wrap was
  // clipping the +badge — moved here so the badge can sit outside.
  profileAvatarCircle: {
    width: 86,
    height: 86,
    borderRadius: '50%',
    overflow: 'hidden',
    border: `2px solid #FFFFFF`,
    boxShadow: `0 0 14px #FFFFFF44`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0a0a0a',
  },
  profileAvatarImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover' as const,
    display: 'block',
    pointerEvents: 'none' as const,
    WebkitUserSelect: 'none' as const,
    WebkitTouchCallout: 'none' as const,
  },
  // Wraps the big profile avatar when it's tappable (own profile only).
  // The wrap itself doesn't clip — the inner circle does — so this
  // button is just a transparent click target the same size as the
  // outer wrap. The +badge inside it sits as a sibling of the inner
  // circle, positioned to poke outside the bottom-right edge.
  profileAvatarEditBtn: {
    width: '100%',
    height: '100%',
    padding: 0,
    margin: 0,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    position: 'relative' as const,
    display: 'block',
  },
  // IG-style "+" badge — sits OUTSIDE the bottom-right of the avatar
  // circle, like Instagram's add-story button. White border separates
  // it from the dark profile background visually so it reads as a
  // distinct floating button rather than glued to the circle.
  profileAvatarEditBadge: {
    position: 'absolute' as const,
    right: -4,
    bottom: -4,
    width: 28,
    height: 28,
    borderRadius: '50%',
    background: '#FF3B5C',
    color: '#FFFFFF',
    fontSize: 18,
    lineHeight: '24px',
    fontWeight: 700 as const,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '3px solid #000',
    pointerEvents: 'none' as const,
    boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
  },
  // Avatar picker modal — bottom sheet style, matches the rest of the
  // app's modal sheets (BlockedListModal, comment composer, etc).
  avatarPickerBackdrop: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.85)',
    zIndex: 10000,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  avatarPickerSheet: {
    width: '100%',
    maxWidth: 520,
    background: '#0a0a0a',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: '12px 16px 24px',
    display: 'flex',
    flexDirection: 'column' as const,
    maxHeight: '85vh',
    overflowY: 'auto' as const,
  },
  avatarPickerHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 8,
  },
  avatarPickerTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 600 as const,
    flex: 1,
    textAlign: 'center' as const,
  },
  avatarPickerCancelBtn: {
    background: 'transparent',
    color: '#FFFFFF',
    border: 'none',
    fontSize: 15,
    width: 60,
    textAlign: 'left' as const,
    padding: 0,
    cursor: 'pointer',
  },
  avatarPickerTabs: {
    display: 'flex',
    gap: 8,
    padding: '8px 0 16px',
  },
  avatarPickerTab: {
    flex: 1,
    padding: '10px 0',
    background: 'transparent',
    color: '#888',
    border: '1px solid #333',
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600 as const,
    cursor: 'pointer',
  },
  avatarPickerTabActive: {
    background: '#FFFFFF',
    color: '#000000',
    borderColor: '#FFFFFF',
  },
  avatarPickerErr: {
    color: '#FF3B5C',
    fontSize: 13,
    padding: '0 0 8px',
    textAlign: 'center' as const,
  },
  avatarPickerGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 10,
  },
  avatarPickerCell: {
    aspectRatio: '1 / 1',
    background: '#1a1a1a',
    border: '2px solid transparent',
    borderRadius: '50%',
    padding: 0,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarPickerCellActive: {
    borderColor: '#FF3B5C',
    boxShadow: '0 0 12px #FF3B5C66',
  },
  avatarPickerCellImg: {
    width: '70%',
    height: '70%',
    objectFit: 'contain' as const,
    pointerEvents: 'none' as const,
  },
  avatarPickerUploadPane: {
    padding: '8px 0',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 16,
  },
  avatarPickerUploadHint: {
    color: '#888',
    fontSize: 13,
    lineHeight: 1.4,
    textAlign: 'center' as const,
    padding: '0 16px',
  },
  avatarPickerUploadBtn: {
    background: '#FFFFFF',
    color: '#000000',
    border: 'none',
    borderRadius: 8,
    padding: '12px 28px',
    fontSize: 15,
    fontWeight: 600 as const,
    cursor: 'pointer',
  },
  avatarPickerRemoveBtn: {
    marginTop: 16,
    background: 'transparent',
    color: '#FF3B5C',
    border: '1px solid #FF3B5C',
    borderRadius: 8,
    padding: '10px 0',
    fontSize: 14,
    fontWeight: 600 as const,
    cursor: 'pointer',
  },
  profileStatsCluster: {
    flex: 1,
    display: 'flex',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  profileStatItem: {
    flex: 1,
    textAlign: 'center' as const,
    padding: 0,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileStatNum: {
    // IG-style: bold sans-serif numerals, same family as the rest of
    // DreadFeed. Was Jolly Lodger which made the profile look like a
    // different app from the post cards / comments / bottom bar.
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: 20,
    fontWeight: 700,
    color: '#F0EBE0',
    letterSpacing: '0.01em',
    lineHeight: 1.1,
  },
  profileStatLabel: {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: 13,
    fontWeight: 400,
    color: '#F0EBE0',
    marginTop: 2,
  },
  // ---- Display-name / bio strip ----
  profileBioWrap: {
    padding: '0 16px 12px 16px',
    backgroundColor: 'rgba(10,10,10,0.5)',
  },
  profileDisplayName: {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    color: '#F0EBE0',
    fontSize: 14,
    fontWeight: 600,
    letterSpacing: '0.01em',
  },
  // Bio body — multi-line, preserves user-entered newlines.
  profileBio: {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    color: '#F0EBE0',
    fontSize: 13,
    lineHeight: 1.45,
    marginTop: 4,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
  },
  // External link, IG-style: blue, no underline, slight visited
  // distinction. Truncates the displayed text (https:// stripped).
  profileLink: {
    display: 'inline-block',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    color: '#5BC0FF',
    fontSize: 13,
    fontWeight: 600 as const,
    textDecoration: 'none',
    marginTop: 6,
    wordBreak: 'break-all' as const,
  },
  // ---- Edit profile modal ----
  editProfileBackdrop: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.85)',
    zIndex: 10000,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  editProfileSheet: {
    width: '100%',
    maxWidth: 520,
    background: '#0a0a0a',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: '12px 16px 24px',
    display: 'flex',
    flexDirection: 'column' as const,
    maxHeight: '92vh',
    overflowY: 'auto' as const,
  },
  editProfileHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 8,
    borderBottom: '1px solid #1a1a1a',
  },
  editProfileTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 600 as const,
    flex: 1,
    textAlign: 'center' as const,
  },
  editProfileCancelBtn: {
    background: 'transparent',
    color: '#FFFFFF',
    border: 'none',
    fontSize: 15,
    minWidth: 64,
    textAlign: 'left' as const,
    padding: 0,
    cursor: 'pointer',
  },
  editProfileSaveBtn: {
    background: 'transparent',
    color: '#5BC0FF',
    border: 'none',
    fontSize: 15,
    fontWeight: 700 as const,
    minWidth: 64,
    textAlign: 'right' as const,
    padding: 0,
    cursor: 'pointer',
  },
  editProfileErr: {
    color: '#FF3B5C',
    fontSize: 13,
    padding: '8px 0',
    textAlign: 'center' as const,
  },
  editProfileBody: {
    paddingTop: 16,
    display: 'flex',
    flexDirection: 'column' as const,
  },
  editProfileFieldLabel: {
    color: '#888',
    fontSize: 12,
    fontWeight: 600 as const,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginTop: 12,
    marginBottom: 6,
  },
  editProfileInput: {
    width: '100%',
    background: '#1a1a1a',
    border: '1px solid #333',
    borderRadius: 8,
    color: '#F0EBE0',
    fontSize: 15,
    padding: '10px 12px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    boxSizing: 'border-box' as const,
    outline: 'none',
  },
  editProfileTextarea: {
    width: '100%',
    background: '#1a1a1a',
    border: '1px solid #333',
    borderRadius: 8,
    color: '#F0EBE0',
    fontSize: 15,
    padding: '10px 12px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    resize: 'vertical' as const,
    minHeight: 80,
    boxSizing: 'border-box' as const,
    outline: 'none',
    lineHeight: 1.4,
  },
  editProfileCounter: {
    color: '#666',
    fontSize: 11,
    textAlign: 'right' as const,
    marginTop: 4,
  },
  editProfileHint: {
    color: '#888',
    fontSize: 11,
    marginTop: 6,
  },
  // ---- IG-style action button row ----
  profileActionsRow: {
    display: 'flex',
    gap: 8,
    padding: '4px 16px 14px 16px',
    backgroundColor: 'rgba(10,10,10,0.5)',
    borderBottom: `1px solid #2a2a2a`,
  },
  profileActionBtn: {
    flex: 1,
    padding: '8px 12px',
    backgroundColor: '#1a1a1a',
    color: '#F0EBE0',
    border: '1px solid #333',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: '0.02em',
    cursor: 'pointer',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  // Follow buttons. Filled white when NOT following (call-to-action),
  // outlined when already following (less visually loud). Matches IG.
  profileFollowBtn: {
    flex: 1,
    padding: '8px 12px',
    backgroundColor: '#FFFFFF',
    color: '#000000',
    border: '1px solid #FFFFFF',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '0.02em',
    cursor: 'pointer',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  profileFollowingBtn: {
    flex: 1,
    padding: '8px 12px',
    backgroundColor: '#1a1a1a',
    color: '#F0EBE0',
    border: '1px solid #333',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: '0.02em',
    cursor: 'pointer',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  // Inline Follow button on feed cards — smaller than the profile-page
  // version. Sits between the handle column and the 3-dot menu. IG-style
  // gray rounded rect.
  postFollowBtn: {
    padding: '5px 12px',
    marginRight: 4,
    backgroundColor: '#1f1f1f',
    color: '#F0EBE0',
    border: '1px solid #333',
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.02em',
    cursor: 'pointer',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    whiteSpace: 'nowrap' as const,
  },
  postFollowBtnFollowing: {
    padding: '5px 12px',
    marginRight: 4,
    backgroundColor: 'transparent',
    color: '#888',
    border: '1px solid #333',
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: '0.02em',
    cursor: 'pointer',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    whiteSpace: 'nowrap' as const,
  },
  // Confirm-delete-post modal — centered card, not a sheet. Two buttons.
  confirmBackdrop: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.85)',
    zIndex: 10001,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  confirmCard: {
    width: '100%',
    maxWidth: 360,
    background: '#0a0a0a',
    border: '1px solid #222',
    borderRadius: 14,
    padding: 20,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  },
  confirmTitle: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: 700 as const,
    textAlign: 'center' as const,
  },
  confirmBody: {
    color: '#aaa',
    fontSize: 13,
    lineHeight: 1.45,
    textAlign: 'center' as const,
    padding: '0 4px',
  },
  confirmActions: {
    display: 'flex',
    gap: 10,
    marginTop: 8,
  },
  confirmCancelBtn: {
    flex: 1,
    padding: '10px 0',
    background: 'transparent',
    color: '#FFFFFF',
    border: '1px solid #333',
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600 as const,
    cursor: 'pointer',
  },
  confirmDeleteBtn: {
    flex: 1,
    padding: '10px 0',
    background: '#FF3B5C',
    color: '#FFFFFF',
    border: 'none',
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 700 as const,
    cursor: 'pointer',
  },
  // ---- Follow / For You segmented toggle at top of feed ----
  // Two flush buttons under the brand header. Active state gets bold
  // white text + a 2px underline; inactive is greyed out. IG-style.
  feedModeRow: {
    display: 'flex',
    backgroundColor: '#000',
    borderBottom: '1px solid #1a1a1a',
  },
  feedModeBtn: {
    flex: 1,
    padding: '12px 0',
    backgroundColor: 'transparent',
    color: '#888888',
    border: 'none',
    borderBottom: '2px solid transparent',
    fontSize: 14,
    fontWeight: 600,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
  },
  feedModeBtnActive: {
    flex: 1,
    padding: '12px 0',
    backgroundColor: 'transparent',
    color: '#FFFFFF',
    border: 'none',
    borderBottom: '2px solid #FFFFFF',
    fontSize: 14,
    fontWeight: 700,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
  },
  // ---- DreadFeed Claim Screen (Profile tab when no handle) ----
  // Full-height centered claim form. Sits in the same scrollable area
  // that the profile would normally occupy, so it slots cleanly into
  // the existing SocialView layout (brand header above, bottom bar
  // below). No background image — pure black to match the IG-style
  // sign-up aesthetic.
  dreadFeedClaimWrap: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingTop: 40,
    paddingBottom: 120,
    minHeight: 'calc(100vh - 220px)',
  },
  dreadFeedClaimInner: {
    width: '100%',
    maxWidth: 360,
    padding: '0 24px',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'stretch',
  },
  dreadFeedClaimTitle: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: 700,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    textAlign: 'center' as const,
    marginBottom: 8,
  },
  dreadFeedClaimSubtitle: {
    color: '#888888',
    fontSize: 13,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    textAlign: 'center' as const,
    marginBottom: 24,
    lineHeight: 1.4,
  },
  dreadFeedClaimInput: {
    backgroundColor: '#0f0f0f',
    color: '#FFFFFF',
    border: '1px solid #333',
    borderRadius: 8,
    padding: '12px 14px',
    fontSize: 16,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    outline: 'none',
    marginBottom: 6,
  } as any,
  dreadFeedClaimStatus: {
    fontSize: 12,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    marginBottom: 14,
    letterSpacing: '0.04em',
  },
  dreadFeedClaimBtn: {
    backgroundColor: '#FFFFFF',
    color: '#000000',
    border: 'none',
    borderRadius: 8,
    padding: '12px 14px',
    fontSize: 15,
    fontWeight: 700,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
    marginTop: 8,
  },
  dreadFeedClaimBtnDisabled: {
    backgroundColor: '#222',
    color: '#666',
    border: 'none',
    borderRadius: 8,
    padding: '12px 14px',
    fontSize: 15,
    fontWeight: 700,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'default',
    marginTop: 8,
  },
  dreadFeedClaimError: {
    color: '#ff6b6b',
    fontSize: 13,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    marginTop: 10,
    textAlign: 'center' as const,
  },
  dreadFeedClaimFooter: {
    color: '#666',
    fontSize: 11,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    textAlign: 'center' as const,
    marginTop: 16,
    letterSpacing: '0.03em',
  },
  // ---- Gear icon bar above profile (own profile only) ----
  // Sits as a small right-aligned strip above the profileTopRow when
  // viewing your own profile, so the settings entry is obvious and
  // reachable without sacrificing the IG-style stats layout below.
  profileSettingsBar: {
    display: 'flex',
    justifyContent: 'flex-end',
    padding: '8px 12px 0 12px',
    backgroundColor: 'rgba(10,10,10,0.5)',
  },
  profileSettingsBtn: {
    width: 40,
    height: 40,
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  // ---- Settings screen ----
  settingsWrap: {
    minHeight: '100vh',
    backgroundColor: '#000',
    paddingBottom: 40,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  settingsHeaderBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 'calc(env(safe-area-inset-top, 44px) + 12px) 14px 12px 14px' as any,
    borderBottom: '1px solid #1a1a1a',
    backgroundColor: '#000',
    position: 'sticky' as const,
    top: 0,
    zIndex: 5,
  },
  settingsBackBtn: {
    width: 36,
    height: 36,
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  settingsHeaderTitle: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: 600,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  settingsSectionLabel: {
    color: '#666',
    fontSize: 12,
    letterSpacing: '0.1em',
    textTransform: 'uppercase' as const,
    padding: '20px 16px 8px 16px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  settingsRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    padding: '14px 16px',
    backgroundColor: 'transparent',
    border: 'none',
    borderTop: '1px solid #1a1a1a',
    borderBottom: '1px solid #1a1a1a',
    cursor: 'pointer',
    textAlign: 'left' as const,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  settingsRowTextCol: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
    flex: 1,
    minWidth: 0,
  },
  settingsRowLabel: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: 500,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  settingsRowSublabel: {
    color: '#888',
    fontSize: 12,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  settingsRowChevron: {
    marginLeft: 12,
    display: 'flex',
    alignItems: 'center',
  },
  settingsEmpty: {
    padding: 40,
    textAlign: 'center' as const,
    color: '#888',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  settingsFooter: {
    padding: '32px 16px 16px',
    textAlign: 'center' as const,
    color: '#444',
    fontSize: 11,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  // ---- Centered Modal (shared by add-email, verify, blocked, delete, report) ----
  modalOverlay: {
    position: 'fixed' as const,
    top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 250,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  modalBackdrop: {
    position: 'absolute' as const,
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  modalPanel: {
    position: 'relative' as const,
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#0c0c0c',
    border: '1px solid #2a2a2a',
    borderRadius: 14,
    overflow: 'hidden' as const,
    boxShadow: '0 20px 50px rgba(0,0,0,0.6)',
  },
  modalHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 12px',
    borderBottom: '1px solid #1a1a1a',
  },
  modalTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: 600,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  modalCloseBtn: {
    width: 32,
    height: 32,
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  modalBody: {
    padding: '14px 16px 16px 16px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  },
  modalText: {
    color: '#F0EBE0',
    fontSize: 14,
    lineHeight: 1.4,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  modalInput: {
    width: '100%',
    backgroundColor: '#0f0f0f',
    color: '#FFFFFF',
    border: '1px solid #333',
    borderRadius: 8,
    padding: '12px 14px',
    fontSize: 15,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    outline: 'none',
    boxSizing: 'border-box' as const,
  } as any,
  modalBtnPrimary: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    color: '#000',
    border: 'none',
    borderRadius: 8,
    padding: '12px',
    fontSize: 14,
    fontWeight: 700,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
  },
  modalBtnDisabled: {
    width: '100%',
    backgroundColor: '#1a1a1a',
    color: '#666',
    border: 'none',
    borderRadius: 8,
    padding: '12px',
    fontSize: 14,
    fontWeight: 700,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'default',
  },
  modalBtnDanger: {
    width: '100%',
    backgroundColor: '#a02828',
    color: '#FFFFFF',
    border: 'none',
    borderRadius: 8,
    padding: '12px',
    fontSize: 14,
    fontWeight: 700,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
  },
  modalError: {
    color: '#ff6b6b',
    fontSize: 13,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  // ---- Blocked-list row inside the modal ----
  blockedRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    padding: '8px 0',
    borderBottom: '1px solid #1a1a1a',
  },
  blockedHandle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  blockedUnblockBtn: {
    backgroundColor: 'transparent',
    color: '#FFFFFF',
    border: '1px solid #333',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
  },
  // ---- Report-modal reason buttons ----
  reasonBtn: {
    width: '100%',
    textAlign: 'left' as const,
    backgroundColor: '#0f0f0f',
    color: '#F0EBE0',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    padding: '10px 12px',
    fontSize: 14,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
  },
  reasonBtnActive: {
    width: '100%',
    textAlign: 'left' as const,
    backgroundColor: '#1a1a1a',
    color: '#FFFFFF',
    border: '1px solid #FFFFFF',
    borderRadius: 8,
    padding: '10px 12px',
    fontSize: 14,
    fontWeight: 600,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
  },
  // Row inside the followers / following bottom sheet. Avatar on left,
  // handle column on right, tap navigates / closes the sheet.
  handleListRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 14px',
    width: '100%',
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    textAlign: 'left' as const,
  },
  // ---- Tab strip above the grid ----
  profileTabStrip: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    padding: '10px 0 8px 0',
    backgroundColor: 'rgba(10,10,10,0.5)',
    borderBottom: `1px solid #2a2a2a`,
  },
  profileTabActive: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#FFFFFF',
    padding: '4px 18px',
    borderBottom: `2px solid #FFFFFF`,
  },
  // ---- 3-column thumbnail grid (IG-style) ----
  // 2px gaps to give the unmistakable IG-grid look without the bright
  // white separators IG itself uses. Each cell is a perfect square via
  // aspect-ratio so the grid stays tidy even before the images load.
  profileGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 2,
    padding: 0,
    backgroundColor: '#000',
  },
  profileGridCell: {
    aspectRatio: '1 / 1',
    background: '#0a0a0a',
    border: 'none',
    padding: 0,
    margin: 0,
    overflow: 'hidden',
    cursor: 'pointer',
    position: 'relative' as const,
  },
  profileGridImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover' as const,
    display: 'block',
    pointerEvents: 'none' as const,
    WebkitUserSelect: 'none' as const,
    WebkitTouchCallout: 'none' as const,
  },
  // Small ▶ badge overlaid on video-post thumbnails in the profile grid.
  // Anchored to the top-right corner. Visually consistent with IG's
  // little corner indicator for Reels/video posts in the profile grid.
  profileGridVideoBadge: {
    position: 'absolute' as const,
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: '50%',
    backgroundColor: 'rgba(0,0,0,0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none' as const,
  },
  // ---- HashtagView (v1.14) ----
  // Dedicated screen for a single #tag. Header on top, then the same
  // 3-column thumbnail grid the profile view uses.
  hashtagViewWrap: {
    backgroundColor: '#0a0a0a',
    minHeight: '100vh',
    color: '#F0EBE0',
    // Push content below the iOS status bar / notch. env() inset
    // resolves to ~44-50px on modern iPhones; fallback ~50px keeps
    // it sane on devices/browsers that don't expose the env var.
    paddingTop: 'env(safe-area-inset-top, 50px)' as any,
  },
  hashtagHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '14px 12px 12px',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
  },
  hashtagBackBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    background: 'transparent',
    border: 'none',
    color: '#F0EBE0',
    fontSize: 24,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  hashtagHeaderText: {
    display: 'flex',
    flexDirection: 'column' as const,
  },
  hashtagHeaderTitle: {
    fontSize: 20,
    fontWeight: 700,
    color: '#F0EBE0',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  hashtagHeaderSub: {
    fontSize: 13,
    color: '#888',
    marginTop: 2,
  },
  hashtagEmpty: {
    padding: '40px 20px',
    textAlign: 'center' as const,
    color: '#888',
    fontSize: 14,
  },
  // ---- DM Inbox / Thread (v1.15) ----
  // Inbox list. Vertical stack of conversation rows under the safe-area
  // header (same chrome as HashtagView).
  dmInboxList: {
    display: 'flex',
    flexDirection: 'column' as const,
  },
  dmInboxRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 14px',
    background: 'transparent',
    border: 'none',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
    color: '#F0EBE0',
    cursor: 'pointer',
    width: '100%',
    textAlign: 'left' as const,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  // Round avatar bubble. No image fetched yet — falls back to first
  // letter of the other handle on a colored background.
  dmInboxAvatar: {
    width: 44,
    height: 44,
    borderRadius: '50%',
    backgroundColor: '#FF3B5C',
    color: '#FFFFFF',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 700,
    fontSize: 18,
    flexShrink: 0,
  },
  dmInboxBody: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
  },
  dmInboxHandle: {
    fontSize: 15,
    fontWeight: 600,
    color: '#F0EBE0',
  },
  dmInboxPreview: {
    fontSize: 13,
    color: '#888',
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  // When there's unread, the preview goes brighter + heavier — same
  // visual cue IG uses.
  dmInboxPreviewUnread: {
    color: '#F0EBE0',
    fontWeight: 600,
  },
  dmInboxBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    padding: '0 7px',
    backgroundColor: '#FF3B5C',
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  // Thread view — full-height column. Scroll area in middle, composer
  // pinned to bottom with safe-area bottom inset.
  dmThreadWrap: {
    backgroundColor: '#0a0a0a',
    color: '#F0EBE0',
    height: '100vh',
    display: 'flex',
    flexDirection: 'column' as const,
    paddingTop: 'env(safe-area-inset-top, 50px)' as any,
  },
  dmThreadScroll: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '8px 12px 16px',
  },
  dmBubbleRow: {
    display: 'flex',
    width: '100%',
    margin: '4px 0',
  },
  // Bubble base styling — own messages are pink/red, other's are grey.
  dmBubble: {
    maxWidth: '78%',
    padding: '8px 14px',
    borderRadius: 18,
    fontSize: 15,
    lineHeight: 1.35,
    wordBreak: 'break-word' as const,
    whiteSpace: 'pre-wrap' as const,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  dmBubbleOwn: {
    backgroundColor: '#FF3B5C',
    color: '#FFFFFF',
  },
  dmBubbleOther: {
    backgroundColor: '#2a2a2a',
    color: '#F0EBE0',
  },
  // Composer pinned to the bottom — textarea + Send button.
  dmComposer: {
    display: 'flex',
    gap: 8,
    padding: '10px 12px',
    paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 10px)' as any,
    borderTop: '1px solid rgba(255,255,255,0.08)',
    backgroundColor: '#0a0a0a',
    alignItems: 'flex-end',
  },
  dmComposerInput: {
    flex: 1,
    minHeight: 36,
    maxHeight: 120,
    padding: '8px 12px',
    borderRadius: 18,
    backgroundColor: '#1a1a1a',
    border: '1px solid rgba(255,255,255,0.12)',
    color: '#F0EBE0',
    fontSize: 15,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    resize: 'none' as const,
    outline: 'none',
  },
  dmComposerSend: {
    padding: '8px 16px',
    borderRadius: 18,
    backgroundColor: '#FF3B5C',
    color: '#FFFFFF',
    border: 'none',
    fontSize: 14,
    fontWeight: 700,
    cursor: 'pointer',
    flexShrink: 0,
  },
  // ---- Post detail (IG-style swipe-through viewer) ----
  // Small chip just below the brand header showing "N / total" so the
  // user has IG-style orientation while swiping between posts.
  postDetailIndicator: {
    textAlign: 'center' as const,
    padding: '8px 12px 4px 12px',
    color: '#FFFFFF',
    fontSize: 12,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontWeight: 600,
    letterSpacing: '0.12em',
  },
  // Hint row at the bottom of the post card. Tells the user a vertical
  // swipe is available — fades into the background once they get the idea.
  postDetailHintRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '12px 20px 32px 20px',
    gap: 12,
    flexWrap: 'wrap' as const,
  },
  postDetailHint: {
    color: '#666',
    fontSize: 11,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    letterSpacing: '0.06em',
    textTransform: 'uppercase' as const,
  },
  socialHeaderTitle: {
    color: '#FFFFFF',
    fontSize: 22,
    fontFamily: '"Jolly Lodger", system-ui, serif',
    fontWeight: 400,
    letterSpacing: '0.04em',
    textShadow: `0 0 10px #FFFFFFaa`,
  },
  socialEmpty: {
    textAlign: 'center' as const,
    padding: '60px 24px',
    color: '#999',
    fontSize: 15,
    lineHeight: 1.6,
  },
  socialFeed: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 18,
    padding: '14px 12px',
    maxWidth: 600,
    margin: '0 auto',
  },
  // ---- Instagram-style post card ----
  // No card border or background — cards bleed into the black page so
  // photos look edge-to-edge like Instagram. Only the photo itself has
  // a small corner radius (per Drew's request for slightly rounded edges).
  postCard: {
    backgroundColor: 'transparent',
    border: 'none',
    borderRadius: 0,
    overflow: 'visible',
    marginBottom: 20,
  },
  // Small grey banner above the post card when this feed entry is a
  // repost. Mirrors IG's "Reposted by X" line — quiet, ~12px, neutral
  // grey to avoid stealing attention from the post itself.
  repostBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 12px 0',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  repostBannerText: {
    fontSize: 12,
    color: '#8a8a8a',
    fontWeight: 500,
  },
  repostBannerHandle: {
    color: '#F0EBE0',
    fontWeight: 600,
  },
  postHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 12px',
  },
  // Avatar — 36px circle with a thin neon-purple ring to keep the
  // eXposure identity visible on the otherwise IG-neutral card.
  postAvatarBtn: {
    width: 36,
    height: 36,
    minWidth: 36,
    borderRadius: '50%',
    padding: 0,
    background: 'linear-gradient(45deg, #FFFFFF, #FF3B5C)',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden' as const,
  },
  postAvatarImg: {
    width: 32,
    height: 32,
    borderRadius: '50%',
    objectFit: 'cover' as const,
    backgroundColor: '#000',
    border: '2px solid #000',
    pointerEvents: 'none' as const,
  },
  postHeaderTextCol: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    minWidth: 0,
  },
  postHeaderLine1: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  postHeaderDot: {
    color: '#888',
    fontSize: 13,
  },
  postHandle: {
    color: '#F0EBE0',
    fontSize: 14,
    fontWeight: 700,
  },
  // Inline tappable handle — looks like text, behaves like a link.
  // No purple glow on the post card (different visual context than the
  // bottom bar); pure white IG-style.
  postHandleBtn: {
    color: '#F0EBE0',
    fontSize: 14,
    fontWeight: 700,
    letterSpacing: 0,
    backgroundColor: 'transparent',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  postTime: {
    color: '#888',
    fontSize: 13,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  // Location chip below the handle — Instagram-style small location text.
  // Tappable; opens the site detail page. Only rendered for site-tagged
  // posts (freeform posts don't have a siteTitle).
  postLocationBtn: {
    alignSelf: 'flex-start' as const,
    color: '#F0EBE0',
    fontSize: 12,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    backgroundColor: 'transparent',
    border: 'none',
    padding: '1px 0 0 0',
    cursor: 'pointer',
    textAlign: 'left' as const,
  },
  postMenuBtn: {
    color: '#F0EBE0',
    fontSize: 22,
    backgroundColor: 'transparent',
    border: 'none',
    padding: '0 4px',
    cursor: 'pointer',
    lineHeight: 1,
    opacity: 0.6,
  },
  // Photo — slightly rounded corners (8px) per request. Edge-to-edge
  // otherwise. 4:5 portrait matches Instagram's default feed aspect ratio
  // (1080×1350), giving taller cards that show more of vertical phone
  // photos without needing a tap-to-expand. Wider source images get
  // center-cropped on the sides via objectFit: cover, same as IG.
  postPhoto: {
    width: '100%',
    display: 'block',
    aspectRatio: '4 / 5',
    objectFit: 'cover' as const,
    backgroundColor: '#111',
    borderRadius: 8,
  },
  // ---- Multi-photo carousel (v1.12) ----
  // Wraps the scroller + dots + "1/N" badge. Position relative so the
  // badge can anchor top-right over the photos.
  postCarouselWrap: {
    position: 'relative' as const,
    width: '100%',
  },
  // Horizontal snap-scroller. Each slide is 100% width; the browser
  // snaps to the nearest one when the user releases their finger.
  // scrollbar is hidden globally so the white bar never shows here.
  postCarouselScroller: {
    display: 'flex',
    overflowX: 'auto' as const,
    overflowY: 'hidden' as const,
    scrollSnapType: 'x mandatory' as const,
    WebkitOverflowScrolling: 'touch' as any,
    overscrollBehaviorX: 'contain' as const,
    width: '100%',
  },
  // Single slide inside the scroller. Each takes full width; snaps to
  // start so the active photo always aligns to the left edge. Width
  // and minWidth both set to 100% — flexbox needs both to behave
  // correctly with overflow.
  postCarouselSlide: {
    flex: '0 0 100%',
    width: '100%',
    minWidth: '100%',
    scrollSnapAlign: 'start' as const,
    padding: 0,
    margin: 0,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    display: 'block',
  },
  // Page dots, absolute-positioned below the photo area. Translucent
  // white circles, the active one is solid blue (matches IG).
  postCarouselDots: {
    position: 'absolute' as const,
    bottom: 8,
    left: 0,
    right: 0,
    display: 'flex',
    justifyContent: 'center',
    gap: 4,
    pointerEvents: 'none' as const,
  },
  postCarouselDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    backgroundColor: 'rgba(255,255,255,0.45)',
    transition: 'background-color 0.2s ease',
  },
  postCarouselDotActive: {
    backgroundColor: '#3FA9FF',
  },
  // "1/4" badge top-right of the photo. Same translucent-black pill
  // IG uses on carousels.
  postCarouselBadge: {
    position: 'absolute' as const,
    top: 10,
    right: 10,
    padding: '2px 8px',
    backgroundColor: 'rgba(0,0,0,0.6)',
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 600,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    borderRadius: 12,
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
    pointerEvents: 'none' as const,
  },
  // Actions row — Instagram-style outlined icons, left-aligned with
  // share pushed to the right via the spacer between buttons.
  postActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '8px 12px 2px',
  },
  postIconBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    WebkitTapHighlightColor: 'transparent' as any,
  },
  // Bold "1,234 likes" line above the caption. Matches IG.
  postLikeCount: {
    padding: '2px 14px',
    color: '#F0EBE0',
    fontSize: 14,
    fontWeight: 700,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  // Caption line — handle in bold inline, then caption text. IG-style
  // wrapping where the handle and caption flow as one paragraph.
  postCaptionLine: {
    padding: '4px 14px 8px',
    color: '#F0EBE0',
    fontSize: 14,
    lineHeight: 1.4,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  postCaptionHandle: {
    color: '#F0EBE0',
    fontSize: 14,
    fontWeight: 700,
    backgroundColor: 'transparent',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  postCaptionText: {
    color: '#F0EBE0',
    fontSize: 14,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
  },
  // Same visual as postCaptionText but renders as a button that opens
  // the comment sheet on tap. IG works this way — tapping the caption
  // text takes you straight into comments. Removing button chrome so
  // the user just sees plain caption text.
  postCaptionTextBtn: {
    color: '#F0EBE0',
    fontSize: 14,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    background: 'none',
    border: 'none',
    padding: 0,
    margin: 0,
    cursor: 'pointer',
    textAlign: 'left' as const,
    display: 'inline',
  },
  // Small numeric badge next to the comment icon — shows the comment
  // count when > 0. Sits to the right of the icon inside the same
  // button so it taps as a single target.
  postIconBtnCount: {
    color: '#F0EBE0',
    fontSize: 14,
    fontWeight: 600,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    marginLeft: 6,
  },
  // "View all N comments" button below the caption, IG-style. Plain
  // grey text, no chrome, opens the comment sheet on tap.
  postViewCommentsBtn: {
    display: 'block',
    padding: '0 14px 8px 14px',
    color: '#888888',
    fontSize: 14,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    textAlign: 'left' as const,
  },
  // Container for inline comment preview rows under each feed card.
  // Sits between View-all link and the next post; small vertical
  // padding keeps the section readable without crowding the photo grid.
  postLatestComments: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
    padding: '0 14px 8px 14px',
  },
  // Single preview row. The whole row is a button so tap anywhere opens
  // the sheet. Visual: handle bold, body inline — same IG layout.
  postLatestCommentRow: {
    display: 'block',
    background: 'none',
    border: 'none',
    padding: 0,
    margin: 0,
    cursor: 'pointer',
    textAlign: 'left' as const,
    fontSize: 14,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    lineHeight: 1.35,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
    color: '#F0EBE0',
  },
  postLatestCommentHandle: {
    fontWeight: 600,
    color: '#F0EBE0',
  },
  postLatestCommentBody: {
    color: '#F0EBE0',
  },
  // ---- Comment Sheet (IG-style bottom sheet) ----
  // Full-viewport overlay that catches taps for backdrop dismiss.
  commentSheetOverlay: {
    position: 'fixed' as const,
    top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 200,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  // Backdrop layer — sits behind the sheet, tap to dismiss. Pure
  // transparent black; the post photo above still shows through dimly.
  commentSheetBackdrop: {
    position: 'absolute' as const,
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  // The sliding panel itself. Black background, rounded top corners,
  // takes 78% of viewport height (per IG). Transform is set inline on
  // the element so we can drive the slide animation. Background is
  // Apple's secondary-surface gray (#1c1c1e), matching Instagram's
  // comment sheet exactly — gives the sheet clear elevation above the
  // black post area behind it.
  commentSheetPanel: {
    position: 'relative' as const,
    width: '100%',
    maxWidth: 600,
    height: '78vh',
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    display: 'flex',
    flexDirection: 'column' as const,
    boxShadow: '0 -8px 28px rgba(0,0,0,0.6)',
    overflow: 'hidden' as const,
  },
  // The drag-handle "grab area" at the very top. Larger than the visible
  // pill so the touch target is friendly (44px tall).
  commentSheetHandleArea: {
    width: '100%',
    height: 22,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 8,
    paddingBottom: 4,
    cursor: 'grab',
    touchAction: 'none' as const,
  },
  // The visible grey pill inside the handle area.
  commentSheetHandlePill: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#555555',
  },
  // Header — "Comments" centered, share icon right.
  commentSheetHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 14px 10px 14px',
    borderBottom: '1px solid #2a2a2a',
  },
  commentSheetTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 700,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  commentSheetCloseBtn: {
    width: 40,
    height: 32,
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  // Scrollable list region. overscrollBehavior:'contain' is the key fix
  // for v1.11 — without it, iOS Safari chains scroll events to the body
  // when the list reaches its top or bottom, causing the feed underneath
  // to scroll. Containing the scroll keeps it isolated to this region.
  commentSheetList: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '8px 0 12px 0',
    WebkitOverflowScrolling: 'touch' as any,
    overscrollBehavior: 'contain' as const,
  },
  commentSheetEmpty: {
    textAlign: 'center' as const,
    padding: '60px 24px',
    color: '#888888',
    fontSize: 15,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  // Per-comment row: avatar | body column | like column.
  commentRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '10px 14px',
  },
  commentAvatar: {
    width: 36,
    height: 36,
    minWidth: 36,
    borderRadius: '50%',
    objectFit: 'cover' as const,
    pointerEvents: 'none' as const,
  },
  // Smaller avatar for nested reply rows. The indented row already has
  // a 56px paddingLeft pushing it inward; a 28px avatar keeps the visual
  // rhythm right without making the row look cramped.
  commentAvatarReply: {
    width: 28,
    height: 28,
    minWidth: 28,
    borderRadius: '50%',
    objectFit: 'cover' as const,
    pointerEvents: 'none' as const,
  },
  // "Reply" link under each comment body. Plain text, low-prominence
  // gray so it doesn't compete with the comment itself.
  commentReplyBtn: {
    background: 'none',
    border: 'none',
    padding: '4px 0 0 0',
    margin: 0,
    color: '#888888',
    fontSize: 12,
    fontWeight: 600,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
    alignSelf: 'flex-start',
  },
  // "View N replies" / "Hide replies" toggle. IG mimics this with a
  // short horizontal line followed by the text, indented to align with
  // where the parent comment's body starts (i.e. past the avatar gutter).
  commentRepliesToggle: {
    background: 'none',
    border: 'none',
    margin: '2px 0 8px 56px',
    padding: '4px 0',
    color: '#888888',
    fontSize: 12,
    fontWeight: 600,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  commentRepliesToggleLine: {
    display: 'inline-block',
    width: 24,
    height: 1,
    backgroundColor: '#555555',
  },
  // "Replying to @X" pill that sits above the composer when in reply mode.
  commentReplyPill: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 14px',
    backgroundColor: '#262626',
    borderTop: '1px solid #2a2a2a',
    fontSize: 12,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  commentReplyPillText: {
    color: '#aaaaaa',
  },
  commentReplyPillHandle: {
    color: '#ffffff',
    fontWeight: 600,
  },
  commentReplyPillClose: {
    background: 'none',
    border: 'none',
    color: '#aaaaaa',
    fontSize: 14,
    cursor: 'pointer',
    padding: 4,
    lineHeight: 1,
  },
  commentBodyCol: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
    minWidth: 0,
  },
  commentMetaLine: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap' as const,
  },
  commentHandle: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  commentTime: {
    color: '#888888',
    fontSize: 12,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  // Pinned "Author" badge on the post author's own comments.
  commentAuthorBadge: {
    color: '#888888',
    fontSize: 11,
    fontWeight: 600,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    padding: '1px 6px',
    border: '1px solid #444',
    borderRadius: 6,
    letterSpacing: '0.05em',
  },
  commentBodyText: {
    color: '#FFFFFF',
    fontSize: 14,
    lineHeight: 1.35,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    wordBreak: 'break-word' as const,
  },
  // Like button column on each comment row.
  commentLikeBtn: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 2,
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: '6px 4px',
    minWidth: 30,
  },
  commentLikeCount: {
    color: '#888888',
    fontSize: 11,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  // Quick-emoji row above the input. v1.11: 20 horror emojis, horizontally
  // scrollable since "space-around" packing 20 of these would shrink them
  // to thumbnails. flex-start + overflow-x lets the row read at native size
  // and lets users swipe through. flexShrink:0 on the button keeps each
  // emoji from squishing.
  commentSheetEmojiRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '10px 8px 8px 8px',
    borderTop: '1px solid #2a2a2a',
    overflowX: 'auto',
    WebkitOverflowScrolling: 'touch',
  },
  commentSheetEmojiBtn: {
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    fontSize: 24,
    padding: 4,
    lineHeight: 1,
    flexShrink: 0,
  },
  // Composer row at the bottom: avatar + input + Post button.
  // Uses safe-area-inset-bottom so it doesn't collide with the iOS
  // home indicator. Background inherits from the panel (#1c1c1e) so
  // the composer reads as part of the same surface, not a darker strip.
  commentSheetComposer: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 14px 8px 14px',
    paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 8px)' as any,
    borderTop: '1px solid #2a2a2a',
    backgroundColor: '#1c1c1e',
  },
  commentSheetComposerAvatar: {
    width: 28,
    height: 28,
    minWidth: 28,
    borderRadius: '50%',
    objectFit: 'cover' as const,
    pointerEvents: 'none' as const,
  },
  commentSheetComposerInput: {
    flex: 1,
    backgroundColor: 'transparent',
    border: 'none',
    outline: 'none',
    color: '#FFFFFF',
    fontSize: 14,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    padding: '8px 0',
  } as any,
  commentSheetComposerPostBtn: {
    backgroundColor: 'transparent',
    border: 'none',
    color: '#3897F0',                       // IG blue
    fontSize: 14,
    fontWeight: 700,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
    padding: '8px 4px',
  },
  // ---- Deprecated post styles (kept for backwards compat in case other
  // code references them; not used by the current SocialPostCard) ----
  postLikeBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: 4,
  },
  postShareBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    color: '#BBB',
    marginLeft: 'auto' as const,
  },
  postCaption: {
    padding: '4px 14px 10px',
    color: '#E8E5DC',
    fontSize: 14,
    lineHeight: 1.45,
  },
  postSiteBtn: {
    display: 'block',
    width: '100%',
    textAlign: 'left' as const,
    padding: '10px 14px',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderTop: `1px solid #2a2a2a`,
    border: 'none',
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: '0.04em',
    cursor: 'pointer',
  },

  // ---- DetailView "Add Photo" flow ----
  addPhotoBtn: {
    width: '100%',
    padding: '14px 16px',
    marginTop: 12,
    backgroundColor: 'rgba(255,255,255,0.05)',
    border: `2px solid #FFFFFF`,
    color: '#FFFFFF',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: 18,
    fontWeight: 700,
    letterSpacing: '0.18em',
    textTransform: 'uppercase' as const,
    borderRadius: 12,
    cursor: 'pointer',
    boxShadow: `0 0 14px #FFFFFF44, inset 0 0 10px #FFFFFF22`,
    textShadow: `0 0 8px #FFFFFFaa`,
  },
  addPhotoBtnDisabled: {
    width: '100%',
    padding: '14px 16px',
    marginTop: 12,
    backgroundColor: 'rgba(0,0,0,0.3)',
    border: `1.5px solid #333`,
    color: '#666',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '0.18em',
    textTransform: 'uppercase' as const,
    borderRadius: 12,
    cursor: 'not-allowed',
  },
  postComposerOverlay: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0,0,0,0.92)',
    zIndex: 40,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  postComposerCard: {
    width: '100%',
    maxWidth: 460,
    backgroundColor: '#141414',
    border: `1.5px solid #FFFFFF`,
    borderRadius: 16,
    padding: 18,
    boxShadow: `0 0 30px #FFFFFF22`,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 14,
  },
  postComposerTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: 800,
    letterSpacing: '0.22em',
    textTransform: 'uppercase' as const,
    textAlign: 'center' as const,
  },
  postComposerPreview: {
    width: '100%',
    aspectRatio: '1 / 1',
    objectFit: 'cover' as const,
    backgroundColor: '#000',
    borderRadius: 10,
  },
  postCaptionInput: {
    width: '100%',
    backgroundColor: '#0a0a0a',
    border: `1px solid #333`,
    borderRadius: 8,
    color: '#F0EBE0',
    fontSize: 18,
    padding: '10px 12px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    resize: 'none' as const,
    minHeight: 60,
    boxSizing: 'border-box' as const,
  },
  postShareToggleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 4px',
    color: '#BBB',
    fontSize: 13,
    cursor: 'pointer',
  },
  postComposerBtnRow: {
    display: 'flex',
    gap: 10,
  },
  postComposerCancel: {
    flex: 1,
    padding: '12px',
    backgroundColor: 'transparent',
    border: `1.5px solid #555`,
    color: '#999',
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '0.18em',
    textTransform: 'uppercase' as const,
    borderRadius: 10,
    cursor: 'pointer',
  },
  postComposerSubmit: {
    width: '100%',
    padding: '14px',
    backgroundColor: 'rgba(255,255,255,0.06)',
    border: `1.5px solid #FFFFFF`,
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '0.18em',
    textTransform: 'uppercase' as const,
    borderRadius: 10,
    cursor: 'pointer',
    boxShadow: `0 0 12px #FFFFFF33`,
  },
  // Photo picker placeholder shown before a photo is selected.
  postComposerPicker: {
    width: '100%',
    minHeight: 160,
    backgroundColor: '#1a1a1a',
    border: `1.5px dashed #444`,
    borderRadius: 10,
    color: '#BBB',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    marginBottom: 12,
  },
  postComposerChangeBtn: {
    position: 'absolute' as const,
    right: 8, top: 8,
    backgroundColor: 'rgba(0,0,0,0.7)',
    color: '#FFF',
    border: '1px solid #555',
    borderRadius: 6,
    padding: '4px 10px',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
  },
  postComposerCaption: {
    width: '100%',
    backgroundColor: '#1a1a1a',
    border: '1px solid #333',
    borderRadius: 10,
    color: '#F0EBE0',
    fontSize: 14,
    padding: '10px 12px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    boxSizing: 'border-box' as const,
    outline: 'none',
    resize: 'vertical' as const,
    marginBottom: 4,
  },
  // ---- Instagram-style full-screen post composer ----
  // The screen + header chrome shared by both stages.
  igComposerScreen: {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 100,
    backgroundColor: '#000000',
    display: 'flex',
    flexDirection: 'column' as const,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    paddingTop: 'env(safe-area-inset-top, 0px)' as any,
    paddingBottom: 'env(safe-area-inset-bottom, 0px)' as any,
  },
  igComposerHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 16px 12px',
    borderBottom: '1px solid #1a1a1a',
  },
  igComposerHeaderBtn: {
    width: 40,
    height: 32,
    backgroundColor: 'transparent',
    border: 'none',
    color: '#F0EBE0',
    fontSize: 24,
    fontWeight: 400,
    cursor: 'pointer',
    padding: 0,
    textAlign: 'left' as const,
    lineHeight: 1,
  },
  igComposerHeaderTitle: {
    flex: 1,
    textAlign: 'center' as const,
    color: '#F0EBE0',
    fontSize: 17,
    fontWeight: 700,
    letterSpacing: 0,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  igComposerHeaderNext: {
    minWidth: 40,
    backgroundColor: 'transparent',
    border: 'none',
    fontSize: 16,
    fontWeight: 600,
    padding: 0,
    textAlign: 'right' as const,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  // ---- Stage 1: photo picker ----
  igPickPrompt: {
    flex: 1,
    backgroundColor: '#0A0A0A',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    color: '#888',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    WebkitTapHighlightColor: 'transparent' as any,
  },
  igPickPromptLabel: {
    fontSize: 16,
    fontWeight: 600,
    color: '#F0EBE0',
    marginTop: 4,
  },
  igPickPromptHint: {
    fontSize: 13,
    color: '#888',
  },
  // Smaller secondary hint specifically for the video size/duration
  // notice. Sits below the main hint, dimmer and slightly italic so
  // it reads as supplementary info rather than a primary instruction.
  igPickPromptHintSmall: {
    fontSize: 11,
    color: '#666',
    marginTop: 8,
    fontStyle: 'italic' as const,
  },
  igPickPreviewWrap: {
    flex: 1,
    position: 'relative' as const,
    backgroundColor: '#000',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  igPickPreviewImg: {
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain' as const,
    display: 'block',
  },
  igPickChangeBtn: {
    position: 'absolute' as const,
    bottom: 20,
    left: '50%',
    transform: 'translateX(-50%)',
    backgroundColor: 'rgba(0,0,0,0.7)',
    color: '#FFF',
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: 20,
    padding: '8px 18px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    backdropFilter: 'blur(8px)',
  },
  // ---- Stage 2: caption ----
  igCaptionBody: {
    flex: 1,
    overflow: 'auto' as const,
    padding: '16px 16px 8px',
  },
  igCaptionPreviewRow: {
    display: 'flex',
    gap: 12,
    alignItems: 'flex-start',
  },
  igCaptionPreviewImg: {
    width: 64,
    height: 64,
    objectFit: 'cover' as const,
    borderRadius: 6,
    flexShrink: 0,
  },
  igCaptionField: {
    flex: 1,
    minHeight: 64,
    backgroundColor: 'transparent',
    border: 'none',
    color: '#F0EBE0',
    fontSize: 15,
    lineHeight: 1.4,
    padding: 4,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    boxSizing: 'border-box' as const,
    outline: 'none',
    resize: 'none' as const,
  },
  igCaptionCounter: {
    fontSize: 11,
    color: '#666',
    textAlign: 'right' as const,
    marginTop: 4,
    paddingRight: 4,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  igShareWrap: {
    padding: '12px 16px 16px',
    borderTop: '1px solid #1a1a1a',
  },
  igShareBtn: {
    width: '100%',
    padding: '14px',
    backgroundColor: '#3B5BFF',
    border: 'none',
    borderRadius: 8,
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: 700,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    letterSpacing: 0,
  },

  // ---- DreadFeed Post Editor (between pick and caption) ----
  // Filmstrip overlay bars are drawn at the top/bottom of the preview at
  // 6% of preview height — same proportion the canvas-bake uses. Sprocket
  // holes are flex children for cheap responsive spacing.
  editorPreviewWrap: {
    flex: 1,
    position: 'relative' as const,
    backgroundColor: '#000',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden' as const,
    touchAction: 'none' as const,
  },
  editorPreviewImg: {
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain' as const,
    display: 'block',
    userSelect: 'none' as const,
    pointerEvents: 'none' as const,
  },
  editorFilmstripBarTop: {
    position: 'absolute' as const,
    top: 0, left: 0, right: 0,
    height: '6%',
    backgroundColor: '#0a0a0a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-around' as const,
    pointerEvents: 'none' as const,
  },
  editorFilmstripBarBottom: {
    position: 'absolute' as const,
    bottom: 0, left: 0, right: 0,
    height: '6%',
    backgroundColor: '#0a0a0a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-around' as const,
    pointerEvents: 'none' as const,
  },
  editorFilmstripHole: {
    width: 10,
    height: 14,
    backgroundColor: '#F5EFE0',
    borderRadius: 3,
  },
  // Slider-based size/rotation controls (v1.13). The two rows + delete
  // button stack vertically over the bottom toolbar, with a translucent
  // black panel so they read against any background image.
  editorLayerControls: {
    position: 'absolute' as const,
    bottom: 96,
    left: 12,
    right: 12,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
    padding: '10px 12px',
    backgroundColor: 'rgba(0,0,0,0.72)',
    borderRadius: 12,
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    border: '1px solid rgba(255,255,255,0.12)',
    zIndex: 5,
  },
  editorSliderRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  editorSliderIcon: {
    color: '#FFFFFF',
    fontSize: 18,
    width: 22,
    textAlign: 'center' as const,
    flexShrink: 0,
  },
  // Native range slider styled to match the dark editor chrome. The
  // appearance: none + WebkitAppearance: none combo strips iOS Safari's
  // default styling so our gradient track and pink thumb show through.
  editorSlider: {
    flex: 1,
    height: 32,
    accentColor: '#FF3B5C',
    background: 'transparent',
    margin: 0,
  },
  // Delete button sits below the sliders, full-width, with red text.
  editorLayerDeleteBtn: {
    height: 36,
    borderRadius: 8,
    backgroundColor: 'rgba(255,77,77,0.15)',
    border: '1px solid rgba(255,77,77,0.4)',
    color: '#FF4D4D',
    fontSize: 16,
    fontWeight: 600,
    cursor: 'pointer',
  },
  // (legacy editorLayerBtn kept so existing +/− style references in
  // any code I missed don't break — safe to remove later)
  editorLayerBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.78)',
    border: '1px solid rgba(255,255,255,0.18)',
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: 700,
    cursor: 'pointer',
    backdropFilter: 'blur(8px)',
  },
  editorToolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-around' as const,
    padding: '10px 12px 14px',
    backgroundColor: '#000',
    borderTop: '1px solid #1a1a1a',
  },
  editorToolBtn: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 3,
    padding: '6px 10px',
    backgroundColor: 'transparent',
    border: 'none',
    color: '#FFFFFF',
    cursor: 'pointer',
    minWidth: 70,
  },
  editorToolIcon: {
    fontSize: 22,
    lineHeight: 1,
  },
  editorToolLabel: {
    fontSize: 11,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
  },
  editorTray: {
    position: 'absolute' as const,
    bottom: 64,
    left: 0,
    right: 0,
    backgroundColor: '#0c0c0c',
    borderTop: '1px solid #1a1a1a',
    maxHeight: '50%',
    overflowY: 'auto' as const,
    zIndex: 6,
  },
  editorTrayHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between' as const,
    padding: '10px 14px',
    borderBottom: '1px solid #1a1a1a',
  },
  editorTrayTitle: {
    color: '#F0EBE0',
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '0.12em',
    textTransform: 'uppercase' as const,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  editorTrayClose: {
    width: 30,
    height: 30,
    border: 'none',
    backgroundColor: 'transparent',
    color: '#BBB',
    fontSize: 16,
    cursor: 'pointer',
  },
  editorStickerGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 8,
    padding: 12,
  },
  editorStickerCell: {
    aspectRatio: '1',
    backgroundColor: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 10,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 8,
  },
  editorTextInput: {
    flex: 1,
    padding: '10px 12px',
    backgroundColor: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    color: '#F0EBE0',
    fontSize: 15,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    outline: 'none',
  },
  editorTextAddBtn: {
    padding: '10px 16px',
    backgroundColor: '#3B5BFF',
    border: 'none',
    borderRadius: 8,
    color: '#FFF',
    fontSize: 14,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },

  // ---- Crop screen ----
  editorCropWrap: {
    flex: 1,
    position: 'relative' as const,
    backgroundColor: '#000',
    overflow: 'hidden' as const,
    touchAction: 'none' as const,
  },
  editorCropImg: {
    position: 'absolute' as const,
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: 'contain' as const,
    userSelect: 'none' as const,
    pointerEvents: 'none' as const,
  },
  editorCropRow: {
    display: 'flex',
    gap: 8,
    padding: '10px 12px 16px',
    overflowX: 'auto' as const,
    backgroundColor: '#000',
    borderTop: '1px solid #1a1a1a',
  },
  editorCropChip: {
    flexShrink: 0,
    padding: '8px 14px',
    backgroundColor: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 18,
    color: '#F0EBE0',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    letterSpacing: '0.04em',
  },

  // ---- Filter strip ----
  // Horizontal scroll row of preview thumbnails. Sits above the toolbar
  // when the Filter tool is active.
  editorFilterStrip: {
    display: 'flex',
    gap: 10,
    padding: '10px 12px',
    overflowX: 'auto' as const,
    backgroundColor: '#0a0a0a',
    borderTop: '1px solid #1a1a1a',
  },
  editorFilterCell: {
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 4,
    padding: 4,
    backgroundColor: 'transparent',
    borderRadius: 8,
    cursor: 'pointer',
  },
  editorFilterLabel: {
    fontSize: 10,
    color: '#F0EBE0',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
  },
  postComposerSubmitDisabled: {
    flex: 1.4,
    padding: '12px',
    backgroundColor: 'rgba(0,0,0,0.3)',
    border: `1.5px solid #333`,
    color: '#555',
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '0.18em',
    textTransform: 'uppercase' as const,
    borderRadius: 10,
    cursor: 'not-allowed',
  },

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
    bottom: 16,
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

  // Top-of-About creator credit. Small caps-style, dimmer than body text,
  // sits between the About header and the donation block.
  aboutCreatedBy: {
    fontSize: 13,
    color: '#888',
    textAlign: 'center' as const,
    marginTop: 0,
    marginBottom: 16,
    letterSpacing: 0.5,
  },

  // Donation call-to-action block. Red-tinted bordered card with a header,
  // two short paragraphs of context, and a CTA button linking to PayPal.
  // Sits at the very top of the About body, right under the creator credit.
  aboutDonateBlock: {
    backgroundColor: 'rgba(255, 59, 59, 0.06)',
    border: `1px solid ${TILE_RED}66`,
    borderRadius: 12,
    padding: '16px 18px',
    marginBottom: 22,
    boxShadow: `0 0 18px ${TILE_RED}22`,
  },
  aboutDonateHeader: {
    fontSize: 17,
    fontWeight: 700,
    color: WHITE,
    textShadow: `0 0 10px ${TILE_RED}aa`,
    marginBottom: 10,
    textAlign: 'center' as const,
  },
  aboutDonatePara: {
    fontSize: 14,
    lineHeight: 1.55,
    color: BONE,
    marginBottom: 12,
  },
  aboutDonateBtn: {
    display: 'block',
    width: '100%',
    textAlign: 'center' as const,
    backgroundColor: TILE_RED,
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: 700,
    padding: '12px 18px',
    borderRadius: 10,
    textDecoration: 'none',
    boxShadow: `0 0 14px ${TILE_RED}88`,
    marginTop: 6,
    boxSizing: 'border-box' as const,
  },

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
    fontSize: 18,
    fontWeight: 900,
    color: '#666',
    minWidth: 24,
    letterSpacing: '0.1em',
  },
  leaderHandle: {
    flex: 1,
    fontSize: 18,
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
  // Radius selector row beneath the NearbyView header. Five chips for the
  // available radii plus an optional Reset chip that appears when the user
  // has long-pressed to drop a custom search center on the map.
  // Small left-pad nudges the chips right just enough to clear the
  // bottom-left back button, without wrapping "100 MI" to a second line.
  radiusRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    justifyContent: 'center' as const,
    gap: 6,
    padding: '8px 12px 4px 28px',
  },
  radiusChip: {
    background: 'transparent',
    border: '1px solid #2a2a2a',
    color: '#999',
    padding: '5px 10px',
    fontSize: 11,
    letterSpacing: '0.16em',
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    fontFamily: 'inherit',
    cursor: 'pointer',
    borderRadius: 3,
  },
  radiusChipActive: {
    background: 'rgba(217, 42, 42, 0.18)',
    borderColor: '#d92a2a',
    color: '#ffffff',
    textShadow: '0 0 6px rgba(217, 42, 42, 0.6)',
  },
  radiusChipReset: {
    background: 'rgba(217, 42, 42, 0.08)',
    borderColor: '#d92a2a',
    color: '#d92a2a',
    marginLeft: 6,
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
    border: '1px solid #333',
    color: '#F0EBE0',
    padding: '8px 14px',
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: 0,
    borderRadius: 8,
    cursor: 'pointer',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  listSitesWrap: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },
  // Category-row variant — same monochrome treatment as listRow but
  // slightly taller padding for level 1. The previous version tinted
  // these by category color; per request the entire List View is now
  // black/white only so category color no longer bleeds in.
  listCategoryRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    width: '100%',
    boxSizing: 'border-box' as const,
    padding: '16px 14px',
    background: '#0d0d0d',
    border: '1px solid #1f1f1f',
    borderRadius: 10,
    color: '#F0EBE0',
    fontFamily: 'system-ui, -apple-system, sans-serif',
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
    color: '#F0EBE0',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
    textAlign: 'left' as const,
  },
  listRowDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    backgroundColor: '#F0EBE0',
    flexShrink: 0,
  },
  listRowTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: 600,
    letterSpacing: 0,
    color: '#F0EBE0',
    fontFamily: 'system-ui, -apple-system, sans-serif',
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
  // List View search input — restyled to match DreadFeed's search bar
  // (dark grey background, neutral border, system font, white text). The
  // old blue-glow style felt out of place in the otherwise monochrome
  // List View.
  localeSearchInput: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    color: '#F0EBE0',
    border: '1px solid #333',
    borderRadius: 10,
    padding: '10px 40px 10px 14px',
    fontSize: 15,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    outline: 'none',
    boxSizing: 'border-box' as const,
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
    fontSize: 18,
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
    fontSize: 18,
    fontWeight: 900,
    letterSpacing: '0.2em',
    fontFamily: 'inherit',
    borderRadius: 16,
    marginTop: 8,
  },

  // ---- Batch 2b: Action sheet, EULA, comment menu, profile block,
  //                claim screen recovery + Apple stub, modal secondary ----

  // Bottom-sheet action menu — slides up over content. Backdrop dims
  // the rest; tap-to-dismiss. Used by SocialPostCard and CommentSheet
  // for the 3-dot menu (Report / Block / Cancel).
  actionSheetBackdrop: {
    position: 'fixed' as const,
    inset: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
    zIndex: 10000,
    display: 'flex',
    flexDirection: 'column' as const,
    justifyContent: 'flex-end',
    transition: 'opacity 180ms ease',
  },
  actionSheet: {
    backgroundColor: '#181818',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: '8px 12px calc(env(safe-area-inset-bottom, 12px) + 12px)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
    transition: 'transform 180ms ease',
  },
  actionSheetTitle: {
    color: '#888',
    fontSize: 12,
    textAlign: 'center' as const,
    padding: '8px 4px 6px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  actionSheetBtn: {
    width: '100%',
    backgroundColor: 'transparent',
    color: '#F0EBE0',
    border: 'none',
    borderRadius: 10,
    padding: '14px',
    fontSize: 16,
    fontWeight: 500,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
    textAlign: 'center' as const,
  },
  actionSheetBtnDestructive: {
    width: '100%',
    backgroundColor: 'transparent',
    color: '#ff5a5a',
    border: 'none',
    borderRadius: 10,
    padding: '14px',
    fontSize: 16,
    fontWeight: 600,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
    textAlign: 'center' as const,
  },
  actionSheetCancelBtn: {
    width: '100%',
    backgroundColor: '#0a0a0a',
    color: '#F0EBE0',
    border: 'none',
    borderRadius: 10,
    padding: '14px',
    fontSize: 16,
    fontWeight: 700,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
    textAlign: 'center' as const,
    marginTop: 6,
  },

  // 3-dot menu on comment rows — smaller than postMenuBtn since the
  // row is tighter. Matches comment-like btn for visual balance.
  commentMenuBtn: {
    color: '#888888',
    fontSize: 18,
    backgroundColor: 'transparent',
    border: 'none',
    padding: '4px 6px',
    cursor: 'pointer',
    lineHeight: 1,
    alignSelf: 'flex-start' as const,
  },

  // EULA first-launch modal — full-screen, no close button, no escape.
  eulaBackdrop: {
    position: 'fixed' as const,
    inset: 0,
    backgroundColor: '#000',
    zIndex: 20000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  eulaSheet: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '90vh',
    backgroundColor: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 16,
    padding: 20,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
    overflow: 'hidden',
  },
  eulaTitle: {
    color: '#F0EBE0',
    fontSize: 20,
    fontWeight: 800,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    textAlign: 'center' as const,
  },
  eulaBody: {
    color: '#cccccc',
    fontSize: 14,
    lineHeight: 1.5,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    overflowY: 'auto' as const,
    flex: 1,
    paddingRight: 4,
  },
  eulaPara: {
    margin: '0 0 10px 0',
  },
  eulaLink: {
    color: '#7AB8FF',
    textDecoration: 'underline',
  },
  eulaAcceptBtn: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    color: '#000',
    border: 'none',
    borderRadius: 10,
    padding: '14px',
    fontSize: 15,
    fontWeight: 700,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
  },

  // Block button on UserProfileView — sits in the same actions row as
  // Follow / Share. Visually de-emphasized: outlined red rather than
  // filled, so it doesn't shout.
  profileBlockBtn: {
    backgroundColor: 'transparent',
    color: '#ff5a5a',
    border: '1px solid #5a2222',
    borderRadius: 8,
    padding: '8px 14px',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  },

  // Claim screen — OR divider + Apple Sign In button + Recover link.
  dreadFeedClaimOrRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginTop: 18,
    marginBottom: 12,
  },
  dreadFeedClaimOrLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#2a2a2a',
  },
  dreadFeedClaimOrText: {
    color: '#666',
    fontSize: 12,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    textTransform: 'uppercase' as const,
    letterSpacing: 1,
  },
  dreadFeedAppleBtn: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000',
    color: '#FFFFFF',
    border: '1px solid #2a2a2a',
    borderRadius: 10,
    padding: '12px',
    fontSize: 15,
    fontWeight: 600,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
  },
  dreadFeedEmailBtn: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    color: '#F0EBE0',
    border: '1px solid #3a3a3a',
    borderRadius: 10,
    padding: '12px',
    fontSize: 15,
    fontWeight: 500,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
  },
  dreadFeedRecoverLink: {
    width: '100%',
    backgroundColor: 'transparent',
    color: '#7AB8FF',
    border: 'none',
    padding: '14px 8px 4px',
    fontSize: 13,
    fontWeight: 500,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
    textAlign: 'center' as const,
    textDecoration: 'underline',
  },

  // Secondary modal button — used by RecoverAccountModal "Back" action.
  modalBtnSecondary: {
    width: '100%',
    backgroundColor: 'transparent',
    color: '#888',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    padding: '12px',
    fontSize: 14,
    fontWeight: 500,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
    marginTop: 6,
  },

  // ---------- Poll feed cards (SocialPollCard) ----------
  // Matches SocialPostCard chrome: dark background, full-width card,
  // borderless top/bottom (the feed gutter handles separation).
  pollCard: {
    width: '100%',
    backgroundColor: '#000',
    borderTop: '1px solid #1a1a1a',
    borderBottom: '1px solid #1a1a1a',
    padding: '14px 14px 16px',
    boxSizing: 'border-box',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    color: '#F0EBE0',
  },
  pollCardHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  pollCardHandleBtn: {
    background: 'transparent',
    border: 'none',
    padding: 0,
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: 700,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
  },
  pollCardBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11,
    color: '#9a8e7a',
    backgroundColor: '#171717',
    border: '1px solid #2a2a2a',
    borderRadius: 999,
    padding: '4px 10px',
    fontWeight: 600,
    letterSpacing: 0.2,
  },
  pollCardQuestion: {
    fontSize: 17,
    lineHeight: 1.35,
    fontWeight: 600,
    color: '#F0EBE0',
    marginBottom: 14,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  pollCardOptions: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  // Pre-vote pill button — borderless dark pill, tappable.
  pollOptionBtn: {
    width: '100%',
    minHeight: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    backgroundColor: '#141414',
    color: '#F0EBE0',
    border: '1px solid #262626',
    borderRadius: 10,
    padding: '10px 14px',
    fontSize: 15,
    fontWeight: 500,
    textAlign: 'left' as const,
    cursor: 'pointer',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  // Post-vote results row — container that holds the fill bar, label,
  // and percent. position:relative is required so the fill can absolute-
  // position underneath. overflow:hidden clips the fill to the rounded
  // corners.
  pollOptionResult: {
    position: 'relative' as const,
    overflow: 'hidden' as const,
    width: '100%',
    minHeight: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#101010',
    color: '#F0EBE0',
    border: '1px solid #262626',
    borderRadius: 10,
    padding: '10px 14px',
    fontSize: 15,
    fontWeight: 500,
    textAlign: 'left' as const,
    cursor: 'pointer',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  pollOptionResultPicked: {
    borderColor: '#8B0000',
  },
  pollOptionFill: {
    position: 'absolute' as const,
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: '#1f1f1f',
    transition: 'width 280ms ease-out',
    pointerEvents: 'none' as const,
  },
  pollOptionFillPicked: {
    backgroundColor: '#3a0000',
  },
  pollOptionLabel: {
    position: 'relative' as const,
    zIndex: 1,
    flex: 1,
    minWidth: 0,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  pollOptionPct: {
    position: 'relative' as const,
    zIndex: 1,
    fontSize: 13,
    fontWeight: 700,
    color: '#bbb',
    marginLeft: 12,
    minWidth: 36,
    textAlign: 'right' as const,
  },
  pollCardFooter: {
    marginTop: 12,
    fontSize: 12,
    color: '#9a8e7a',
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap' as const,
  },

  // ---------- Poll composer (PollComposerSheet) ----------
  pollComposerBody: {
    padding: '18px 16px 24px',
    overflowY: 'auto' as const,
    flex: 1,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    color: '#F0EBE0',
  },
  pollComposerLabelRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  pollComposerLabel: {
    fontSize: 13,
    fontWeight: 700,
    color: '#F0EBE0',
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
  },
  pollComposerCount: {
    fontSize: 12,
    color: '#7a7a7a',
    fontVariantNumeric: 'tabular-nums' as const,
  },
  pollComposerQuestion: {
    width: '100%',
    backgroundColor: '#101010',
    color: '#F0EBE0',
    border: '1px solid #2a2a2a',
    borderRadius: 10,
    padding: '12px 14px',
    fontSize: 16,
    fontWeight: 500,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    resize: 'none' as const,
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  pollComposerOptionRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  pollComposerOptionNum: {
    width: 24,
    height: 24,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1a1a1a',
    color: '#888',
    border: '1px solid #2a2a2a',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
  },
  pollComposerOptionInput: {
    flex: 1,
    backgroundColor: '#101010',
    color: '#F0EBE0',
    border: '1px solid #2a2a2a',
    borderRadius: 10,
    padding: '10px 12px',
    fontSize: 15,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    outline: 'none',
    boxSizing: 'border-box' as const,
    minWidth: 0,
  },
  pollComposerHint: {
    marginTop: 16,
    fontSize: 12,
    color: '#7a7a7a',
    lineHeight: 1.4,
  },

  // ---------- ChoosePostTypeSheet (➕ chooser) ----------
  pollChooserBackdrop: {
    position: 'fixed' as const,
    inset: 0,
    backgroundColor: 'rgba(0,0,0,0.78)',
    zIndex: 9000,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  pollChooserCard: {
    width: '100%',
    maxWidth: 520,
    backgroundColor: '#0c0c0c',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderTop: '1px solid #1a1a1a',
    padding: '20px 18px calc(28px + env(safe-area-inset-bottom))',
    boxSizing: 'border-box' as const,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    color: '#F0EBE0',
  },
  pollChooserTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: '#9a8e7a',
    letterSpacing: 0.6,
    textTransform: 'uppercase' as const,
    textAlign: 'center' as const,
    marginBottom: 14,
  },
  pollChooserBtn: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    backgroundColor: '#141414',
    color: '#F0EBE0',
    border: '1px solid #262626',
    borderRadius: 12,
    padding: '14px 16px',
    fontSize: 16,
    fontWeight: 600,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
    marginBottom: 10,
    textAlign: 'left' as const,
  },
  pollChooserBtnIcon: {
    fontSize: 22,
    width: 28,
    textAlign: 'center' as const,
  },
  pollChooserBtnLabel: {
    fontSize: 16,
    fontWeight: 600,
  },
  pollChooserCancel: {
    width: '100%',
    backgroundColor: 'transparent',
    color: '#888',
    border: '1px solid #2a2a2a',
    borderRadius: 12,
    padding: '12px',
    fontSize: 15,
    fontWeight: 500,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
    marginTop: 4,
  },
};
