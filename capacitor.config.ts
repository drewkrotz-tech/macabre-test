import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.sinistertrivia.macabretest',
  appName: 'The Dread Directory',
  webDir: 'dist',
  server: {
    // androidScheme: 'https' is supported on Android (and is the
    // default in newer Capacitor versions). iOS does NOT support
    // iosScheme: 'https' — Capacitor's docs explicitly state http/https
    // can't be set because WKWebView reserves those schemes for itself.
    // The YouTube embed Referer issue on iOS is worked around in the
    // YouTubeEmbed component (uses YouTube's IFrame Player API rather
    // than a direct embed iframe, which bypasses the Referer check).
    androidScheme: 'https',
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_icon_config_sample',
      iconColor: '#8B0000',
    },
    BackgroundGeolocation: {
      // The plugin handles background location through native iOS region monitoring.
      // No web-side config required here; iOS plist strings are what matter.
    },
  },

  // Disable iOS's native swipe-back so our in-app drag gesture isn't hijacked.
  ios: {
    allowsBackForwardNavigationGestures: false,
  },
};

export default config;
