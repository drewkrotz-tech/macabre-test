// =============================================================================
// MACABRE TEST — GEOFENCING ENGINE (web-safe)
// =============================================================================
// Lazily loads Capacitor plugins ONLY if running in a native app context.
// In the browser/Cloudflare web build, all native calls become no-ops so the
// UI can still render and the dev "simulate" buttons still work.
// =============================================================================

import { SINISTER_SITES, SinisterSite } from './locations';

// Track which site IDs have already pinged in the current session.
const notifiedSiteIds = new Set<string>();

let watcherId: string | null = null;
let nativeReady = false;
let BackgroundGeolocation: any = null;
let LocalNotifications: any = null;

// =============================================================================
// PLATFORM DETECTION + LAZY NATIVE LOADER
// =============================================================================
async function loadNativePlugins(): Promise<boolean> {
    if (nativeReady) return true;
    try {
          // @ts-ignore - dynamic import of Capacitor only when available
      const cap = await import('@capacitor/core').catch(() => null);
          if (!cap || !cap.Capacitor || !cap.Capacitor.isNativePlatform()) {
                  console.log('[MACABRE] Web mode — native geofencing disabled.');
                  return false;
          }
          // @ts-ignore
      const bg = await import('@capacitor-community/background-geolocation');
          // @ts-ignore
      const ln = await import('@capacitor/local-notifications');
          BackgroundGeolocation = bg.BackgroundGeolocation;
          LocalNotifications = ln.LocalNotifications;
          nativeReady = true;
          console.log('[MACABRE] Native plugins loaded.');
          return true;
    } catch (err) {
          console.log('[MACABRE] Native plugins unavailable:', err);
          return false;
    }
}

// =============================================================================
// HAVERSINE DISTANCE — meters between two GPS coords
// =============================================================================
export function distanceMeters(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number
  ): number {
    const R = 6371000;
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// =============================================================================
// FIRE NOTIFICATION (native) or fallback alert (web)
// =============================================================================
async function fireSiteNotification(site: SinisterSite, distanceM: number) {
    const distanceMiles = (distanceM / 1609.34).toFixed(1);
    const body = `${site.title} — ${distanceMiles} mi away. ${site.shortDescription}`;

  if (nativeReady && LocalNotifications) {
        await LocalNotifications.schedule({
                notifications: [
                  {
                              id: Math.floor(Math.random() * 100000),
                              title: '🩸 Sinister Site Located',
                              body,
                              sound: 'default',
                              extra: { siteId: site.id },
                  },
                        ],
        });
  } else {
        // Web fallback: just log + browser alert
      console.log(`[MACABRE WEB] 🩸 Sinister Site Located — ${body}`);
        if (typeof window !== 'undefined') {
                alert(`🩸 Sinister Site Located\n\n${body}`);
        }
  }
}

// =============================================================================
// CHECK ALL SITES AGAINST CURRENT LOCATION
// =============================================================================
function checkSitesAgainstLocation(lat: number, lng: number) {
    for (const site of SINISTER_SITES) {
          const dist = distanceMeters(lat, lng, site.coords.lat, site.coords.lng);
          if (dist <= site.radiusMeters && !notifiedSiteIds.has(site.id)) {
                  notifiedSiteIds.add(site.id);
                  fireSiteNotification(site, dist);
          }
          if (dist > site.radiusMeters * 2 && notifiedSiteIds.has(site.id)) {
                  notifiedSiteIds.delete(site.id);
          }
    }
}

// =============================================================================
// REQUEST PERMISSIONS
// =============================================================================
export async function requestPermissions(): Promise<{
    location: boolean;
    notifications: boolean;
}> {
    const native = await loadNativePlugins();
    if (!native) {
          return { location: false, notifications: false };
    }
    const notifResult = await LocalNotifications.requestPermissions();
    return {
          location: true,
          notifications: notifResult.display === 'granted',
    };
}

// =============================================================================
// START GEOFENCING
// =============================================================================
export async function startGeofencing(
    onLocationUpdate?: (lat: number, lng: number) => void
  ): Promise<void> {
    const native = await loadNativePlugins();
    if (!native) {
          console.log('[MACABRE] Geofencing skipped — web mode.');
          return;
    }
    if (watcherId) return;

  try {
        watcherId = await BackgroundGeolocation.addWatcher(
          {
                    backgroundMessage:
                                'Macabre is watching for Sinister Sites near your location.',
                    backgroundTitle: 'Macabre is active',
                    requestPermissions: true,
                    stale: false,
                    distanceFilter: 50,
          },
                (location: any, error: any) => {
                          if (error) {
                                      console.error('[MACABRE] Location error:', error);
                                      return;
                          }
                          if (!location) return;
                          const { latitude, longitude } = location;
                          if (onLocationUpdate) onLocationUpdate(latitude, longitude);
                          checkSitesAgainstLocation(latitude, longitude);
                }
              );
        console.log('[MACABRE] Geofencing started:', watcherId);
  } catch (err) {
        console.error('[MACABRE] Failed to start geofencing:', err);
  }
}

// =============================================================================
// STOP GEOFENCING
// =============================================================================
export async function stopGeofencing(): Promise<void> {
    if (!watcherId || !BackgroundGeolocation) return;
    await BackgroundGeolocation.removeWatcher({ id: watcherId });
    watcherId = null;
}

// =============================================================================
// MANUAL TEST — works in both web and native
// =============================================================================
export function simulateLocation(lat: number, lng: number) {
    console.log(`[MACABRE] Simulating location: ${lat}, ${lng}`);
    checkSitesAgainstLocation(lat, lng);
}
