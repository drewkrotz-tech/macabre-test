// geofencing.ts — Sinister Locales geofencing layer
//
// On NATIVE (iOS/Android via Capacitor):
//   - Requests "Always" location + notification permissions on first run
//   - Watches user position in the background
//   - Maintains a registered set of geofences for the 20 closest sites
//     (Apple's per-app limit). Recomputes the set when the user moves
//     more than RECALC_THRESHOLD_M from the last anchor point.
//   - On region enter: fires a local notification "You're near {title}"
//   - When the user taps the notification: dispatches a window 'sinister:open-site'
//     event that App.tsx listens to and uses to open the detail view.
//
// On WEB (StackBlitz preview):
//   - Falls back to navigator.geolocation.watchPosition for the location
//     dot in the UI. No notifications, no background. This is intentional —
//     real geofencing requires native code.
//
// Runtime detection: window.Capacitor.isNativePlatform(). NO static imports
// of @capacitor/* packages so the web preview doesn't choke on missing native
// modules. We dynamically import them only inside the isNative() branch.

import type { SinisterSite } from './locations';

// ---------- Tunables ----------
const GEOFENCE_RADIUS_M = 800;        // 0.5 mile per site
const MAX_FENCES = 20;                // Apple's per-app limit
const RECALC_THRESHOLD_M = 1500;      // recompute fence set when user moves > this from anchor
const NOTIFICATION_COOLDOWN_MS = 30 * 60 * 1000; // don't re-notify same site within 30 min

// ---------- Tiny shim around Capacitor runtime ----------
function isNative(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as any).Capacitor;
  return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
}

// ---------- Public API consumed by App.tsx ----------

export type Permissions = { location: boolean; notifications: boolean };

let _watchId: number | null = null;     // web: navigator.geolocation watch id
let _nativeWatchHandle: any = null;     // native: BackgroundGeolocation watcher handle
let _siteList: SinisterSite[] = [];     // current full site list (set by setSites)
let _activeFenceIds: Set<string> = new Set();
let _lastAnchor: { lat: number; lng: number } | null = null;
let _lastNotifiedAt: Map<string, number> = new Map();
let _onPosition: ((lat: number, lng: number) => void) | null = null;

// Set by App.tsx after fetching from server (or from bundled locations.ts).
// Calling this re-evaluates which sites should be registered as geofences
// based on the latest known position.
export function setSites(sites: SinisterSite[]) {
  _siteList = sites;
  if (_lastAnchor && isNative()) {
    void recomputeFences(_lastAnchor.lat, _lastAnchor.lng);
  }
}

export async function requestPermissions(): Promise<Permissions> {
  if (!isNative()) {
    // On web we just attempt geolocation when starting the watch. No
    // separate permission flow needed. Notifications aren't supported.
    return { location: false, notifications: false };
  }

  const result: Permissions = { location: false, notifications: false };

  try {
    const { LocalNotifications } = await (new Function('s', 'return import(s)'))('@capacitor/' + 'local-notifications');
    const notifPerm = await LocalNotifications.requestPermissions();
    result.notifications = notifPerm.display === 'granted';

    // Listen for notification taps: deep-link the user into the matching site.
    // Native notification action object includes the extra data we attached
    // when scheduling. siteId is what App.tsx uses to switch views.
    LocalNotifications.removeAllListeners?.();
    LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
      const siteId = action?.notification?.extra?.siteId;
      if (siteId && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('sinister:open-site', { detail: { siteId } }));
      }
    });
  } catch (err) {
    console.warn('[geofencing] notification permission setup failed:', err);
  }

  try {
    const { BackgroundGeolocation } = await (new Function('s', 'return import(s)'))('@capacitor-community/' + 'background-geolocation') as any;
    // BackgroundGeolocation.addWatcher returns a handle and starts streaming.
    // Calling here primarily to surface the permission prompt; the actual
    // streaming starts again in startGeofencing() below.
    const id = await BackgroundGeolocation.addWatcher(
      {
        backgroundMessage: 'Sinister Locales is tracking nearby sites.',
        backgroundTitle: 'Tracking active',
        requestPermissions: true,
        stale: false,
        distanceFilter: 50,
      },
      () => { /* one-shot to trigger prompt; real handler attached in startGeofencing */ }
    );
    // Tear down — startGeofencing will create the long-lived watcher.
    await BackgroundGeolocation.removeWatcher({ id });
    result.location = true;
  } catch (err) {
    console.warn('[geofencing] location permission setup failed:', err);
  }

  return result;
}

export async function startGeofencing(onPosition: (lat: number, lng: number) => void): Promise<void> {
  _onPosition = onPosition;

  if (!isNative()) {
    // Web fallback — just keep the UI's "current location" dot fresh.
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    _watchId = navigator.geolocation.watchPosition(
      (pos) => onPosition(pos.coords.latitude, pos.coords.longitude),
      () => { /* permission denied / no signal — silent */ },
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 60000 }
    );
    return;
  }

  // Native path: start the long-lived position watcher.
  const { BackgroundGeolocation } = await (new Function('s', 'return import(s)'))('@capacitor-community/' + 'background-geolocation') as any;
  _nativeWatchHandle = await BackgroundGeolocation.addWatcher(
    {
      backgroundMessage: 'Sinister Locales is tracking nearby sites.',
      backgroundTitle: 'Tracking active',
      requestPermissions: false, // already requested above
      stale: false,
      distanceFilter: 50,
    },
    async (location: any, error: any) => {
      if (error) {
        console.warn('[geofencing] watcher error:', error);
        return;
      }
      if (!location) return;
      const lat: number = location.latitude;
      const lng: number = location.longitude;

      onPosition(lat, lng);

      // Recompute the active geofence set if we've moved far from the last
      // anchor (or this is the first fix).
      if (!_lastAnchor || distanceMeters(lat, lng, _lastAnchor.lat, _lastAnchor.lng) > RECALC_THRESHOLD_M) {
        _lastAnchor = { lat, lng };
        await recomputeFences(lat, lng);
      }

      // Even outside the recompute, we still poll-test active fences ourselves
      // because Capacitor's bg-geo plugin doesn't ship a native region API on
      // iOS — we approximate geofence-enter by distance check on each fix.
      checkFenceTriggers(lat, lng);
    }
  );
}

export async function stopGeofencing(): Promise<void> {
  _onPosition = null;

  if (_watchId !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
    navigator.geolocation.clearWatch(_watchId);
    _watchId = null;
  }

  if (_nativeWatchHandle && isNative()) {
    try {
      const { BackgroundGeolocation } = await (new Function('s', 'return import(s)'))('@capacitor-community/' + 'background-geolocation') as any;
      await BackgroundGeolocation.removeWatcher({ id: _nativeWatchHandle });
    } catch { /* ignore */ }
    _nativeWatchHandle = null;
  }
}

// Web preview helper — App.tsx no longer surfaces the simulate buttons in v9+,
// but we keep this exported so any debug tool that wants to fake a location
// still can.
export function simulateLocation(lat: number, lng: number) {
  if (_onPosition) _onPosition(lat, lng);
  if (isNative()) {
    // On native we don't actually fake the OS position — only the UI hook.
    // For real testing, drive there.
  } else {
    checkFenceTriggers(lat, lng);
  }
}

// ---------- Internal helpers ----------

// Pick the MAX_FENCES closest sites to (lat, lng), update active set.
async function recomputeFences(lat: number, lng: number): Promise<void> {
  if (_siteList.length === 0) return;

  const ranked = _siteList
    .map(s => ({ site: s, d: distanceMeters(lat, lng, s.coords.lat, s.coords.lng) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_FENCES);

  const newIds = new Set(ranked.map(r => r.site.id));
  _activeFenceIds = newIds;

  // No native region API in use here — we simulate by distance check on each
  // fix in checkFenceTriggers(). If we later swap to a real native region
  // plugin, this is where we'd register/unregister regions with the OS.
}

// Per-fix check: any active site within radius? Notify (with cooldown).
function checkFenceTriggers(lat: number, lng: number): void {
  const now = Date.now();
  for (const site of _siteList) {
    if (!_activeFenceIds.has(site.id)) continue;
    const d = distanceMeters(lat, lng, site.coords.lat, site.coords.lng);
    if (d > GEOFENCE_RADIUS_M) continue;

    const lastAt = _lastNotifiedAt.get(site.id) || 0;
    if (now - lastAt < NOTIFICATION_COOLDOWN_MS) continue;

    _lastNotifiedAt.set(site.id, now);
    void fireNotification(site);
  }
}

async function fireNotification(site: SinisterSite): Promise<void> {
  if (!isNative()) return;
  try {
    const { LocalNotifications } = await (new Function('s', 'return import(s)'))('@capacitor/' + 'local-notifications');
    await LocalNotifications.schedule({
      notifications: [
        {
          id: hashString(site.id) % 2000000000, // notification IDs must be int32
          title: 'Sinister Locales',
          body: `You're near ${site.title}. Tap to see the story.`,
          extra: { siteId: site.id },
          // No `schedule` field => fires immediately.
        },
      ],
    });
  } catch (err) {
    console.warn('[geofencing] notification schedule failed:', err);
  }
}

// Cheap deterministic hash so notification IDs are stable per site.
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// Haversine — exposed because App.tsx uses it for "X mi from you" labels.
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
