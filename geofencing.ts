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
// Per-site presence tracking. A site id lives in this set from the moment
// we get a confirmed ENTER until we get a debounced EXIT. While a site is
// in the set, additional ENTER events are ignored as GPS jitter — that
// stops the hotel-stay repeat-notification bug. The 30-min cooldown above
// stays in place as defense-in-depth in case we ever miss an EXIT.
//
// CRITICAL: this set + _lastNotifiedAt MUST be persisted to disk via
// savePresenceState() because iOS aggressively terminates the app between
// geofence events to save battery. When iOS wakes the app back up for
// the next event, the entire JS module reloads from scratch with empty
// state — without persistence, every ENTER looks like a first-time entry
// and fires a duplicate notification. See loadPresenceState() below for
// the cold-start rehydration.
let _currentlyInside: Set<string> = new Set();
// In-flight EXIT debounce timers keyed by site id. We don't trust the very
// first EXIT event because GPS at the radius boundary flickers; we wait
// EXIT_DEBOUNCE_MS for the device to stay outside before treating exit as
// real. If we get an ENTER for the same site before the timer fires, we
// cancel — that was just jitter.
const EXIT_DEBOUNCE_MS = 60 * 1000;
let _pendingExitTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
// Persistent companion to _pendingExitTimers. Maps site id -> Unix ms
// timestamp at which the exit should be committed. We persist this so
// that if iOS terminates the JS engine mid-debounce (very common when
// the user drives away from a site — iOS suspends the app right then),
// the deadline survives. On cold start, loadPresenceState() walks this
// map and commits any exits whose deadline has already passed, BEFORE
// any ENTER event can be processed. Without this, a short out-and-back
// trip ends with the site still in _currentlyInside on disk and the
// returning ENTER is silently suppressed as a "duplicate."
let _pendingExitDeadlines: Map<string, number> = new Map();

// ---------- Persistence (survives iOS app termination between events) ----------
// Storage key for the {currentlyInside, lastNotifiedAt} blob. Stored as a
// single JSON value to make the save atomic — one Preferences.set call
// per state change instead of two.
const PRESENCE_STORAGE_KEY = 'sinister.geofencePresence.v1';
let _presenceLoaded = false;

async function readPersistent(key: string): Promise<string | null> {
  try {
    const cap = (window as any).Capacitor;
    if (cap?.isNativePlatform?.() && cap?.Plugins?.Preferences) {
      const { value } = await cap.Plugins.Preferences.get({ key });
      return value || null;
    }
  } catch { /* fall through to web */ }
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
  } catch { /* fall through to web */ }
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, value); }
  catch { /* silent */ }
}

// Load _currentlyInside and _lastNotifiedAt from disk. Called once at
// module init before any geofence event can be processed. If the load
// fails or the stored data is malformed, we start with empty state —
// worst case is one duplicate notification, not a crash.
//
// Also rehydrates _pendingExitDeadlines and commits any exits whose
// deadline has passed during the time the app was terminated. This is
// what fixes the "drove to the store and came back, no notification"
// bug: the EXIT event fired, the 60-second debounce timer started, then
// iOS killed the app before the timer could complete. Without this
// catch-up, the site stays in _currentlyInside forever (until manually
// re-entered by walking into the radius from a different direction or
// something equally accidental), and every legitimate return is
// silently treated as a duplicate ENTER.
async function loadPresenceState(): Promise<void> {
  if (_presenceLoaded) return;
  try {
    const raw = await readPersistent(PRESENCE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.currentlyInside)) {
        _currentlyInside = new Set(parsed.currentlyInside);
      }
      if (parsed && parsed.lastNotifiedAt && typeof parsed.lastNotifiedAt === 'object') {
        _lastNotifiedAt = new Map(Object.entries(parsed.lastNotifiedAt));
      }
      if (parsed && parsed.pendingExitDeadlines && typeof parsed.pendingExitDeadlines === 'object') {
        _pendingExitDeadlines = new Map(
          Object.entries(parsed.pendingExitDeadlines).map(([k, v]) => [k, Number(v)])
        );
      }

      // Catch-up: walk persisted deadlines and commit any that have
      // expired during termination. We mutate _currentlyInside in place;
      // savePresenceState() is called once at the end to persist the
      // cleaned-up state. We do NOT restart in-memory setTimeouts for
      // unexpired deadlines — if iOS wakes us again before the deadline,
      // the deadline will simply expire in disk and be caught on the
      // NEXT cold start. The native plugin is what wakes us, not a JS
      // timer, so we don't need an active timer to make progress.
      const now = Date.now();
      let committedAny = false;
      for (const [siteId, deadline] of Array.from(_pendingExitDeadlines.entries())) {
        if (deadline <= now) {
          _currentlyInside.delete(siteId);
          _pendingExitDeadlines.delete(siteId);
          committedAny = true;
          dlog('loadPresenceState: committed expired exit for ' + siteId);
        }
      }
      if (committedAny) savePresenceState();

      dlog('loadPresenceState: restored ' + _currentlyInside.size + ' inside, ' + _lastNotifiedAt.size + ' cooldowns, ' + _pendingExitDeadlines.size + ' pending exits');
    } else {
      dlog('loadPresenceState: no prior state');
    }
  } catch (err: any) {
    dlog('loadPresenceState failed: ' + (err?.message || err));
  }
  _presenceLoaded = true;
}

// Serialize current state to disk. Called after every mutation. Fire-
// and-forget — we don't await it from the geofence event handler because
// blocking on Preferences.set could lose the event if the JS engine is
// torn down mid-write. If a write loses, the worst case is the in-memory
// state being one step ahead of disk — next time the app cold-starts
// it'll think the user is still inside (or has a stale cooldown) which
// is the SAFE direction to fail (no duplicate notifications).
function savePresenceState(): void {
  const payload = JSON.stringify({
    currentlyInside: Array.from(_currentlyInside),
    lastNotifiedAt: Object.fromEntries(_lastNotifiedAt),
    pendingExitDeadlines: Object.fromEntries(_pendingExitDeadlines),
    savedAt: Date.now(),
  });
  void writePersistent(PRESENCE_STORAGE_KEY, payload);
}

// Kick off persistence load at module init. Doesn't block module load —
// the load completes in the background, and geofence events that arrive
// before it finishes will see empty state (worst case: one extra
// notification on the very first cold-start after install).
void loadPresenceState();
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

      const site = _siteList.find(s => s.id === id);
      if (!site) {
        dlog('onGeofence: site not found for id=' + id);
        return;
      }

      if (action === 'ENTER') {
        // Cancel any pending exit debounce for this site — we entered again
        // before the exit was confirmed, so the prior "exit" was just GPS
        // jitter at the boundary. We clear BOTH the in-memory timer AND
        // the persisted deadline — if we only cleared the timer, the
        // deadline would still be on disk and the next cold start would
        // incorrectly commit the exit and remove the site from
        // _currentlyInside.
        const pending = _pendingExitTimers.get(site.id);
        if (pending) {
          clearTimeout(pending);
          _pendingExitTimers.delete(site.id);
          dlog('onGeofence: cancelled pending exit for ' + site.title);
        }
        if (_pendingExitDeadlines.has(site.id)) {
          _pendingExitDeadlines.delete(site.id);
          savePresenceState();
        }
        // If we already think the user is inside this site, this ENTER is
        // a duplicate (GPS reacquisition, signal regain, etc.). Suppress —
        // this is the core of the hotel-stay fix. Works across iOS app
        // termination because _currentlyInside is hydrated from disk by
        // loadPresenceState() before any geofence event is processed.
        if (_currentlyInside.has(site.id)) {
          dlog('onGeofence: already inside ' + site.title + ', ignoring duplicate ENTER');
          return;
        }
        // Defense-in-depth time cooldown: still respected so a misbehaving
        // exit-handling path can't spam notifications.
        const now = Date.now();
        const lastAt = _lastNotifiedAt.get(site.id) || 0;
        if (now - lastAt < NOTIFICATION_COOLDOWN_MS) {
          dlog('onGeofence: cooldown active for ' + site.title);
          // Still mark as inside so subsequent jitter ENTERs are deduped.
          _currentlyInside.add(site.id);
          savePresenceState();
          return;
        }
        _currentlyInside.add(site.id);
        _lastNotifiedAt.set(site.id, now);
        savePresenceState();
        void fireNotification(site);
        return;
      }

      if (action === 'EXIT') {
        // Don't trust the first EXIT — wait EXIT_DEBOUNCE_MS to confirm
        // the user really left and isn't just dancing on the boundary.
        if (_pendingExitTimers.has(site.id)) {
          // Already a pending confirmation — let it run.
          return;
        }
        // Record the deadline to disk BEFORE setting the in-memory timer.
        // This is what makes the debounce durable across iOS app
        // termination: even if iOS kills the JS context the moment after
        // this handler returns (very likely — leaving a geofence is a
        // classic moment for the OS to suspend the app), the deadline
        // survives. Next cold start, loadPresenceState() will see the
        // expired deadline and commit the exit before any returning
        // ENTER can be processed.
        const deadline = Date.now() + EXIT_DEBOUNCE_MS;
        _pendingExitDeadlines.set(site.id, deadline);
        savePresenceState();
        const timer = setTimeout(() => {
          _currentlyInside.delete(site.id);
          _pendingExitTimers.delete(site.id);
          _pendingExitDeadlines.delete(site.id);
          savePresenceState();
          dlog('onGeofence: confirmed exit from ' + site.title);
        }, EXIT_DEBOUNCE_MS);
        _pendingExitTimers.set(site.id, timer);
        dlog('onGeofence: pending exit from ' + site.title + ' (debouncing)');
        return;
      }

      // DWELL or anything else — ignore for now.
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
      savePresenceState();
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
    notifyOnExit: true,
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
