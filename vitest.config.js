import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60000,
    hookTimeout: 60000,
    setupFiles: ['./vitest.setup.js'],
    // tests/integration/** drives the mock IMAP server through imapflow —
    // hermetic but needs a cargo build, so it runs as its own tier:
    // `npm run test:integration`.
    // The frozen backup capture generator imports its original coordinator.
    // Run only from its documented capture commit; ordinary tests verify bytes.
    // Other checkouts and archived source snapshots are not active tests.
    exclude: ['src-core/tests/fixtures/gen/backup-schedule-cases.test.js', 'tests/e2e/**', 'tests/integration/**', 'docs/archive/**', '**/node_modules/**', '**/.claude/**', '**/.worktrees/**'],
    environmentMatchGlobs: [
      ['src/components/**', 'jsdom'],
    ],
  },
});
