import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.sinistertrivia.macabretest',
  appName: 'Macabre Test',
  webDir: 'dist',
  server: {
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
