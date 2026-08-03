import { defineConfig } from 'vitest/config';

// Post-build smoke test of the signed macOS release bundle.
// Run after build-developer-id.sh: `npm run test:dmg`.
export default defineConfig({
  test: {
    include: ['tests/integration/dmg-smoke.test.js'],
  },
});
