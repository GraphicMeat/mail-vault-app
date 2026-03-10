import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60000,
    hookTimeout: 60000,
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
});
