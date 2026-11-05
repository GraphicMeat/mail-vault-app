import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The mobile shell's frontend (src-tauri-mobile). Mirrors vite.config.js with the mobile entry
// and its own output dir, so a mobile build never touches the desktop `dist`.
export default defineConfig({
  plugins: [react()],
  root: '.',
  worker: {
    format: 'es'
  },
  build: {
    outDir: 'dist-mobile',
    // Same reason as vite.config.js: the CSP has `font-src 'self'`, so fonts ship as files.
    assetsInlineLimit: file => (/\.(woff2?|ttf|otf|eot)$/i.test(file) ? false : undefined),
    rollupOptions: {
      input: 'mobile.html'
    }
  },
  server: {
    port: 5174,
    open: '/mobile.html'
  }
});
