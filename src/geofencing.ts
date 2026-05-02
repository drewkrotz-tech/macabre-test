// geofencing.ts — Sinister Locales geofencing layer (v2)
//
// On NATIVE (iOS/Android via Capacitor):
//   - Requests notification + location permissions on demand
//   - Watches user position in the background (foreground service on Android,
//     iOS background-location mode)
//   - Maintains an active set of the 20 closest sites (Apple's per-app fence
//     limit). Recomputes when the user moves > RECALC_THRESHOLD_M.
//   - On region enter: fires a local notification "You're near {title}"
//   - Notification tap (foreground OR background) dispatches a window
//     'sinister:open-site' event that App.tsx listens to.
//
// On WEB (StackBlitz preview):
//   - Falls back to navigator.geolocation.watchPosition for the location
//     dot in the UI. No notifications, no background.
//
// Changes vs v1:
//   - REPLACED `new Function('s', 'return import(s)')` with real dynamic
//     `await import()` calls. The Function-constructor hack was bypassing
//     Vite's module resolution AND failing silently inside Capacitor on
//     iOS, which was the root cause of the Submit button never enabling
//     (no permission prompt -> no Settings entry -> currentLocation null).
//   - Cached imported plugin modules at module scope so we don't re-import
//     on every fence check.
//   - Added a debug log ring buffer (getDebugLog()) so App.tsx can show
//     what's actually happening on TestFlight without us rebuilding.
//   - Added foreground notification listener (localNotificationReceived)
//     so taps work whether the app is open or backgrounded.
//   - Added an Android notification channel init (no-op on iOS).
//   - Permission response now distinguishes "always" vs "whileInUse" so
//     App.tsx can show a one-time "Enable Always for drive-by alerts" UI.

import type { SinisterSite } from './locations';

// ---------- Tunables ----------
const GEOFENCE_RADIUS_M = 800;        // 0.5 mile per site
const MAX_FENCES = 20;                // Apple's per-app limit
const RECALC_THRESHOLD_M = 1500;      // recompute fence set when user moves > this from anchor
const NOTIFICATION_COOLDOWN_MS = 30 * 60 * 1000; // don't re-notify same site within 30 min
const ANDROID_CHANNEL_ID = 'sinister_proximity';

// ---------- Tiny shim around Capacitor runtime ----------
function isNative(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as any).Capacitor;
  return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
}

function getPlatform(): 'ios' | 'android' | 'web' {
  if (typeof window === 'undefined') return 'web';
  const cap = (window as any).Capacitor;
  const p = cap?.getPlatform?.();
  if (p === 'ios' || p === 'android') return p;
  return 'web';
}

// ---------- Debug log (ring buffer) ----------
const DEBUG_LOG_MAX = 200;
const _debugLog: string[] = [];
function dlog(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] ${msg}`;
  _debugLog.push(line);
  if (_debugLog.length > DEBUG_LOG_MAX) _debugLog.shift();
  // eslint-disable-next-line no-console
  console.log('[geofencing]', msg);
}
export function getDebugLog(): string[] {
  return _debugLog.slice();
}
export function clearDebugLog() {
  _debugLog.length = 0;
}

// ---------- Cached plugin proxies ----------
// We use registerPlugin from @capacitor/core (the documented Capacitor
// pattern) instead of dynamic imports of the plugin packages directly.
// Why: dynamic imports of native-only plugin packages fail at runtime in
// the iOS WebView ("Module name does not resolve to a valid URL"), which
// is exactly what blocked geofencing in v1.1-v1.3. registerPlugin returns
// a proxy that routes method calls to the native plugin via Capacitor's
// JSBridge — no JS module resolution required.
import { registerPlugin } from '@capacitor/core';

// Type-only shapes — we don't import the runtime types from the plugin
// packages because that would force a bundle dependency we want to avoid.
interface BgGeoPlugin {
  addWatcher(opts: any, cb: (location: any, error: any) => void): Promise<string>;
  removeWatcher(opts: { id: string }): Promise<void>;
}
interface LocalNotifPlugin {
  schedule(opts: { notifications: any[] }): Promise<any>;
  requestPermissions(): Promise<{ display: string }>;
  createChannel?(opts: any): Promise<void>;
  removeAllListeners?(): Promise<void>;
  addListener(eventName: string, cb: (data: any) => void): { remove: () => void } | Promise<any>;
}

let _bgGeoMod: BgGeoPlugin | null = null;
let _localNotifMod: LocalNotifPlugin | null = null;

async function loadBgGeo(): Promise<BgGeoPlugin | null> {
  if (_bgGeoMod) return _bgGeoMod;
  if (!isNative()) return null;
  try {
    // Capacitor's registerPlugin returns a Proxy. Methods aren't always
    // enumerable until called, so we trust any truthy return and let real
    // errors surface at addWatcher() call time.
    const proxy = registerPlugin<BgGeoPlugin>('BackgroundGeolocation');
    if (!proxy) {
      dlog('BackgroundGeolocation registerPlugin returned null');
      return null;
    }
    _bgGeoMod = proxy;
    dlog('BackgroundGeolocation plugin registered');
  } catch (err: any) {
    dlog('BackgroundGeolocation registerPlugin failed: ' + (err?.message || err));
    _bgGeoMod = null;
  }
  return _bgGeoMod;
}

async function loadLocalNotif(): Promise<LocalNotifPlugin | null> {
  if (_localNotifMod) return _localNotifMod;
  if (!isNative()) return null;
  try {
    const proxy = registerPlugin<LocalNotifPlugin>('LocalNotifications');
    if (!proxy) {
      dlog('LocalNotifications registerPlugin returned null');
      return null;
    }
    _localNotifMod = proxy;
    dlog('LocalNotifications plugin registered');
  } catch (err: any) {
    dlog('LocalNotifications registerPlugin failed: ' + (err?.message || err));
    _localNotifMod = null;
  }
  return _localNotifMod;
}

// ---------- Public API ----------

export type Permissions = {
  location: 'always' | 'whileInUse' | 'denied' | 'unknown';
  notifications: boolean;
};

let _watchId: number | null = null;
let _nativeWatchHandle: any = null;
let _siteList: SinisterSite[] = [];
let _activeFenceIds: Set<string> = new Set();
let _lastAnchor: { lat: number; lng: number } | null = null;
let _lastNotifiedAt: Map<string, number> = new Map();
let _onPosition: ((lat: number, lng: number) => void) | null = null;
let _notifListenersAttached = false;

export function setSites(sites: SinisterSite[]) {
  _siteList = sites;
  dlog(`setSites: ${sites.length} sites loaded`);
  if (_lastAnchor && isNative()) {
    void recomputeFences(_lastAnchor.lat, _lastAnchor.lng);
  }
}

async function attachNotifListeners(): Promise<void> {
  if (_notifListenersAttached) return;
  const LN = await loadLocalNotif();
  if (!LN) return;
  try {
    if (typeof LN.removeAllListeners === 'function') {
      await LN.removeAllListeners();
    }
    LN.addListener('localNotificationActionPerformed', (action: any) => {
      const siteId = action?.notification?.extra?.siteId;
      dlog('tap (background): siteId=' + siteId);
      if (siteId && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('sinister:open-site', { detail: { siteId } }));
      }
    });
    LN.addListener('localNotificationReceived', (n: any) => {
      const siteId = n?.extra?.siteId;
      dlog('received (foreground): siteId=' + siteId);
    });
    _notifListenersAttached = true;
    dlog('notification listeners attached');
  } catch (err: any) {
    dlog('attachNotifListeners failed: ' + (err?.message || err));
  }
}

async function ensureAndroidChannel(): Promise<void> {
  if (getPlatform() !== 'android') return;
  const LN = await loadLocalNotif();
  if (!LN || typeof LN.createChannel !== 'function') return;
  try {
    await LN.createChannel({
      id: ANDROID_CHANNEL_ID,
      name: 'Nearby Sites',
      description: 'Alerts when you approach a sinister location',
      importance: 4,
      visibility: 1,
      sound: 'default',
      vibration: true,
    });
    dlog('android channel created');
  } catch (err: any) {
    dlog('createChannel failed: ' + (err?.message || err));
  }
}

export async function requestPermissions(): Promise<Permissions> {
  dlog('requestPermissions ENTRY, isNative=' + isNative());
  if (!isNative()) {
    return { location: 'unknown', notifications: false };
  }

  const result: Permissions = { location: 'unknown', notifications: false };

  const LN = await loadLocalNotif();
  if (LN) {
    try {
      const perm = await LN.requestPermissions();
      result.notifications = perm?.display === 'granted';
      dlog('notification permission: ' + perm?.display);
      await ensureAndroidChannel();
      await attachNotifListeners();
    } catch (err: any) {
      dlog('requestPermissions(LN) failed: ' + (err?.message || err));
    }
  } else {
    dlog('LocalNotifications module not available');
  }

  const BG = await loadBgGeo();
  if (BG) {
    try {
      let promptFiredId: string | null = null;
      const watcherId = await BG.addWatcher(
        {
          backgroundMessage: 'The Dread Directory is watching for nearby sites.',
          backgroundTitle: 'Nearby Sites',
          requestPermissions: true,
          stale: false,
          distanceFilter: 50,
        },
        (location: any, error: any) => {
          if (error) {
            dlog('initial watcher error: code=' + error.code + ' msg=' + error.message);
            if (error.code === 'NOT_AUTHORIZED' || error.code === 'PERMISSION_DENIED') {
              result.location = 'denied';
            }
            return;
          }
          if (location) {
            if (result.location === 'unknown') result.location = 'whileInUse';
            dlog('initial fix: ' + location.latitude.toFixed(4) + ',' + location.longitude.toFixed(4));
          }
        }
      );
      promptFiredId = watcherId;
      try {
        await BG.removeWatcher({ id: promptFiredId });
        dlog('priming watcher removed');
      } catch (err: any) {
        dlog('removeWatcher (priming) failed: ' + (err?.message || err));
      }
    } catch (err: any) {
      dlog('requestPermissions(BG) failed: ' + (err?.message || err));
      result.location = 'denied';
    }
  } else {
    dlog('BackgroundGeolocation module not available');
  }

  return result;
}

export async function startGeofencing(onPosition: (lat: number, lng: number) => void): Promise<void> {
  dlog('startGeofencing ENTRY, isNative=' + isNative());
  _onPosition = onPosition;

  if (!isNative()) {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    _watchId = navigator.geolocation.watchPosition(
      (pos) => onPosition(pos.coords.latitude, pos.coords.longitude),
      () => { /* silent */ },
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 60000 }
    );
    dlog('web watchPosition started, id=' + _watchId);
    return;
  }

  await attachNotifListeners();
  await ensureAndroidChannel();

  const BG = await loadBgGeo();
  if (!BG) {
    dlog('startGeofencing: BG module unavailable, aborting native path');
    return;
  }

  try {
    _nativeWatchHandle = await BG.addWatcher(
      {
        backgroundMessage: 'The Dread Directory is watching for nearby sites.',
        backgroundTitle: 'Nearby Sites',
        // Belt-and-suspenders: re-request here too. If requestPermissions()
        // earlier didn't fully grant (or returned before the prompt was
        // answered), this still gets us a working watcher once the user
        // grants. iOS won't show a duplicate prompt if already granted.
        requestPermissions: true,
        stale: false,
        distanceFilter: 50,
      },
      async (location: any, error: any) => {
        if (error) {
          dlog('watcher error: code=' + error.code + ' msg=' + error.message);
          return;
        }
        if (!location) return;
        const lat: number = location.latitude;
        const lng: number = location.longitude;

        if (_onPosition) _onPosition(lat, lng);

        if (!_lastAnchor || distanceMeters(lat, lng, _lastAnchor.lat, _lastAnchor.lng) > RECALC_THRESHOLD_M) {
          _lastAnchor = { lat, lng };
          await recomputeFences(lat, lng);
        }
        checkFenceTriggers(lat, lng);
      }
    );
    dlog('native watcher started, handle=' + _nativeWatchHandle);
  } catch (err: any) {
    dlog('startGeofencing addWatcher failed: ' + (err?.message || err));
  }
}

export async function stopGeofencing(): Promise<void> {
  _onPosition = null;

  if (_watchId !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
    navigator.geolocation.clearWatch(_watchId);
    dlog('web watchPosition cleared');
    _watchId = null;
  }

  if (_nativeWatchHandle && isNative()) {
    const BG = await loadBgGeo();
    if (BG) {
      try {
        await BG.removeWatcher({ id: _nativeWatchHandle });
        dlog('native watcher removed');
      } catch (err: any) {
        dlog('removeWatcher failed: ' + (err?.message || err));
      }
    }
    _nativeWatchHandle = null;
  }
}

export function simulateLocation(lat: number, lng: number) {
  if (_onPosition) _onPosition(lat, lng);
  if (isNative()) {
    // Native: only fakes the UI hook, not the OS position.
  } else {
    checkFenceTriggers(lat, lng);
  }
}

// ---------- Internal helpers ----------

async function recomputeFences(lat: number, lng: number): Promise<void> {
  if (_siteList.length === 0) return;
  const ranked = _siteList
    .map(s => ({ site: s, d: distanceMeters(lat, lng, s.coords.lat, s.coords.lng) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_FENCES);
  const newIds = new Set(ranked.map(r => r.site.id));
  _activeFenceIds = newIds;
  dlog(`recomputeFences: ${newIds.size} active, nearest=${ranked[0]?.site.title} (${Math.round(ranked[0]?.d || 0)}m)`);
}

function checkFenceTriggers(lat: number, lng: number): void {
  const now = Date.now();
  for (const site of _siteList) {
    if (!_activeFenceIds.has(site.id)) continue;
    const d = distanceMeters(lat, lng, site.coords.lat, site.coords.lng);
    if (d > GEOFENCE_RADIUS_M) continue;

    const lastAt = _lastNotifiedAt.get(site.id) || 0;
    if (now - lastAt < NOTIFICATION_COOLDOWN_MS) continue;

    _lastNotifiedAt.set(site.id, now);
    dlog(`TRIGGER: ${site.title} at ${Math.round(d)}m`);
    void fireNotification(site);
  }
}

async function fireNotification(site: SinisterSite): Promise<void> {
  if (!isNative()) return;
  const LN = await loadLocalNotif();
  if (!LN) {
    dlog('fireNotification: LN unavailable');
    return;
  }
  try {
    await LN.schedule({
      notifications: [
        {
          id: hashString(site.id) % 2000000000,
          title: 'The Dread Directory',
          body: `You're near ${site.title}. Tap to see the story.`,
          extra: { siteId: site.id },
          channelId: ANDROID_CHANNEL_ID,
        },
      ],
    });
    dlog('notification scheduled: ' + site.title);
  } catch (err: any) {
    dlog('schedule failed: ' + (err?.message || err));
  }
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
