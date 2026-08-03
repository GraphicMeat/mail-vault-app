import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60000,
    hookTimeout: 60000,
    // tests/integration/** drives the mock IMAP server through imapflow —
    // hermetic but needs a cargo build, so it runs as its own tier:
    // `npm run test:integration`.
    // `.claude/worktrees/**` holds checkouts of other branches — vitest would
    // otherwise run their (often stale) copies of this same suite.
    exclude: ['tests/e2e/**', 'tests/integration/**', 'node_modules/**', '**/.claude/**'],
    environmentMatchGlobs: [
      ['src/components/**', 'jsdom'],
    ],
  },
});
