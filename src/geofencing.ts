import { SINISTER_SITES, SinisterSite } from './locations';

const notifiedSiteIds = new Set<string>();

function isNative(): boolean {
      if (typeof window === 'undefined') return false;
      const cap = (window as any).Capacitor;
      return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
}

export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
      const R = 6371000;
      const toRad = (deg: number) => (deg * Math.PI) / 180;
      const dLat = toRad(lat2 - lat1);
      const dLng = toRad(lng2 - lng1);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c;
}

async function fireSiteNotification(site: SinisterSite, distanceM: number) {
      const distanceMiles = (distanceM / 1609.34).toFixed(1);
      const body = `${site.title} — ${distanceMiles} mi away. ${site.shortDescription}`;
      console.log(`[SINISTER] ${body}`);
      if (typeof window !== 'undefined') {
              alert(`Sinister Site Located\n\n${body}`);
      }
}

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

export async function requestPermissions(): Promise<{ location: boolean; notifications: boolean }> {
      if (!isNative()) return { location: false, notifications: false };
      return { location: true, notifications: true };
}

export async function startGeofencing(_onLocationUpdate?: (lat: number, lng: number) => void): Promise<void> {
      if (!isNative()) {
              console.log('[SINISTER] Geofencing skipped - web mode.');
              return;
      }
      console.log('[SINISTER] Native mode detected - geofencing not yet wired in test build.');
}

export async function stopGeofencing(): Promise<void> {
      // No-op in web/test build
}

export function simulateLocation(lat: number, lng: number) {
      console.log(`[SINISTER] Simulating location: ${lat}, ${lng}`);
      checkSitesAgainstLocation(lat, lng);
}
