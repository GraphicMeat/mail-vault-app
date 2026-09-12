import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const demo = path => resolve(process.cwd(), 'src/demo', path);

export default defineConfig({
  root: resolve(process.cwd(), 'src/demo'),
  base: '/demo/',
  plugins: [react()],
  resolve: {
    alias: {
      [resolve(process.cwd(), 'src/services/billingApi.js')]: demo('billingApi.js'),
      '@tauri-apps/api/core': demo('tauri-core.js'),
      '@tauri-apps/api/event': demo('tauri-event.js'),
      '@tauri-apps/api/path': demo('tauri-path.js'),
      '@tauri-apps/api/app': demo('tauri-app.js'),
      '@tauri-apps/plugin-fs': demo('tauri-fs.js'),
      '@tauri-apps/plugin-dialog': demo('tauri-dialog.js'),
      '@tauri-apps/plugin-shell': demo('tauri-shell.js'),
    },
  },
  build: {
    outDir: resolve(process.cwd(), 'website/demo'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(process.cwd(), 'src/demo/index.html'),
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
