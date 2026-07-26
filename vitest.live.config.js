import { defineConfig } from 'vitest/config';

// Live conformance suite: talks to a real Purelymail/Hostinger mailbox using
// credentials from .env.test. Slow and rate-limited — run it on a schedule or
// before a release, not on every push. `npm run test:live`.
//
// Its job is to catch a provider changing behavior on us. Our own client
// behavior is covered by the mock-server suites (`npm run test:imap`).
export default defineConfig({
  test: {
    testTimeout: 600000,
    hookTimeout: 60000,
    include: ['tests/integration/**/*.test.js'],
    exclude: ['node_modules/**', '**/.claude/**'],
  },
});
