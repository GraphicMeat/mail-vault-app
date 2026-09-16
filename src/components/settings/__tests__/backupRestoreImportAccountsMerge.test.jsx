// @vitest-environment jsdom

/**
 * Task 4.4 / plan decision 2: `import_backup` moves to the daemon, and the
 * daemon route never writes `accounts.json` (a cross-process race against
 * `db/accounts.js`'s own writer otherwise). `ImportResult.newAccounts`
 * changes shape from `string[]` (bare emails) to
 * `{id, email, imapServer, smtpServer, createdAt}[]` (`AccountsJsonEntry`,
 * `src-daemon/src/backup_zip.rs`). `BackupRestore.jsx`'s import handler must
 * merge those descriptors into `accounts.json` itself, before it reloads the
 * app, and its "these accounts still need passwords" message must read the
 * new shape's `.email`, not the old bare string.
 *
 * This is RED against the pre-Task-4.4 handler, which still does
 * `result.newAccounts.join('\n• ')` (works only for a string[]) and
 * never touches accounts.json at all.
 */

import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// In-memory accounts.json, exactly the surface `src/services/db/accounts.js`
// reads/writes through (`@tauri-apps/plugin-fs`, BaseDirectory.AppData).
let fsFiles = {};
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: (path) => (path in fsFiles ? Promise.resolve(fsFiles[path]) : Promise.reject(new Error('ENOENT'))),
  writeTextFile: (path, data) => { fsFiles[path] = data; return Promise.resolve(); },
  exists: (path) => Promise.resolve(path in fsFiles),
  mkdir: () => Promise.resolve(),
  remove: () => Promise.resolve(),
  BaseDirectory: { AppData: 1 },
}));

// `db/keychain.js` calls `transportSend('get_app_data_dir', {})` as a
// top-level module side effect the moment anything pulls the `db` barrel
// in (mailStore's workflows do, statically), before any test's own
// beforeEach runs. The default must resolve, not return undefined.
const sendMock = vi.fn(() => Promise.resolve(null));
vi.mock('../../../services/transport', () => ({ send: (...a) => sendMock(...a) }));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn().mockResolvedValue('/picked/mailvault-backup.zip'),
  save: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

const { default: BackupRestore } = await import('../BackupRestore');
const { useMailStore } = await import('../../../stores/mailStore');

const NEW_ACCOUNTS = [
  { id: 'new-alice', email: 'alice@test.com', imapServer: 'imap.alice.test', smtpServer: 'smtp.alice.test', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'new-bob', email: 'bob@test.com', imapServer: 'imap.bob.test', smtpServer: null, createdAt: '2026-01-01T00:00:00Z' },
];

beforeEach(() => {
  fsFiles = { 'accounts.json': JSON.stringify([{ id: 'existing-1', email: 'existing@test.com' }]) };
  sendMock.mockClear();
  sendMock.mockImplementation(() => Promise.resolve(null));
  window.__MAILVAULT_DEMO__ = true; // skip window.location.reload(), unrelated to the merge under test
  window.__TAURI__ = { core: { invoke: vi.fn() } };
  vi.stubGlobal('alert', vi.fn());
  useMailStore.setState({ accounts: [] });
});

afterEach(() => {
  cleanup();
  delete window.__MAILVAULT_DEMO__;
  delete window.__TAURI__;
  vi.unstubAllGlobals();
});

it('merges import_backup\'s newAccounts descriptors into accounts.json and lists their emails, not [object Object]', async () => {
  sendMock.mockImplementation((cmd) => {
    if (cmd === 'import_backup') {
      return Promise.resolve({ emailCount: 5, accountCount: 2, newAccounts: NEW_ACCOUNTS, settingsJson: null });
    }
    return Promise.resolve(null);
  });

  render(<BackupRestore />);
  fireEvent.click(screen.getByRole('button', { name: /Import Backup/i }));

  await waitFor(() => expect(window.alert).toHaveBeenCalled(), { timeout: 3000 });

  const onDisk = JSON.parse(fsFiles['accounts.json']);
  expect(onDisk.find((a) => a.email === 'existing@test.com')).toBeTruthy();
  expect(onDisk.find((a) => a.email === 'alice@test.com')).toMatchObject({ id: 'new-alice', imapServer: 'imap.alice.test' });
  expect(onDisk.find((a) => a.email === 'bob@test.com')).toMatchObject({ id: 'new-bob' });

  const msg = window.alert.mock.calls.map((c) => c[0]).join('\n');
  expect(msg).toContain('alice@test.com');
  expect(msg).toContain('bob@test.com');
  expect(msg).not.toContain('[object Object]');
});
