import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The two Capacitor native plugins below are iOS/Android-only. They have
// no proper browser entry points in their package.json, so Vite/Rollup
// cannot include them in the production web bundle. We mark them as
// 'external' so Rollup leaves the import paths as runtime references.
//
// At runtime in the iOS WebView, Capacitor's bridge resolves these
// imports to their native implementations. The dynamic imports in
// src/geofencing.ts are also gated by an isNative() check, so they
// never execute in the StackBlitz / browser preview.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      external: [
        '@capacitor-community/background-geolocation',
        '@capacitor/local-notifications',
      ],
    },
  },
  optimizeDeps: {
    exclude: [
      '@capacitor-community/background-geolocation',
      '@capacitor/local-notifications',
    ],
  },
});
