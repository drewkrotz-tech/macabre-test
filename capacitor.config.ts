import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.sinistertrivia.macabretest',
  appName: 'The Dread Directory',
  webDir: 'dist',
  server: {
    // Both platforms load the app from an https:// origin instead of
    // their respective custom schemes (capacitor:// on iOS, http:// on
    // Android). This is required for cross-origin iframes — notably the
    // YouTube embed in DreadFeed — to receive a valid Referer header.
    // Without this, WebKit/Blink strip the Referer on cross-scheme
    // iframe loads and YouTube's player rejects with Error 153 ("Video
    // player configuration error").
    iosScheme: 'https',
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
