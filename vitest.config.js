import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60000,
    hookTimeout: 60000,
    // tests/integration/** drives the mock IMAP server through imapflow —
    // hermetic but needs a cargo build, so it runs as its own tier:
    // `npm run test:integration`.
    // Other checkouts and archived source snapshots are not active tests.
    exclude: ['tests/e2e/**', 'tests/integration/**', 'docs/archive/**', '**/node_modules/**', '**/.claude/**', '**/.worktrees/**'],
    environmentMatchGlobs: [
      ['src/components/**', 'jsdom'],
    ],
  },
});
