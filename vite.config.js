import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: '.',
  // The Insights worker is created as a module worker, and its import graph
  // holds a dynamic import that rollup splits into a chunk: IIFE cannot split.
  worker: {
    format: 'es'
  },
  build: {
    // The CSP has `font-src 'self'` (no data:), so a font under the 4KB inline
    // limit would be inlined into the CSS and blocked. Ship fonts as files.
    assetsInlineLimit: file => (/\.(woff2?|ttf|otf|eot)$/i.test(file) ? false : undefined),
    rollupOptions: {
      input: 'app.html'
    }
  },
  server: {
    port: 5173,
    open: '/app.html',
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
});
