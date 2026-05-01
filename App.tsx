// =============================================================================
// MACABRE TEST — APP
// =============================================================================
// Lean proof-of-concept UI:
//   - Home: list of 3 Sinister Sites
//   - Detail: title, image, description, "Get Directions" button
//   - Status bar: shows whether geofencing is running, current location,
//     and which sites have been triggered (for testing visibility)
//
// Sinister visual style:
//   - Black background, blood red accents, bone white text
//   - Boxy hard-edged cards with red borders
//   - Display font for headers, sans-serif for body
// =============================================================================

import { useEffect, useState } from 'react';
import { LocalNotifications } from '@capacitor/local-notifications';
import { App as CapacitorApp } from '@capacitor/app';
import {
  startGeofencing,
  stopGeofencing,
  requestPermissions,
  simulateLocation,
  distanceMeters,
} from './geofencing';
import { SINISTER_SITES, SinisterSite } from './locations';

// =============================================================================
// MAIN APP
// =============================================================================
export default function App() {
  const [selectedSite, setSelectedSite] = useState<SinisterSite | null>(null);
  const [geofencingActive, setGeofencingActive] = useState(false);
  const [currentLocation, setCurrentLocation] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  const [notifPermission, setNotifPermission] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize geofencing on mount
  useEffect(() => {
    (async () => {
      try {
        const perms = await requestPermissions();
        setNotifPermission(perms.notifications);

        await startGeofencing((lat, lng) => {
          setCurrentLocation({ lat, lng });
        });

        setGeofencingActive(true);
      } catch (err: any) {
        setError(err?.message || 'Failed to start geofencing');
      }
    })();

    // Handle notification tap → open detail view for that site
    LocalNotifications.addListener(
      'localNotificationActionPerformed',
      (action) => {
        const siteId = action.notification.extra?.siteId;
        if (siteId) {
          const site = SINISTER_SITES.find((s) => s.id === siteId);
          if (site) setSelectedSite(site);
        }
      }
    );

    return () => {
      stopGeofencing();
      LocalNotifications.removeAllListeners();
    };
  }, []);

  if (selectedSite) {
    return (
      <DetailView
        site={selectedSite}
        currentLocation={currentLocation}
        onBack={() => setSelectedSite(null)}
      />
    );
  }

  return (
    <HomeView
      sites={SINISTER_SITES}
      onSelectSite={setSelectedSite}
      geofencingActive={geofencingActive}
      currentLocation={currentLocation}
      notifPermission={notifPermission}
      error={error}
    />
  );
}

// =============================================================================
// HOME VIEW
// =============================================================================
function HomeView({
  sites,
  onSelectSite,
  geofencingActive,
  currentLocation,
  notifPermission,
  error,
}: {
  sites: SinisterSite[];
  onSelectSite: (s: SinisterSite) => void;
  geofencingActive: boolean;
  currentLocation: { lat: number; lng: number } | null;
  notifPermission: boolean;
  error: string | null;
}) {
  return (
    <div style={styles.appBg}>
      {/* HEADER */}
      <header style={styles.header}>
        <div style={styles.headerTitle}>MACABRE</div>
        <div style={styles.headerSubtitle}>TEST BUILD · v0.1</div>
      </header>

      {/* STATUS BAR (for debugging — remove for production) */}
      <div style={styles.statusBar}>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>GEOFENCING</span>
          <span
            style={{
              ...styles.statusValue,
              color: geofencingActive ? '#7CFFB2' : '#FF4444',
            }}
          >
            {geofencingActive ? 'ACTIVE' : 'OFFLINE'}
          </span>
        </div>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>NOTIFICATIONS</span>
          <span
            style={{
              ...styles.statusValue,
              color: notifPermission ? '#7CFFB2' : '#FF4444',
            }}
          >
            {notifPermission ? 'GRANTED' : 'DENIED'}
          </span>
        </div>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>LOCATION</span>
          <span style={styles.statusValue}>
            {currentLocation
              ? `${currentLocation.lat.toFixed(4)}, ${currentLocation.lng.toFixed(4)}`
              : 'WAITING…'}
          </span>
        </div>
        {error && <div style={styles.errorText}>⚠ {error}</div>}
      </div>

      {/* SITES LIST */}
      <div style={styles.sectionHeader}>SINISTER SITES — VIRGINIA BEACH</div>
      <div style={styles.sitesContainer}>
        {sites.map((site) => {
          const distM = currentLocation
            ? distanceMeters(
                currentLocation.lat,
                currentLocation.lng,
                site.coords.lat,
                site.coords.lng
              )
            : null;
          const distMi = distM ? (distM / 1609.34).toFixed(1) : null;

          return (
            <button
              key={site.id}
              onClick={() => onSelectSite(site)}
              style={styles.siteCard}
            >
              <div
                style={{
                  ...styles.siteCardImage,
                  backgroundImage: `url(${site.imageUrl})`,
                }}
              />
              <div style={styles.siteCardBody}>
                <div style={styles.siteCardCategory}>
                  {site.category.toUpperCase()}
                </div>
                <div style={styles.siteCardTitle}>{site.title}</div>
                <div style={styles.siteCardDesc}>{site.shortDescription}</div>
                {distMi && (
                  <div style={styles.siteCardDistance}>
                    {distMi} mi from you
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* DEV TOOLS — for testing without driving */}
      <div style={styles.devTools}>
        <div style={styles.devToolsHeader}>DEV: SIMULATE LOCATION</div>
        {sites.map((site) => (
          <button
            key={site.id}
            onClick={() =>
              simulateLocation(site.coords.lat, site.coords.lng)
            }
            style={styles.devButton}
          >
            Trigger "{site.title}"
          </button>
        ))}
      </div>

      <footer style={styles.footer}>
        🩸 ADMIN: hardcoded locations · USERS: submit via form (coming soon)
      </footer>
    </div>
  );
}

// =============================================================================
// DETAIL VIEW
// =============================================================================
function DetailView({
  site,
  currentLocation,
  onBack,
}: {
  site: SinisterSite;
  currentLocation: { lat: number; lng: number } | null;
  onBack: () => void;
}) {
  const distM = currentLocation
    ? distanceMeters(
        currentLocation.lat,
        currentLocation.lng,
        site.coords.lat,
        site.coords.lng
      )
    : null;
  const distMi = distM ? (distM / 1609.34).toFixed(1) : null;

  const handleDirections = () => {
    const url = `https://maps.apple.com/?daddr=${site.coords.lat},${site.coords.lng}`;
    window.open(url, '_blank');
  };

  return (
    <div style={styles.appBg}>
      <header style={styles.header}>
        <button onClick={onBack} style={styles.backButton}>
          ← BACK
        </button>
      </header>

      <div
        style={{
          ...styles.heroImage,
          backgroundImage: `url(${site.imageUrl})`,
        }}
      />

      <div style={styles.detailBody}>
        <div style={styles.detailCategory}>{site.category.toUpperCase()}</div>
        <div style={styles.detailTitle}>{site.title}</div>

        {distMi && (
          <div style={styles.detailDistance}>📍 {distMi} mi from you</div>
        )}

        <div style={styles.detailDivider} />

        <div style={styles.detailDescription}>
          {site.fullDescription.split('\n\n').map((para, i) => (
            <p key={i} style={styles.detailPara}>
              {para}
            </p>
          ))}
        </div>

        <button onClick={handleDirections} style={styles.directionsButton}>
          GET DIRECTIONS →
        </button>

        <div style={styles.imageCredit}>Photo: {site.imageCredit}</div>
      </div>
    </div>
  );
}

// =============================================================================
// STYLES — Sinister Trivia DNA: black + blood red + bone white, boxy edges
// =============================================================================
const RED = '#8B0000';
const RED_BRIGHT = '#C8102E';
const BLACK = '#0A0A0A';
const BONE = '#F0EBE0';
const GRAY_DARK = '#1A1A1A';
const GRAY_MID = '#3A3A3A';

const styles: Record<string, React.CSSProperties> = {
  appBg: {
    minHeight: '100vh',
    backgroundColor: BLACK,
    color: BONE,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    paddingBottom: 80,
  },
  header: {
    backgroundColor: BLACK,
    borderBottom: `3px solid ${RED}`,
    padding: '20px 16px 12px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 36,
    fontWeight: 900,
    letterSpacing: '0.15em',
    color: RED_BRIGHT,
    fontFamily: 'Georgia, "Times New Roman", serif',
    textShadow: `2px 2px 0px ${BLACK}`,
  },
  headerSubtitle: {
    fontSize: 10,
    letterSpacing: '0.3em',
    color: GRAY_MID,
    marginTop: 4,
  },
  backButton: {
    backgroundColor: 'transparent',
    border: `2px solid ${RED}`,
    color: BONE,
    padding: '8px 16px',
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.15em',
    cursor: 'pointer',
    alignSelf: 'flex-start',
  },
  statusBar: {
    backgroundColor: GRAY_DARK,
    borderBottom: `1px solid ${RED}`,
    padding: '12px 16px',
    fontSize: 11,
  },
  statusRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '2px 0',
  },
  statusLabel: {
    color: GRAY_MID,
    letterSpacing: '0.15em',
    fontWeight: 700,
  },
  statusValue: {
    fontFamily: 'Menlo, monospace',
    fontWeight: 700,
  },
  errorText: {
    color: '#FF4444',
    marginTop: 8,
    fontSize: 11,
  },
  sectionHeader: {
    padding: '24px 16px 12px',
    fontSize: 11,
    letterSpacing: '0.25em',
    fontWeight: 700,
    color: RED,
    borderBottom: `1px solid ${GRAY_DARK}`,
  },
  sitesContainer: {
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  siteCard: {
    backgroundColor: GRAY_DARK,
    border: `2px solid ${RED}`,
    padding: 0,
    cursor: 'pointer',
    textAlign: 'left',
    color: BONE,
    fontFamily: 'inherit',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  siteCardImage: {
    width: '100%',
    height: 180,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    borderBottom: `2px solid ${RED}`,
  },
  siteCardBody: {
    padding: 16,
  },
  siteCardCategory: {
    fontSize: 10,
    letterSpacing: '0.25em',
    color: RED_BRIGHT,
    fontWeight: 700,
    marginBottom: 6,
  },
  siteCardTitle: {
    fontSize: 22,
    fontWeight: 900,
    fontFamily: 'Georgia, serif',
    marginBottom: 8,
    color: BONE,
  },
  siteCardDesc: {
    fontSize: 13,
    lineHeight: 1.4,
    color: '#BBB',
  },
  siteCardDistance: {
    fontSize: 11,
    marginTop: 10,
    color: RED_BRIGHT,
    fontWeight: 700,
    letterSpacing: '0.1em',
  },
  heroImage: {
    width: '100%',
    height: 280,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    borderBottom: `3px solid ${RED}`,
  },
  detailBody: {
    padding: 20,
  },
  detailCategory: {
    fontSize: 11,
    letterSpacing: '0.25em',
    color: RED_BRIGHT,
    fontWeight: 700,
    marginBottom: 8,
  },
  detailTitle: {
    fontSize: 32,
    fontWeight: 900,
    fontFamily: 'Georgia, serif',
    lineHeight: 1.1,
    marginBottom: 12,
  },
  detailDistance: {
    fontSize: 13,
    color: RED_BRIGHT,
    fontWeight: 700,
    marginBottom: 16,
  },
  detailDivider: {
    height: 2,
    backgroundColor: RED,
    margin: '16px 0',
  },
  detailDescription: {
    fontSize: 15,
    lineHeight: 1.6,
    color: BONE,
  },
  detailPara: {
    marginBottom: 16,
  },
  directionsButton: {
    width: '100%',
    backgroundColor: RED,
    border: 'none',
    color: BONE,
    padding: '16px',
    fontSize: 14,
    fontWeight: 900,
    letterSpacing: '0.2em',
    cursor: 'pointer',
    marginTop: 16,
    fontFamily: 'inherit',
  },
  imageCredit: {
    fontSize: 10,
    color: GRAY_MID,
    textAlign: 'center',
    marginTop: 16,
    letterSpacing: '0.1em',
  },
  devTools: {
    margin: '32px 16px',
    padding: 16,
    backgroundColor: GRAY_DARK,
    border: `1px dashed ${GRAY_MID}`,
  },
  devToolsHeader: {
    fontSize: 10,
    letterSpacing: '0.25em',
    color: GRAY_MID,
    fontWeight: 700,
    marginBottom: 12,
  },
  devButton: {
    width: '100%',
    backgroundColor: 'transparent',
    border: `1px solid ${GRAY_MID}`,
    color: BONE,
    padding: '10px',
    fontSize: 12,
    cursor: 'pointer',
    marginBottom: 8,
    fontFamily: 'inherit',
    letterSpacing: '0.05em',
  },
  footer: {
    textAlign: 'center',
    fontSize: 10,
    color: GRAY_MID,
    padding: 16,
    letterSpacing: '0.1em',
  },
};
