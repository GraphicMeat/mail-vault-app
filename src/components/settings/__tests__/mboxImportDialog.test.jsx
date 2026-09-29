// @vitest-environment jsdom

/**
 * The MBOX import options dialog (plan 2026-09-29, Task 4). After the file
 * pick, Import MBOX asks how to import before anything reaches the daemon:
 * three modes (names verbatim from the reply sent to the customer), the target
 * account, and for a Takeout file its labels plus the folder for mail no label
 * matches. The dialog only collects choices; `import_mbox` does the work.
 */

import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// `db/keychain.js` reads the app data dir as a module side effect the moment
// the `db` barrel loads (see backupRestoreImportAccountsMerge.test.jsx).
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: () => Promise.reject(new Error('ENOENT')),
  writeTextFile: () => Promise.resolve(),
  exists: () => Promise.resolve(false),
  mkdir: () => Promise.resolve(),
  remove: () => Promise.resolve(),
}));

const SOURCE = '/picked/takeout.mbox';

// Gmail as the cached listing holds it: All Mail carries no special use, only
// its raw LIST attribute in `flags`. The Archive folder is here too so a
// default that ignores `flags` picks the wrong one.
const GMAIL_LIST = [
  { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox', flags: [], delimiter: '/', noselect: false, children: [] },
  { name: 'All Mail', path: '[Gmail]/All Mail', specialUse: null, flags: ['Extension("\\\\HasNoChildren")', 'All'], delimiter: '/', noselect: false, children: [] },
  { name: 'Archive', path: 'Archive', specialUse: '\\Archive', flags: [], delimiter: '/', noselect: false, children: [] },
  { name: 'Work', path: 'Work', specialUse: null, flags: [], delimiter: '/', noselect: false, children: [] },
  { name: '[Gmail]', path: '[Gmail]', specialUse: null, flags: [], delimiter: '/', noselect: true, children: [] },
];
const PLAIN_LIST = [
  { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox', flags: [], delimiter: '/', noselect: false, children: [] },
  { name: 'Archive', path: 'Archive', specialUse: '\\Archive', flags: [], delimiter: '/', noselect: false, children: [] },
];

const GMAIL = { id: 'acct-gmail', email: 'me@gmail.test' };
const PLAIN = { id: 'acct-plain', email: 'me@plain.test' };
const GRAPH = { id: 'acct-graph', email: 'me@outlook.test', oauth2Transport: 'graph' };

let probe;
let listings;
let importAnswer;
const sendImpl = (cmd, args) => {
  if (cmd === 'get_app_data_dir') return Promise.resolve('/data');
  if (cmd === 'mbox_probe') return typeof probe === 'function' ? probe(args) : Promise.resolve(probe);
  if (cmd === 'load_mailbox_cache') {
    const list = listings[args.accountId];
    return Promise.resolve(list ? JSON.stringify({ mailboxes: list, fetchedAt: 1 }) : null);
  }
  if (cmd === 'import_mbox') return importAnswer();
  return Promise.resolve(null);
};
const sendMock = vi.fn(sendImpl);
vi.mock('../../../services/transport', () => ({ send: (...a) => sendMock(...a) }));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(() => Promise.resolve('/picked/takeout.mbox')),
  save: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
// An upload start or resume resolves the account first (keychain, token
// refresh), as the backup does; the store's accounts here carry no credentials.
const resolveServerAccount = vi.fn(async (id, account) => ({ ok: true, account }));
vi.mock('../../../services/authUtils', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveServerAccount: (...a) => resolveServerAccount(...a),
}));

const { default: BackupRestore } = await import('../BackupRestore');
const { useMailStore } = await import('../../../stores/mailStore');

const LABELS = { hasLabels: true, foldersKnown: true, bytes: 1024, sampledMessages: 3 };
const NO_LABELS = { hasLabels: false, foldersKnown: true, bytes: 1024, sampledMessages: 3 };

beforeEach(() => {
  probe = LABELS;
  listings = { [GMAIL.id]: GMAIL_LIST, [PLAIN.id]: PLAIN_LIST, [GRAPH.id]: PLAIN_LIST };
  importAnswer = () => Promise.resolve({ emailCount: 1, skippedCount: 0, accountId: GMAIL.id, mailbox: 'INBOX', folders: [], foldersKnown: false });
  sendMock.mockClear();
  sendMock.mockImplementation(sendImpl);
  window.__MAILVAULT_DEMO__ = true; // skips window.location.reload() after the import
  window.__TAURI__ = { core: { invoke: vi.fn() } };
  vi.stubGlobal('alert', vi.fn());
  useMailStore.setState({ accounts: [GMAIL, PLAIN, GRAPH], activeAccountId: null, exportProgress: null });
});

afterEach(async () => {
  // A finished import alerts 1.5s later: let it land in its own test, not in
  // the next one's alert stub. An upload to the server alerts nothing: the
  // corner chip follows it.
  if (importCalls().some(([, a]) => a.mode !== 'server')) await waitFor(() => expect(window.alert).toHaveBeenCalled(), { timeout: 3000 });
  cleanup();
  delete window.__MAILVAULT_DEMO__;
  delete window.__TAURI__;
  vi.unstubAllGlobals();
});

async function openDialog() {
  render(<BackupRestore />);
  fireEvent.click(screen.getByRole('button', { name: /Import MBOX/i }));
  return screen.findByRole('dialog');
}

// The folder picker is there once the probe has answered.
const folderPicker = (dialog, name) => within(dialog).findByRole('combobox', { name });
const FALLBACK = 'Folder for mail with no matching label';
const TARGET = 'Import into folder';

const modeButton = (dialog, title) => within(dialog).getByRole('button', { name: new RegExp(`^${title.replace(/[[\]]/g, '\\$&')}`) });
const SERVER = 'Import and restore to the server';
const LOCAL = 'Import into my existing folders';
const FOLDER = 'Import as a separate folder';
const GRAPH_REASON = 'Only for IMAP accounts. This Outlook account uses Microsoft Graph, which cannot restore messages to the server.';

const importCalls = () => sendMock.mock.calls.filter(([cmd]) => cmd === 'import_mbox');

async function confirm(dialog) {
  const button = within(dialog).getByRole('button', { name: 'Import' });
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
  // An upload start resolves the account first (loaded on demand).
  await waitFor(() => expect(importCalls()).toHaveLength(1), { timeout: 5000 });
  return importCalls()[0][1];
}

it('asks how to import after the file pick, offering the three modes by their exact names with a description each', async () => {
  const dialog = await openDialog();

  for (const title of [SERVER, LOCAL, FOLDER]) {
    const button = modeButton(dialog, title);
    // The one-line description sits inside the button, after the title.
    expect(button.textContent.length).toBeGreaterThan(title.length + 10);
  }
  // The probe ran for the picked file and the default account; nothing was imported.
  await waitFor(() => expect(sendMock).toHaveBeenCalledWith('mbox_probe', { sourcePath: SOURCE, accountId: GMAIL.id }));
  expect(importCalls()).toHaveLength(0);
});

it('defaults the target account to the account on screen', async () => {
  useMailStore.setState({ activeAccountId: PLAIN.id });
  const dialog = await openDialog();
  expect(within(dialog).getByRole('combobox', { name: 'Account' }).value).toBe(PLAIN.id);
  await waitFor(() => expect(sendMock).toHaveBeenCalledWith('mbox_probe', { sourcePath: SOURCE, accountId: PLAIN.id }));
});

it('disables "Import and restore to the server" with its reason on a Graph account only', async () => {
  const dialog = await openDialog();
  expect(modeButton(dialog, SERVER).disabled).toBe(false);
  expect(within(dialog).queryByText(GRAPH_REASON)).toBeNull();

  fireEvent.change(within(dialog).getByRole('combobox', { name: 'Account' }), { target: { value: GRAPH.id } });

  await waitFor(() => expect(modeButton(dialog, SERVER).disabled).toBe(true));
  expect(within(dialog).getByText(GRAPH_REASON)).toBeTruthy();
  // Modes 2 and 3 still work on Graph (D4).
  expect(modeButton(dialog, LOCAL).disabled).toBe(false);
  expect(modeButton(dialog, FOLDER).disabled).toBe(false);
  // A new account is a new folder list: probed again for it.
  await waitFor(() => expect(sendMock).toHaveBeenCalledWith('mbox_probe', { sourcePath: SOURCE, accountId: GRAPH.id }));
});

it('for a Takeout file shows the labels toggle, on, and a fallback picker defaulting to All Mail on Gmail, else Archive', async () => {
  const dialog = await openDialog();
  const picker = await folderPicker(dialog, FALLBACK);
  expect(within(dialog).getByRole('switch', { name: 'Use Gmail labels' }).getAttribute('aria-checked')).toBe('true');
  expect(picker.value).toBe('[Gmail]/All Mail');
  // The cached folder list is the choice, unselectable parents left out.
  expect([...picker.options].map((o) => o.value)).toEqual(['INBOX', '[Gmail]/All Mail', 'Archive', 'Work']);

  fireEvent.change(within(dialog).getByRole('combobox', { name: 'Account' }), { target: { value: PLAIN.id } });
  await waitFor(() => expect(within(dialog).getByRole('combobox', { name: FALLBACK }).value).toBe('Archive'));
});

it('a file without labels gets a plain folder picker defaulting to INBOX, even where All Mail and Archive exist', async () => {
  probe = NO_LABELS;
  const dialog = await openDialog();
  const picker = await folderPicker(dialog, TARGET);
  expect(picker.value).toBe('INBOX');
  expect(within(dialog).queryByRole('switch')).toBeNull();
  expect(within(dialog).queryByRole('combobox', { name: FALLBACK })).toBeNull();
});

it('does not offer labels when the daemon has no folder list to route them by', async () => {
  // Labels need the folder list: without it a label import is refused or
  // files everything under the fallback, so the dialog asks for one folder.
  probe = { ...LABELS, foldersKnown: false };
  const dialog = await openDialog();
  expect((await folderPicker(dialog, TARGET)).value).toBe('INBOX');
  expect(within(dialog).queryByRole('switch')).toBeNull();
});

it('confirming with labels on sends the fallback folder path verbatim', async () => {
  const dialog = await openDialog();
  await folderPicker(dialog, FALLBACK);
  expect(await confirm(dialog)).toEqual({
    sourcePath: SOURCE, accountId: GMAIL.id, mode: 'local',
    mailbox: '[Gmail]/All Mail', fallbackMailbox: '[Gmail]/All Mail', useLabels: true,
  });
});

it('confirming with labels off sends the picked folder alone, in the picked mode', async () => {
  importAnswer = () => Promise.resolve({ jobId: 'job-1', started: true });
  const dialog = await openDialog();
  const picker = await folderPicker(dialog, FALLBACK);
  fireEvent.change(picker, { target: { value: 'Work' } });
  fireEvent.click(within(dialog).getByRole('switch', { name: 'Use Gmail labels' }));
  fireEvent.click(modeButton(dialog, SERVER));
  expect(modeButton(dialog, SERVER).getAttribute('aria-pressed')).toBe('true');
  // With labels off the same picker is the target folder.
  expect(within(dialog).getByRole('combobox', { name: TARGET }).value).toBe('Work');

  expect(await confirm(dialog)).toEqual({
    sourcePath: SOURCE, accountId: GMAIL.id, mode: 'server', mailbox: 'Work', useLabels: false,
  });
});

it('"Import as a separate folder" asks for no folder and sends none', async () => {
  const dialog = await openDialog();
  await folderPicker(dialog, FALLBACK);
  fireEvent.click(modeButton(dialog, FOLDER));
  expect(within(dialog).queryByRole('switch')).toBeNull();
  expect(within(dialog).queryByRole('combobox', { name: FALLBACK })).toBeNull();
  expect(within(dialog).queryByRole('combobox', { name: TARGET })).toBeNull();

  expect(await confirm(dialog)).toEqual({ sourcePath: SOURCE, accountId: GMAIL.id, mode: 'folder' });
});

it('a probe that fails, or an account with no cached folders, still imports into INBOX, never an empty folder', async () => {
  probe = () => Promise.reject(new Error('Failed to read mbox file: gone'));
  listings = {};
  const dialog = await openDialog();
  expect((await folderPicker(dialog, TARGET)).value).toBe('INBOX');
  expect(await confirm(dialog)).toEqual({
    sourcePath: SOURCE, accountId: GMAIL.id, mode: 'local', mailbox: 'INBOX', useLabels: false,
  });
});

it('a probe that answers nothing counts as a file without labels', async () => {
  probe = null;
  const dialog = await openDialog();
  expect((await folderPicker(dialog, TARGET)).value).toBe('INBOX');
});

it('cancel closes the dialog and imports nothing', async () => {
  const dialog = await openDialog();
  await folderPicker(dialog, FALLBACK);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(importCalls()).toHaveLength(0);
  expect(window.alert).not.toHaveBeenCalled();
});

// ── "Import and restore to the server" (mode 1, Task 11) ─────────────────
// The start answers at once with a job id; the daemon job then runs for hours
// and the corner chip (MboxUploadProgress) follows it. The dialog adds a size
// warning, and a choice when this file already has an upload that stopped.

const LONG_UPLOAD = 'can take many hours';
const longUploadNotice = (dialog) => within(dialog).queryByTestId('mbox-import-long-upload');
const GIB = 1024 ** 3;
const calls = (cmd) => sendMock.mock.calls.filter(([c]) => c === cmd).map(([, a]) => a);

it('warns that uploading a file over 1 GiB can take many hours, only for the upload to the server, with no number', async () => {
  probe = { ...LABELS, bytes: 2 * GIB };
  const dialog = await openDialog();
  await folderPicker(dialog, FALLBACK);
  // Filing into the vault is not an upload: nothing to warn about.
  expect(longUploadNotice(dialog)).toBeNull();

  fireEvent.click(modeButton(dialog, SERVER));
  const notice = longUploadNotice(dialog);
  expect(notice.textContent).toContain(LONG_UPLOAD);
  // D5: no invented duration or size.
  expect(notice.textContent).not.toMatch(/\d/);

  fireEvent.click(modeButton(dialog, FOLDER));
  expect(longUploadNotice(dialog)).toBeNull();
});

it('says nothing about hours for a file at the threshold, and warns one byte over it', async () => {
  probe = { ...LABELS, bytes: GIB };
  let dialog = await openDialog();
  await folderPicker(dialog, FALLBACK);
  fireEvent.click(modeButton(dialog, SERVER));
  expect(longUploadNotice(dialog)).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  cleanup();

  probe = { ...LABELS, bytes: GIB + 1 };
  dialog = await openDialog();
  await folderPicker(dialog, FALLBACK);
  fireEvent.click(modeButton(dialog, SERVER));
  expect(longUploadNotice(dialog).textContent).toContain(LONG_UPLOAD);
});

it('a Graph account keeps the upload disabled with its reason, and the size warning goes with it', async () => {
  probe = { ...LABELS, bytes: 5 * GIB };
  const dialog = await openDialog();
  await folderPicker(dialog, FALLBACK);
  fireEvent.click(modeButton(dialog, SERVER));
  expect(longUploadNotice(dialog)).not.toBeNull();

  fireEvent.change(within(dialog).getByRole('combobox', { name: 'Account' }), { target: { value: GRAPH.id } });
  await waitFor(() => expect(modeButton(dialog, SERVER).disabled).toBe(true));
  expect(within(dialog).getByText(GRAPH_REASON)).toBeTruthy();
  expect(modeButton(dialog, LOCAL).getAttribute('aria-pressed')).toBe('true');
  expect(longUploadNotice(dialog)).toBeNull();
});

it('starting the upload hands it to the progress chip: the dialog closes, and nothing is alerted, reloaded or shown as an import', async () => {
  importAnswer = () => Promise.resolve({ jobId: 'job-1', started: true });
  const { listen } = await import('@tauri-apps/api/event');
  listen.mockClear();
  const dialog = await openDialog();
  await folderPicker(dialog, FALLBACK);
  fireEvent.click(modeButton(dialog, SERVER));
  expect(await confirm(dialog)).toEqual({
    sourcePath: SOURCE, accountId: GMAIL.id, mode: 'server',
    mailbox: '[Gmail]/All Mail', fallbackMailbox: '[Gmail]/All Mail', useLabels: true,
  });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  // The vault-import bar and its listener are for modes 2 and 3.
  expect(useMailStore.getState().exportProgress).toBeNull();
  expect(listen).not.toHaveBeenCalledWith('mbox-import-progress', expect.anything());
  // Past the 1.5 s a finished vault import waits before its alert.
  await new Promise((r) => setTimeout(r, 1700));
  expect(window.alert).not.toHaveBeenCalled();
});

it('a second click on Import while the upload starts sends one start', async () => {
  let answer;
  importAnswer = () => new Promise((r) => { answer = r; });
  const dialog = await openDialog();
  await folderPicker(dialog, FALLBACK);
  fireEvent.click(modeButton(dialog, SERVER));
  await confirm(dialog);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
  expect(importCalls()).toHaveLength(1);
  answer({ jobId: 'job-1', started: true });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('a file whose upload stopped partway is offered to resume in the dialog, with the file just picked', async () => {
  importAnswer = () => Promise.reject(new Error('E_MBOX_UPLOAD_RESUMABLE: job-7'));
  const dialog = await openDialog();
  await folderPicker(dialog, FALLBACK);
  fireEvent.click(modeButton(dialog, SERVER));
  await confirm(dialog);

  const notice = await within(dialog).findByTestId('mbox-import-resumable');
  expect(notice.textContent).toContain('stopped partway');
  expect(window.alert).not.toHaveBeenCalled();

  fireEvent.click(within(dialog).getByRole('button', { name: 'Resume upload' }));
  // The fresh pick is what a sandboxed daemon may read now, so it goes along.
  await waitFor(() => expect(calls('mbox_upload_resume')).toEqual([{ jobId: 'job-7', sourcePath: SOURCE }]), { timeout: 5000 });
  expect(resolveServerAccount).toHaveBeenCalledWith(GMAIL.id, GMAIL);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(calls('mbox_upload_discard')).toEqual([]);
  expect(importCalls()).toHaveLength(1);
  expect(window.alert).not.toHaveBeenCalled();
});

it('... or discarded and started over with the same choices', async () => {
  let n = 0;
  importAnswer = () => ((n += 1) === 1
    ? Promise.reject(new Error('E_MBOX_UPLOAD_RESUMABLE: job-7'))
    : Promise.resolve({ jobId: 'job-8', started: true }));
  const dialog = await openDialog();
  await folderPicker(dialog, FALLBACK);
  fireEvent.click(modeButton(dialog, SERVER));
  await confirm(dialog);
  await within(dialog).findByTestId('mbox-import-resumable');

  fireEvent.click(within(dialog).getByRole('button', { name: 'Start over' }));
  await waitFor(() => expect(importCalls()).toHaveLength(2), { timeout: 5000 });
  const order = sendMock.mock.calls.map(([c]) => c).filter((c) => c === 'import_mbox' || c === 'mbox_upload_discard');
  expect(order).toEqual(['import_mbox', 'mbox_upload_discard', 'import_mbox']);
  expect(calls('mbox_upload_discard')).toEqual([{ jobId: 'job-7' }]);
  expect(importCalls()[1][1]).toEqual(importCalls()[0][1]);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(calls('mbox_upload_resume')).toEqual([]);
  expect(window.alert).not.toHaveBeenCalled();
});

it.each([
  ['E_MBOX_UPLOAD_RUNNING: 3f2a-11', 'errors.E_MBOX_UPLOAD_RUNNING'],
  ['E_MBOX_UPLOAD_SIGN_IN: keychain: no password stored for acct-gmail', 'errors.E_MBOX_UPLOAD_SIGN_IN'],
  ['E_MBOX_SERVER_GRAPH: an Outlook account takes no upload over IMAP', 'errors.E_MBOX_SERVER_GRAPH'],
  ['Failed to read mbox file: No such file or directory (os error 2)', 'settings.backup.restore.mboxImportFailed'],
])('a refused start (%s) shows the catalog words, never the daemon text', async (message, key) => {
  const en = (await import('../../../i18n/locales/en.json')).default;
  importAnswer = () => Promise.reject(new Error(message));
  const dialog = await openDialog();
  await folderPicker(dialog, FALLBACK);
  fireEvent.click(modeButton(dialog, SERVER));
  await confirm(dialog);

  await waitFor(() => expect(window.alert).toHaveBeenCalledTimes(1));
  expect(window.alert.mock.calls[0][0]).toBe(en[key]);
  expect(window.alert.mock.calls[0][0]).not.toContain(message.slice(message.indexOf(':') + 1).trim());
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('an import into the vault in progress ignores the progress of an upload to the server', async () => {
  const { listen } = await import('@tauri-apps/api/event');
  let handler = null;
  listen.mockImplementationOnce(async (event, cb) => { if (event === 'mbox-import-progress') handler = cb; return () => {}; });
  let answer;
  importAnswer = () => new Promise((r) => { answer = r; });
  const dialog = await openDialog();
  await folderPicker(dialog, FALLBACK);
  await confirm(dialog);
  await waitFor(() => expect(handler).toBeTypeOf('function'));

  handler({ payload: { total: 0, completed: 7, active: true, bytesDone: 70, bytesTotal: 100 } });
  expect(useMailStore.getState().exportProgress).toMatchObject({ completed: 7, bytesDone: 70, mode: 'import' });
  // An upload running for another account at the same time.
  handler({ payload: { mode: 'server', jobId: 'job-1', active: true, state: 'running', completed: 999, bytesDone: 1, bytesTotal: 5 } });
  expect(useMailStore.getState().exportProgress).toMatchObject({ completed: 7, bytesDone: 70, mode: 'import' });

  answer({ emailCount: 7, skippedCount: 0, accountId: GMAIL.id, mailbox: 'INBOX', folders: [], foldersKnown: true });
});

it('any other failure shows a catalog message, never the raw daemon text', async () => {
  importAnswer = () => Promise.reject(new Error('custody store unavailable: closed'));
  const dialog = await openDialog();
  await folderPicker(dialog, FALLBACK);
  await confirm(dialog);

  await waitFor(() => expect(window.alert).toHaveBeenCalled());
  const msg = window.alert.mock.calls.map((c) => c[0]).join('\n');
  expect(msg).toContain('The MBOX import did not finish.');
  expect(msg).not.toContain('custody');
});

it('the success message names the folders the mail went into', async () => {
  importAnswer = () => Promise.resolve({
    emailCount: 3, skippedCount: 1, accountId: GMAIL.id, mailbox: '[Gmail]/All Mail', foldersKnown: true,
    folders: [
      { mailbox: 'Work', imported: 1, skipped: 0 },
      { mailbox: '[Gmail]/All Mail', imported: 2, skipped: 1 },
      { mailbox: 'INBOX', imported: 0, skipped: 0 },
    ],
  });
  const dialog = await openDialog();
  await folderPicker(dialog, FALLBACK);
  await confirm(dialog);

  await waitFor(() => expect(window.alert).toHaveBeenCalled(), { timeout: 3000 });
  const msg = window.alert.mock.calls.map((c) => c[0]).join('\n');
  expect(msg).toContain('3 email(s) are now in your vault under me@gmail.test / Work, [Gmail]/All Mail.');
  expect(msg).toContain('1 email(s) were already in this folder and were skipped.');
});

// Mode 3 files the mail into a new folder kept on this computer. The message
// names that folder by its display name (not a key), and the app opens it at
// once: a reload would land on the first account's INBOX instead.
it('a separate-folder import names the new folder and opens it', async () => {
  const NAME = 'MBOX import 2026-09-29';
  const original = useMailStore.getState().activateAccount;
  const activateAccount = vi.fn(async () => {});
  useMailStore.setState({ activateAccount });
  try {
    importAnswer = () => Promise.resolve({
      emailCount: 2, skippedCount: 0, accountId: GMAIL.id, mailbox: NAME, foldersKnown: false,
      folders: [{ mailbox: NAME, imported: 2, skipped: 0 }],
      folder: { name: NAME, dir: 'MBOX_import_2026-09-29' },
    });
    const dialog = await openDialog();
    await folderPicker(dialog, FALLBACK);
    fireEvent.click(modeButton(dialog, FOLDER));
    await confirm(dialog);

    await waitFor(() => expect(activateAccount).toHaveBeenCalledWith(GMAIL.id, NAME));
    await waitFor(() => expect(window.alert).toHaveBeenCalled(), { timeout: 3000 });
    const msg = window.alert.mock.calls.map((c) => c[0]).join('\n');
    expect(msg).toContain(`2 email(s) are now in ${NAME}`);
    expect(msg).toContain('On this computer');
    expect(msg).not.toContain('MBOX_import');
    expect(msg).not.toContain('reloads');
  } finally {
    useMailStore.setState({ activateAccount: original });
  }
});
