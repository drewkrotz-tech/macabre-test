import { useEffect, useState } from 'react';
import {
  startGeofencing,
  stopGeofencing,
  requestPermissions,
  simulateLocation,
  distanceMeters,
} from './geofencing';
import { SINISTER_SITES, SinisterSite } from './locations';

export default function App() {
  const [selectedSite, setSelectedSite] = useState<SinisterSite | null>(null);
  const [geofencingActive, setGeofencingActive] = useState(false);
  const [currentLocation, setCurrentLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [notifPermission, setNotifPermission] = useState<boolean>(false);
  const [isWebMode, setIsWebMode] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const perms = await requestPermissions();
        setNotifPermission(perms.notifications);
        if (!perms.notifications && !perms.location) setIsWebMode(true);
        await startGeofencing((lat, lng) => setCurrentLocation({ lat, lng }));
        setGeofencingActive(perms.location);
      } catch (err: any) {
        setError(err?.message || 'Failed to start geofencing');
      }
    })();
    return () => { stopGeofencing(); };
  }, []);

  if (selectedSite) {
    return <DetailView site={selectedSite} currentLocation={currentLocation} onBack={() => setSelectedSite(null)} />;
  }
  return (
    <HomeView
      sites={SINISTER_SITES}
      onSelectSite={setSelectedSite}
      geofencingActive={geofencingActive}
      currentLocation={currentLocation}
      notifPermission={notifPermission}
      isWebMode={isWebMode}
      error={error}
    />
  );
}

function HomeView({ sites, onSelectSite, geofencingActive, currentLocation, notifPermission, isWebMode, error }: {
  sites: SinisterSite[];
  onSelectSite: (s: SinisterSite) => void;
  geofencingActive: boolean;
  currentLocation: { lat: number; lng: number } | null;
  notifPermission: boolean;
  isWebMode: boolean;
  error: string | null;
}) {
  return (
    <div style={styles.appBg}>
      <header style={styles.header}>
        <div style={styles.headerTitle}>MACABRE</div>
        <div style={styles.headerSubtitle}>TEST BUILD · v0.1</div>
      </header>
      <div style={styles.statusBar}>
        {isWebMode && <div style={styles.webModeNotice}>⚠ WEB PREVIEW MODE — geofencing disabled. Use Simulate buttons below.</div>}
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>GEOFENCING</span>
          <span style={{ ...styles.statusValue, color: geofencingActive ? '#7CFFB2' : '#FF4444' }}>{geofencingActive ? 'ACTIVE' : 'OFFLINE'}</span>
        </div>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>NOTIFICATIONS</span>
          <span style={{ ...styles.statusValue, color: notifPermission ? '#7CFFB2' : '#FF4444' }}>{notifPermission ? 'GRANTED' : 'DENIED'}</span>
        </div>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>LOCATION</span>
          <span style={styles.statusValue}>{currentLocation ? `${currentLocation.lat.toFixed(4)}, ${currentLocation.lng.toFixed(4)}` : 'WAITING…'}</span>
        </div>
        {error && <div style={styles.errorText}>⚠ {error}</div>}
      </div>
      <div style={styles.sectionHeader}>SINISTER SITES — VIRGINIA BEACH</div>
      <div style={styles.sitesContainer}>
        {sites.map((site) => {
          const distM = currentLocation ? distanceMeters(currentLocation.lat, currentLocation.lng, site.coords.lat, site.coords.lng) : null;
          const distMi = distM ? (distM / 1609.34).toFixed(1) : null;
          return (
            <button key={site.id} onClick={() => onSelectSite(site)} style={styles.siteCard}>
              <div style={{ ...styles.siteCardImage, backgroundImage: `url(${site.imageUrl})` }} />
              <div style={styles.siteCardBody}>
                <div style={styles.siteCardCategory}>{site.category.toUpperCase()}</div>
                <div style={styles.siteCardTitle}>{site.title}</div>
                <div style={styles.siteCardDesc}>{site.shortDescription}</div>
                {distMi && <div style={styles.siteCardDistance}>{distMi} mi from you</div>}
              </div>
            </button>
          );
        })}
      </div>
      <div style={styles.devTools}>
        <div style={styles.devToolsHeader}>DEV: SIMULATE LOCATION</div>
        {sites.map((site) => (
          <button key={site.id} onClick={() => simulateLocation(site.coords.lat, site.coords.lng)} style={styles.devButton}>
            Trigger "{site.title}"
          </button>
        ))}
      </div>
      <footer style={styles.footer}>🩸 ADMIN: hardcoded locations · USERS: submit via form (coming soon)</footer>
    </div>
  );
}

function DetailView({ site, currentLocation, onBack }: {
  site: SinisterSite;
  currentLocation: { lat: number; lng: number } | null;
  onBack: () => void;
}) {
  const distM = currentLocation ? distanceMeters(currentLocation.lat, currentLocation.lng, site.coords.lat, site.coords.lng) : null;
  const distMi = distM ? (distM / 1609.34).toFixed(1) : null;
  const handleDirections = () => {
    const url = `https://maps.apple.com/?daddr=${site.coords.lat},${site.coords.lng}`;
    window.open(url, '_blank');
  };
  return (
    <div style={styles.appBg}>
      <header style={styles.header}>
        <button onClick={onBack} style={styles.backButton}>← BACK</button>
      </header>
      <div style={{ ...styles.heroImage, backgroundImage: `url(${site.imageUrl})` }} />
      <div style={styles.detailBody}>
        <div style={styles.detailCategory}>{site.category.toUpperCase()}</div>
        <div style={styles.detailTitle}>{site.title}</div>
        {distMi && <div style={styles.detailDistance}>📍 {distMi} mi from you</div>}
        <div style={styles.detailDivider} />
        <div style={styles.detailDescription}>
          {site.fullDescription.split('\n\n').map((para, i) => <p key={i} style={styles.detailPara}>{para}</p>)}
        </div>
        <button onClick={handleDirections} style={styles.directionsButton}>GET DIRECTIONS →</button>
        <div style={styles.imageCredit}>Photo: {site.imageCredit}</div>
      </div>
    </div>
  );
}

const RED = '#8B0000';
const RED_BRIGHT = '#C8102E';
const BLACK = '#0A0A0A';
const BONE = '#F0EBE0';
const GRAY_DARK = '#1A1A1A';
const GRAY_MID = '#3A3A3A';

const styles: Record<string, React.CSSProperties> = {
  appBg: { minHeight: '100vh', backgroundColor: BLACK, color: BONE, fontFamily: 'system-ui, -apple-system, sans-serif', paddingBottom: 80 },
  header: { backgroundColor: BLACK, borderBottom: `3px solid ${RED}`, padding: '20px 16px 12px', display: 'flex', flexDirection: 'column', alignItems: 'center' },
  headerTitle: { fontSize: 36, fontWeight: 900, letterSpacing: '0.15em', color: RED_BRIGHT, fontFamily: 'Georgia, "Times New Roman", serif', textShadow: `2px 2px 0px
