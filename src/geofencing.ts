// geofencing.ts — Sinister Locales geofencing layer (v3, Transistor plugin)
//
// Switched from @capacitor-community/background-geolocation (which couldn't
// monitor regions while the JS engine was suspended on iOS) to
// @transistorsoft/capacitor-background-geolocation. The Transistor plugin
// wraps CLLocationManager.startMonitoring(for: CLCircularRegion) on iOS,
// which runs in CoreLocation's process — so iOS will wake the app from a
// terminated state when the user crosses a geofence boundary, even hours
// or days later. That fixes the core "no notifications when app is closed"
// problem that App_84 through App_170 were stuck on.
//
// Public API is unchanged so App.tsx doesn't need edits:
//   setSites, startGeofencing, stopGeofencing, requestPermissions,
//   getDebugLog, clearDebugLog, distanceMeters, simulateLocation
//
// Behaviour:
//   - On startGeofencing(): feed the 20 nearest sites to the native plugin
//     as proper iOS regions (radius 800m / ~0.5 mile each)
//   - Plugin's onGeofence event fires on enter, even from a fully-killed app
//   - We schedule a local notification "You're near {title}" on enter
//   - When the user moves > RECALC_THRESHOLD_M, we recompute the 20 closest
//     sites and refresh the active fences
//   - WEB fallback (Vite dev / browser preview) uses navigator.geolocation
//     for the dot in the UI — no notifications, no background.

import type { SinisterSite } from './locations';

// ---------- Tunables ----------
const GEOFENCE_RADIUS_M = 800;        // 0.5 mile per site (matches v2)
const MAX_FENCES = 20;                // Apple's per-app limit
const RECALC_THRESHOLD_M = 1500;      // refresh fences when user moves > this from anchor
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
  // Drain pre-buffered messages from module-load time on first call
  try {
    const buf = (globalThis as any).__earlyLogBuf as string[] | undefined;
    if (buf && buf.length) {
      for (const l of buf) _debugLog.push(l);
      buf.length = 0;
    }
  } catch {}
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

// --- Global error trap (kept from v2 for diagnosis) ---
(function installGlobalErrorTrap(){
  if (typeof window === 'undefined') return;
  if ((window as any).__geoErrTrapInstalled) return;
  (window as any).__geoErrTrapInstalled = true;
  try {
    window.addEventListener('error', (ev: any) => {
      const msg = ev?.error?.message || ev?.message || String(ev);
      const stk = ev?.error?.stack ? (' | ' + String(ev.error.stack).split('\n').slice(0,3).join(' :: ')) : '';
      _modulePushLog('GLOBAL ERROR: ' + msg + stk);
    });
    window.addEventListener('unhandledrejection', (ev: any) => {
      const r = ev?.reason;
      const msg = r?.message || String(r);
      const stk = r?.stack ? (' | ' + String(r.stack).split('\n').slice(0,3).join(' :: ')) : '';
      _modulePushLog('UNHANDLED REJECTION: ' + msg + stk);
    });
  } catch {}
})();
function _modulePushLog(msg: string) {
  try {
    const ts = new Date().toISOString().slice(11, 19);
    const line = '[' + ts + '] ' + msg;
    (globalThis as any).__earlyLogBuf = (globalThis as any).__earlyLogBuf || [];
    (globalThis as any).__earlyLogBuf.push(line);
  } catch {}
}
_modulePushLog('GEOFENCING MODULE LOADED (v3 Transistor)');

// ---------- Plugin proxies ----------
// LocalNotifications still uses Capacitor's registerPlugin — that part is
// unchanged. The Transistor BG geolocation plugin is imported as an ES module
// since it ships its own JS API surface.
import { registerPlugin } from '@capacitor/core';

// We import lazily so web builds don't choke trying to load native bindings.
// The plugin works on iOS via the JS bridge; on web the import resolves but
// any method call is a no-op or rejects.
let _BG: any = null;
async function loadBgGeo(): Promise<any | null> {
  if (_BG) return _BG;
  if (!isNative()) {
    dlog('loadBgGeo: not native, skipping plugin import');
    return null;
  }
  try {
    dlog('loadBgGeo: dynamic import @transistorsoft/capacitor-background-geolocation');
    const mod = await import('@transistorsoft/capacitor-background-geolocation');
    // The plugin exports BackgroundGeolocation as default; some bundlers also
    // expose it on .BackgroundGeolocation. Try both.
    _BG = (mod as any).default || (mod as any).BackgroundGeolocation || mod;
    dlog('loadBgGeo: plugin loaded, has ready=' + (typeof _BG?.ready === 'function'));
    return _BG;
  } catch (err: any) {
    dlog('loadBgGeo: import failed: ' + (err?.message || err));
    return null;
  }
}

interface LocalNotifPlugin {
  schedule(opts: { notifications: any[] }): Promise<any>;
  requestPermissions(): Promise<{ display: string }>;
  createChannel?(opts: any): Promise<void>;
  removeAllListeners?(): Promise<void>;
  addListener(eventName: string, cb: (data: any) => void): { remove: () => void } | Promise<any>;
}
let _localNotifMod: LocalNotifPlugin | null = null;
function loadLocalNotif(): LocalNotifPlugin | null {
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
let _bgReady = false;
let _bgStarted = false;
let _siteList: SinisterSite[] = [];
let _activeFenceIds: Set<string> = new Set();
let _lastAnchor: { lat: number; lng: number } | null = null;
let _lastNotifiedAt: Map<string, number> = new Map();
let _onPosition: ((lat: number, lng: number) => void) | null = null;
let _notifListenersAttached = false;
let _bgListenersAttached = false;

export function setSites(sites: SinisterSite[]) {
  _siteList = sites;
  dlog(`setSites: ${sites.length} sites loaded`);
  if (_lastAnchor && isNative() && _bgStarted) {
    void recomputeFences(_lastAnchor.lat, _lastAnchor.lng);
  }
}

async function attachNotifListeners(): Promise<void> {
  if (_notifListenersAttached) return;
  const LN = loadLocalNotif();
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
  const LN = loadLocalNotif();
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

// Wire up Transistor plugin event listeners — we do this once on first
// ready(). The onGeofence handler is what fires when iOS wakes the app
// from a region cross, even if the app was fully terminated.
async function attachBgListeners(BG: any): Promise<void> {
  if (_bgListenersAttached) return;
  try {
    BG.onLocation((location: any) => {
      const lat = location?.coords?.latitude;
      const lng = location?.coords?.longitude;
      if (typeof lat !== 'number' || typeof lng !== 'number') return;
      if (_onPosition) _onPosition(lat, lng);
      // Recompute fences if user has drifted far from anchor
      if (!_lastAnchor || distanceMeters(lat, lng, _lastAnchor.lat, _lastAnchor.lng) > RECALC_THRESHOLD_M) {
        _lastAnchor = { lat, lng };
        void recomputeFences(lat, lng);
      }
    }, (err: any) => {
      dlog('onLocation error: ' + (err?.message || err));
    });

    BG.onGeofence((event: any) => {
      // event = { identifier, action: 'ENTER'|'EXIT'|'DWELL', location: {...} }
      const id = event?.identifier;
      const action = event?.action;
      dlog(`onGeofence: ${action} ${id}`);
      if (action !== 'ENTER') return;
      const site = _siteList.find(s => s.id === id);
      if (!site) {
        dlog('onGeofence: site not found for id=' + id);
        return;
      }
      const now = Date.now();
      const lastAt = _lastNotifiedAt.get(site.id) || 0;
      if (now - lastAt < NOTIFICATION_COOLDOWN_MS) {
        dlog('onGeofence: cooldown active for ' + site.title);
        return;
      }
      _lastNotifiedAt.set(site.id, now);
      void fireNotification(site);
    });

    BG.onMotionChange((event: any) => {
      dlog('onMotionChange: isMoving=' + event?.isMoving);
    });

    BG.onProviderChange((event: any) => {
      dlog('onProviderChange: status=' + event?.status + ' enabled=' + event?.enabled);
    });

    _bgListenersAttached = true;
    dlog('BG listeners attached');
  } catch (err: any) {
    dlog('attachBgListeners failed: ' + (err?.message || err));
  }
}

// Ready the Transistor plugin once. Subsequent calls are no-ops because the
// plugin remembers state across launches (that's the whole point — so iOS
// can re-launch the app on a region cross and the plugin is still configured).
async function ensureBgReady(BG: any): Promise<boolean> {
  if (_bgReady) return true;
  try {
    dlog('BG.ready: configuring plugin');
    const state = await BG.ready({
      // Distance-based location sampling. We don't need high frequency — we
      // mainly use locations to refresh the active fence set as the user moves.
      desiredAccuracy: BG.DESIRED_ACCURACY_HIGH,
      distanceFilter: 50,
      // Geofencing: respond to ENTER events. EXIT we can leave on for future
      // "you're leaving" features; DWELL would fire after standing inside a
      // fence for a while — not useful for us.
      geofenceModeHighAccuracy: false,
      // Lifecycle: we WANT tracking to keep going when the user closes the
      // app, and to auto-restart on device reboot. This is the whole reason
      // we swapped plugins.
      stopOnTerminate: false,
      startOnBoot: true,
      // Notifications layer (Android-specific). On iOS the plugin handles
      // its own background-mode setup via Info.plist UIBackgroundModes.
      foregroundService: true,
      notification: {
        title: 'The Dread Directory',
        text: 'Watching for nearby sinister sites',
      },
      // Quiet logging. Set to LOG_LEVEL_VERBOSE if we need to debug a build.
      debug: false,
      logLevel: BG.LOG_LEVEL_WARNING,
    });
    dlog('BG.ready: state.enabled=' + state?.enabled + ' authorization=' + state?.providerState?.status);
    _bgReady = true;
    return true;
  } catch (err: any) {
    dlog('BG.ready failed: ' + (err?.message || err));
    return false;
  }
}

export async function requestPermissions(): Promise<Permissions> {
  dlog('RP-1 ENTRY, isNative=' + isNative());
  if (!isNative()) {
    return { location: 'unknown', notifications: false };
  }

  const result: Permissions = { location: 'unknown', notifications: false };

  // 1. Local notifications (5s timeout — known to hang on some iOS versions)
  const LN = loadLocalNotif();
  if (LN) {
    try {
      const perm: any = await Promise.race([
        LN.requestPermissions(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('LN.requestPermissions timeout')), 5000)),
      ]);
      result.notifications = perm?.display === 'granted';
      dlog('RP-LN: notification permission: ' + perm?.display);
      await ensureAndroidChannel();
      await attachNotifListeners();
    } catch (err: any) {
      dlog('RP-LN failed: ' + (err?.message || err));
    }
  }

  // 2. Background location (the Transistor way — we ready() the plugin and
  //    then ask for "Always" authorization).
  const BG = await loadBgGeo();
  if (BG) {
    try {
      await ensureBgReady(BG);
      await attachBgListeners(BG);
      // requestPermission returns the AUTHORIZATION_STATUS_* enum value.
      // ALWAYS = 3, WHEN_IN_USE = 4, DENIED = 1, NOT_DETERMINED = 0.
      // The plugin will surface the iOS "Always Allow" prompt the first time.
      const status = await BG.requestPermission();
      dlog('RP-BG: requestPermission returned status=' + status);
      if (status === BG.AUTHORIZATION_STATUS_ALWAYS) {
        result.location = 'always';
      } else if (status === BG.AUTHORIZATION_STATUS_WHEN_IN_USE) {
        result.location = 'whileInUse';
      } else if (status === BG.AUTHORIZATION_STATUS_DENIED) {
        result.location = 'denied';
      } else {
        result.location = 'unknown';
      }
    } catch (err: any) {
      dlog('RP-BG failed: ' + (err?.message || err));
      result.location = 'denied';
    }
  } else {
    dlog('BackgroundGeolocation module not available');
  }

  dlog('RP done: location=' + result.location + ' notifs=' + result.notifications);
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

  await ensureBgReady(BG);
  await attachBgListeners(BG);

  // Get an initial position so we can set up the first batch of fences.
  // Don't fail if this errors — onLocation will populate _lastAnchor on
  // the next motion event anyway.
  try {
    const loc = await BG.getCurrentPosition({
      timeout: 30,
      maximumAge: 60000,
      desiredAccuracy: 100,
    });
    const lat = loc?.coords?.latitude;
    const lng = loc?.coords?.longitude;
    if (typeof lat === 'number' && typeof lng === 'number') {
      _lastAnchor = { lat, lng };
      if (_onPosition) _onPosition(lat, lng);
      await recomputeFences(lat, lng);
      dlog('startGeofencing: initial fix ' + lat.toFixed(4) + ',' + lng.toFixed(4));
    }
  } catch (err: any) {
    dlog('startGeofencing: getCurrentPosition failed: ' + (err?.message || err));
  }

  // Start the plugin. From here the OS-level geofences are armed; the app
  // can be closed and iOS will still wake it on region crosses.
  try {
    if (!_bgStarted) {
      const state = await BG.start();
      _bgStarted = true;
      dlog('BG.start: enabled=' + state?.enabled);
    }
  } catch (err: any) {
    dlog('BG.start failed: ' + (err?.message || err));
  }
}

export async function stopGeofencing(): Promise<void> {
  _onPosition = null;

  if (_watchId !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
    navigator.geolocation.clearWatch(_watchId);
    dlog('web watchPosition cleared');
    _watchId = null;
  }

  if (isNative() && _bgStarted) {
    const BG = await loadBgGeo();
    if (BG) {
      try {
        await BG.removeGeofences();
        await BG.stop();
        _bgStarted = false;
        _activeFenceIds.clear();
        dlog('BG stopped + fences removed');
      } catch (err: any) {
        dlog('BG.stop failed: ' + (err?.message || err));
      }
    }
  }
}

export function simulateLocation(lat: number, lng: number) {
  if (_onPosition) _onPosition(lat, lng);
  if (!isNative()) {
    // Web simulator: manually run the fence check since we don't have native fences.
    const now = Date.now();
    for (const site of _siteList) {
      const d = distanceMeters(lat, lng, site.coords.lat, site.coords.lng);
      if (d > GEOFENCE_RADIUS_M) continue;
      const lastAt = _lastNotifiedAt.get(site.id) || 0;
      if (now - lastAt < NOTIFICATION_COOLDOWN_MS) continue;
      _lastNotifiedAt.set(site.id, now);
      dlog(`SIM TRIGGER: ${site.title} at ${Math.round(d)}m`);
      void fireNotification(site);
    }
  }
}

// ---------- Internal helpers ----------

// Ranks sites by distance from (lat,lng) and pushes the top 20 to the native
// plugin as proper iOS regions. The plugin's removeGeofences() + addGeofences()
// pattern is atomic enough for our needs — we don't worry about briefly
// having zero fences active during the swap because the user has to be
// physically near a site at that exact moment for it to matter.
async function recomputeFences(lat: number, lng: number): Promise<void> {
  if (_siteList.length === 0) return;
  if (!isNative()) {
    // Web: we don't push to a native plugin, but we still update the active set
    // so simulateLocation() knows what to check.
    const ranked = _siteList
      .map(s => ({ site: s, d: distanceMeters(lat, lng, s.coords.lat, s.coords.lng) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_FENCES);
    _activeFenceIds = new Set(ranked.map(r => r.site.id));
    return;
  }

  const BG = await loadBgGeo();
  if (!BG) return;

  const ranked = _siteList
    .map(s => ({ site: s, d: distanceMeters(lat, lng, s.coords.lat, s.coords.lng) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_FENCES);

  const fences = ranked.map(r => ({
    identifier: r.site.id,
    radius: GEOFENCE_RADIUS_M,
    latitude: r.site.coords.lat,
    longitude: r.site.coords.lng,
    notifyOnEntry: true,
    notifyOnExit: false,
    notifyOnDwell: false,
    extras: {
      siteId: r.site.id,
      title: r.site.title,
    },
  }));

  try {
    await BG.removeGeofences();
    await BG.addGeofences(fences);
    _activeFenceIds = new Set(fences.map(f => f.identifier));
    dlog(`recomputeFences: ${fences.length} active, nearest=${ranked[0]?.site.title} (${Math.round(ranked[0]?.d || 0)}m)`);
  } catch (err: any) {
    dlog('recomputeFences failed: ' + (err?.message || err));
  }
}

async function fireNotification(site: SinisterSite): Promise<void> {
  if (!isNative()) return;
  const LN = loadLocalNotif();
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
          // iOS plays notifications silently if `sound` is missing. 'default'
          // tells iOS to use the system notification sound. Without this,
          // the banner appears but no audio plays — which is why Drew
          // never heard one despite notification permission being granted.
          sound: 'default',
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
