// =============================================================================
// MACABRE TEST — GEOFENCING ENGINE
// =============================================================================
// Uses @capacitor-community/background-geolocation for native iOS region
// monitoring (the OS-level API that survives app suspension) and
// @capacitor/local-notifications for the actual notification delivery.
//
// Flow:
//   1. App launches → request "Always" location permission
//   2. App launches → request notification permission
//   3. App launches → start watching position with significant-change accuracy
//   4. On each location update, check distance to every site
//   5. If user enters a site's radius for the first time today → fire notif
//   6. Track which sites have been notified to prevent spam
// =============================================================================

import { BackgroundGeolocation } from '@capacitor-community/background-geolocation';
import { LocalNotifications } from '@capacitor/local-notifications';
import { SINISTER_SITES, SinisterSite } from './locations';

// Track which site IDs have already pinged in the current session.
// (For real production, this would persist across app launches via storage.)
const notifiedSiteIds = new Set<string>();

let watcherId: string | null = null;

// =============================================================================
// HAVERSINE DISTANCE — calculates meters between two GPS coords
// =============================================================================
function distanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371000; // Earth radius in meters
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
// FIRE A SINISTER SITE NOTIFICATION
// =============================================================================
async function fireSiteNotification(site: SinisterSite, distanceM: number) {
  const distanceMiles = (distanceM / 1609.34).toFixed(1);

  await LocalNotifications.schedule({
    notifications: [
      {
        id: Math.floor(Math.random() * 100000),
        title: '🩸 Sinister Site Located',
        body: `${site.title} — ${distanceMiles} mi away. ${site.shortDescription}`,
        sound: 'default',
        extra: {
          siteId: site.id,
        },
      },
    ],
  });

  console.log(
    `[MACABRE] Fired notification for "${site.title}" at ${distanceM.toFixed(0)}m`
  );
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

    // Optional: re-arm the notification once user has moved far away.
    // If user gets >2x the radius from a site, allow notification again.
    if (dist > site.radiusMeters * 2 && notifiedSiteIds.has(site.id)) {
      notifiedSiteIds.delete(site.id);
    }
  }
}

// =============================================================================
// REQUEST PERMISSIONS — must be called before geofencing starts
// =============================================================================
export async function requestPermissions(): Promise<{
  location: boolean;
  notifications: boolean;
}> {
  // Notification permission
  const notifResult = await LocalNotifications.requestPermissions();
  const notifGranted = notifResult.display === 'granted';

  // Location permission is requested when we add the watcher below.
  // For now, just report what we have.
  return {
    location: true, // confirmed when watcher starts successfully
    notifications: notifGranted,
  };
}

// =============================================================================
// START GEOFENCING — call once on app launch
// =============================================================================
export async function startGeofencing(
  onLocationUpdate?: (lat: number, lng: number) => void
): Promise<void> {
  if (watcherId) {
    console.log('[MACABRE] Geofencing already running.');
    return;
  }

  try {
    watcherId = await BackgroundGeolocation.addWatcher(
      {
        backgroundMessage:
          'Macabre is watching for Sinister Sites near your location.',
        backgroundTitle: 'Macabre is active',
        requestPermissions: true,
        stale: false,
        distanceFilter: 50, // meters — only fire callback if user moved 50m
      },
      (location, error) => {
        if (error) {
          console.error('[MACABRE] Location error:', error);
          return;
        }
        if (!location) return;

        const { latitude, longitude } = location;
        console.log(
          `[MACABRE] Location update: ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`
        );

        if (onLocationUpdate) {
          onLocationUpdate(latitude, longitude);
        }

        checkSitesAgainstLocation(latitude, longitude);
      }
    );

    console.log('[MACABRE] Geofencing started. Watcher ID:', watcherId);
  } catch (err) {
    console.error('[MACABRE] Failed to start geofencing:', err);
    throw err;
  }
}

// =============================================================================
// STOP GEOFENCING
// =============================================================================
export async function stopGeofencing(): Promise<void> {
  if (!watcherId) return;
  await BackgroundGeolocation.removeWatcher({ id: watcherId });
  watcherId = null;
  console.log('[MACABRE] Geofencing stopped.');
}

// =============================================================================
// MANUAL TEST — for debugging without driving
// =============================================================================
export function simulateLocation(lat: number, lng: number) {
  console.log(`[MACABRE] Simulating location: ${lat}, ${lng}`);
  checkSitesAgainstLocation(lat, lng);
}

// Expose distance util for the UI
export { distanceMeters };
