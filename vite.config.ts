import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config. We intentionally do NOT externalize Capacitor plugin packages
// here — we used to in v1.1, but that caused runtime URL resolution failures
// in the iOS WebView. Instead, src/geofencing.ts now uses registerPlugin from
// @capacitor/core (the documented Capacitor pattern), which doesn't require
// importing the native plugin packages from the JS bundle at all. The native
// implementations are wired by Capacitor's iOS bridge via cap sync + pod
// install on the Codemagic build machine.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
});
