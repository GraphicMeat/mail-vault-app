import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// The mobile shell's frontend (src-tauri-mobile). Mirrors vite.config.js with the mobile entry
// and its own output dir, so a mobile build never touches the desktop `dist`.
export default defineConfig({
  plugins: [react()],
  // A build constant: '1' only in perf-gate builds (scripts/mobile-run.sh sets MV_PERF_GATE=1 for
  // --features perf-gate). App.jsx loads the scripted viewer probe behind it, so a shipping bundle
  // does not contain the probe at all.
  // `MV_APP_VERSION`: package.json's version, shown in Settings > About.
  define: {
    'import.meta.env.MV_APP_VERSION': JSON.stringify(version),
    'import.meta.env.MV_PERF_GATE': JSON.stringify(process.env.MV_PERF_GATE === '1' ? '1' : '0'),
  },
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
