import { defineConfig } from 'vitest/config';

// Integration suite: drives the mock IMAP server (`src-mock-imap`) on loopback
// with an independent JS client (imapflow) — hermetic, no credentials, no
// network. `npm run test:integration`.
//
// This replaced the live-provider conformance suite (.env.test). Rust client
// behavior is covered by `npm run test:imap`; this tier cross-checks the mock
// against a second client implementation and covers JS-side flows.
export default defineConfig({
  test: {
    testTimeout: 120000,
    hookTimeout: 60000,
    globalSetup: ['tests/integration/globalSetup.js'],
    include: ['tests/integration/**/*.test.js'],
    // dmg-smoke checks the signed release bundle — post-build verification,
    // not hermetic integration. `npm run test:dmg` after build-developer-id.sh.
    exclude: ['tests/integration/dmg-smoke.test.js', 'node_modules/**', '**/.claude/**'],
  },
});
