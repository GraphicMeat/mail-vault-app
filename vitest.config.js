import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60000,
    hookTimeout: 60000,
    // tests/integration/** hits a real Purelymail/Hostinger mailbox: slow,
    // rate-limited, and credential-gated. It is a conformance canary, not a
    // per-push gate — run it with `npm run test:live`. Client-side IMAP
    // behavior is covered deterministically by the Rust mock-server suites
    // (`cargo test -p mailvault-core -p mailvault-daemon`).
    // `.claude/worktrees/**` holds checkouts of other branches — vitest would
    // otherwise run their (often stale) copies of this same suite.
    exclude: ['tests/e2e/**', 'tests/integration/**', 'node_modules/**', '**/.claude/**'],
    environmentMatchGlobs: [
      ['src/components/**', 'jsdom'],
    ],
  },
});
