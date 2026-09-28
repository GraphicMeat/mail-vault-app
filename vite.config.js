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
