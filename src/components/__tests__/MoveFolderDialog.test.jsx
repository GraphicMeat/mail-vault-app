// @vitest-environment jsdom
/**
 * Move folder's dialog: pick an account (the folder's own preselected) and a
 * folder in it, which becomes the moved folder's parent, or the top level.
 * Every pick asks the daemon for the plan from its cached folder lists
 * (`folder_move.plan`); Confirm starts the job (`folder_move.start`) and
 * closes at once: progress is the corner chip's, never this dialog's. Another
 * account is a Premium destination; the folder's own account is free.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('framer-motion', () => {
  const div = React.forwardRef(({ children, initial, animate, exit, transition, ...props }, ref) =>
    React.createElement('div', { ...props, ref }, children));
  return { motion: { div }, AnimatePresence: ({ children }) => children };
});
// `db/keychain.js` reads the app data dir as a module side effect.
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: () => Promise.reject(new Error('ENOENT')),
  writeTextFile: () => Promise.resolve(),
  exists: () => Promise.resolve(false),
  mkdir: () => Promise.resolve(),
  remove: () => Promise.resolve(),
}));

const h = vi.hoisted(() => ({ replies: {}, cached: {}, live: vi.fn() }));
const sendMock = vi.fn((cmd, params) => {
  const reply = h.replies[cmd];
  return typeof reply === 'function' ? reply(params) : Promise.resolve(reply ?? null);
});
vi.mock('../../services/transport', async (importOriginal) => ({ ...(await importOriginal()), send: (...a) => sendMock(...a) }));
vi.mock('../../services/db', async (importOriginal) => ({
  ...(await importOriginal()),
  getCachedMailboxes: async (id) => h.cached[id] ?? null,
}));
vi.mock('../../services/workflows/activateAccount', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchAccountMailboxes: (...a) => h.live(...a),
}));

const { MoveFolderDialog } = await import('../MoveFolderDialog');
const { useMailStore } = await import('../../stores/mailStore');
await import('../../services/workflows/bindStoreActions');
const { useSettingsStore } = await import('../../stores/settingsStore');
const en = (await import('../../i18n/locales/en.json')).default;

const box = (path, extra = {}) => ({ path, name: path.split('/').pop(), delimiter: '/', flags: [], children: [], ...extra });
const MINE = [
  box('INBOX', { specialUse: '\\Inbox' }), box('Archive', { specialUse: '\\Archive' }), box('Trash', { specialUse: '\\Trash' }),
  box('Clients'), box('Clients/2025'), box('Clients/2025/Q1'), box('Clients 2'), box('Projects'),
];
const THEIRS = [box('INBOX', { specialUse: '\\Inbox' }), box('Archive', { specialUse: '\\Archive' }), box('Old mail')];
const ACCOUNTS = [
  { id: 'src', name: 'Studio', email: 'me@studio.test' },
  { id: 'dst', name: 'Gmail', email: 'me@gmail.test' },
  { id: 'ol', name: 'Outlook', email: 'me@outlook.test', authType: 'oauth2', oauth2Transport: 'graph' },
];
const NODE = { path: 'Clients', name: 'Clients' };
const PLAN = {
  items: [{ src: 'Clients', dest: 'Archive/Clients', container: false }, { src: 'Clients/2025', dest: 'Archive/Clients/2025', container: false }, { src: 'Clients/2025/Q1', dest: 'Archive/Clients/2025/Q1', container: false }],
  fastRename: null, refusal: null, cached: true,
};
const PREMIUM = { hasSubscription: true, premiumAccess: true, status: 'active' };

const calls = (cmd) => sendMock.mock.calls.filter(([c]) => c === cmd).map(([, a]) => a);
const dialog = () => screen.getByRole('dialog');
const accountSelect = () => screen.getByLabelText(en['folderMove.account']);
const row = (path) => document.querySelector(`[data-testid="move-folder-target"][data-path="${path}"]`);
const rows = () => [...document.querySelectorAll('[data-testid="move-folder-target"]')].map((r) => r.getAttribute('data-path'));
const confirm = () => screen.getByRole('button', { name: en['folderMove.confirm'] });
const words = (key, vars = {}) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{{${k}}}`, v), en[key]);

function draw(props = {}) {
  const onClose = vi.fn();
  const onUpgrade = vi.fn();
  render(<MoveFolderDialog node={NODE} accountId="src" mailboxes={MINE} onClose={onClose} onUpgrade={onUpgrade} {...props} />);
  return { onClose, onUpgrade };
}
async function pick(path) {
  fireEvent.click(row(path));
  await waitFor(() => expect(calls('folder_move.plan').length).toBeGreaterThan(0));
}
const chooseAccount = (id) => act(async () => { fireEvent.change(accountSelect(), { target: { value: id } }); });

beforeEach(() => {
  sendMock.mockClear();
  h.replies = { 'folder_move.plan': PLAN, 'folder_move.start': { jobId: 'job-1' } };
  h.cached = {};
  h.live.mockReset();
  useMailStore.setState({ accounts: ACCOUNTS, activeAccountId: 'src' });
  useSettingsStore.setState({ billingProfile: PREMIUM, accountColors: {} });
});
afterEach(cleanup);

describe('MoveFolderDialog', () => {
  it('opens on the folder\'s own account, its folders below, Top level first and named after the folder', () => {
    draw();
    expect(dialog().textContent).toContain(words('folderMove.title', { name: 'Clients' }));
    expect(accountSelect().value).toBe('src');
    // The sidebar's order: INBOX first, then by name, each folder before its own.
    expect(rows()).toEqual(['', 'INBOX', 'Archive', 'Clients', 'Clients/2025', 'Clients/2025/Q1', 'Clients 2', 'Projects', 'Trash']);
    expect(row('').textContent).toContain(words('folderMove.topLevel', { name: 'Clients' }));
    // Nothing picked yet: nothing to confirm, nothing asked.
    expect(confirm().disabled).toBe(true);
    expect(calls('folder_move.plan')).toEqual([]);
  });

  it('cannot move a folder into itself or a folder inside it, but a name that only starts the same is fine', () => {
    draw();
    for (const p of ['Clients', 'Clients/2025', 'Clients/2025/Q1']) expect(row(p).disabled, p).toBe(true);
    for (const p of ['', 'INBOX', 'Archive', 'Clients 2', 'Projects']) expect(row(p).disabled, p).toBe(false);
  });

  it('a pick asks for the plan and says what will move, then Confirm starts the job and closes', async () => {
    const { onClose } = draw();
    await pick('Archive');
    expect(calls('folder_move.plan')).toEqual([{ sourceAccountId: 'src', sourcePath: 'Clients', destAccountId: 'src', destPath: 'Archive' }]);
    await waitFor(() => expect(dialog().textContent).toContain(words('folderMove.planCount_other', { count: '3' })));
    expect(row('Archive').getAttribute('aria-checked')).toBe('true');
    // A copy, then the original to Trash: both said before the click.
    expect(dialog().textContent).toContain(en['folderMove.vaultNote']);
    expect(dialog().textContent).toContain(en['folderMove.retireNote']);

    expect(confirm().disabled).toBe(false);
    fireEvent.click(confirm());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls('folder_move.start')).toEqual([{ sourceAccountId: 'src', sourcePath: 'Clients', destAccountId: 'src', destPath: 'Archive' }]);
  });

  it('Top level sends no destination path, and a rename in place says nothing is copied', async () => {
    h.replies['folder_move.plan'] = { items: [{ src: 'Clients', dest: 'Clients', container: false }], fastRename: 'Clients', refusal: null, cached: true };
    const { onClose } = draw({ node: { path: 'Projects/Clients', name: 'Clients' } });
    await pick('');
    expect(calls('folder_move.plan')).toEqual([{ sourceAccountId: 'src', sourcePath: 'Projects/Clients', destAccountId: 'src', destPath: null }]);
    await waitFor(() => expect(dialog().textContent).toContain(en['folderMove.fastRename']));
    expect(dialog().textContent).not.toContain(en['folderMove.retireNote']);
    fireEvent.click(confirm());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls('folder_move.start')[0].destPath).toBe(null);
  });

  it('a refusal is said in catalog words and keeps Confirm off', async () => {
    h.replies['folder_move.plan'] = { items: [], fastRename: null, refusal: 'E_FOLDER_MOVE_NO_HIERARCHY', cached: true };
    draw();
    await pick('Projects');
    await waitFor(() => expect(dialog().textContent).toContain(en['errors.E_FOLDER_MOVE_NO_HIERARCHY']));
    expect(dialog().textContent).not.toMatch(/E_FOLDER_MOVE/);
    expect(confirm().disabled).toBe(true);
  });

  // The daemon's start skips this refusal too: the job lists both accounts live.
  it('a folder the daemon\'s cached list does not hold yet is no refusal', async () => {
    h.replies['folder_move.plan'] = { items: [], fastRename: null, refusal: 'E_FOLDER_MOVE_NOT_FOUND', cached: true };
    draw();
    await pick('Projects');
    await waitFor(() => expect(dialog().textContent).toContain(en['folderMove.planUnknown']));
    expect(dialog().textContent).not.toContain(en['errors.E_FOLDER_MOVE_NOT_FOUND']);
    expect(confirm().disabled).toBe(false);
  });

  it('an answer for an earlier pick never overrides the latest one', async () => {
    let refuse;
    h.replies['folder_move.plan'] = (p) => (p.destPath === 'Projects'
      ? new Promise((resolve) => { refuse = () => resolve({ items: [], fastRename: null, refusal: 'E_FOLDER_MOVE_NAME', cached: true }); })
      : Promise.resolve(PLAN));
    draw();
    await pick('Projects');
    fireEvent.click(row('Archive'));
    await waitFor(() => expect(confirm().disabled).toBe(false));
    await act(async () => { refuse(); });
    expect(confirm().disabled).toBe(false);
    expect(dialog().textContent).not.toContain(en['errors.E_FOLDER_MOVE_NAME']);
  });

  it('with no cached folder list the count waits for the job, and Confirm stays on', async () => {
    h.replies['folder_move.plan'] = { items: [], fastRename: null, refusal: null, cached: false };
    draw();
    await pick('Archive');
    await waitFor(() => expect(dialog().textContent).toContain(en['folderMove.planUnknown']));
    expect(dialog().textContent).toContain(en['folderMove.retireNote']);
    expect(confirm().disabled).toBe(false);
  });

  it('another account shows its cached folders, nothing disabled, and the move goes there', async () => {
    h.cached.dst = THEIRS;
    const { onClose } = draw();
    await chooseAccount('dst');
    await waitFor(() => expect(rows()).toEqual(['', 'INBOX', 'Archive', 'Old mail']));
    expect(h.live).not.toHaveBeenCalled();
    expect(rows().every((p) => !row(p).disabled)).toBe(true);
    await pick('Archive');
    expect(calls('folder_move.plan').at(-1)).toEqual({ sourceAccountId: 'src', sourcePath: 'Clients', destAccountId: 'dst', destPath: 'Archive' });
    await waitFor(() => expect(confirm().disabled).toBe(false));
    fireEvent.click(confirm());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls('folder_move.start')[0]).toMatchObject({ destAccountId: 'dst', destPath: 'Archive' });
  });

  it('an account with no cached folders is listed live, with a spinner meanwhile', async () => {
    let listed;
    h.live.mockImplementation(() => new Promise((resolve) => { listed = resolve; }));
    draw();
    await chooseAccount('dst');
    await waitFor(() => expect(h.live).toHaveBeenCalledWith(expect.objectContaining({ id: 'dst' })));
    expect(dialog().textContent).toContain(en['folderMove.loadingFolders']);
    await act(async () => { listed(THEIRS); });
    expect(rows()).toEqual(['', 'INBOX', 'Archive', 'Old mail']);
    expect(dialog().textContent).not.toContain(en['folderMove.loadingFolders']);
  });

  it('a live listing that fails says so in catalog words', async () => {
    h.live.mockRejectedValue(new Error('IMAP LIST failed: connection reset'));
    draw();
    await chooseAccount('dst');
    await waitFor(() => expect(dialog().textContent).toContain(en['folderMove.foldersFailed']));
    expect(dialog().textContent).not.toMatch(/connection reset/);
  });

  it('an Outlook folder goes by its Graph folder id, on both sides', async () => {
    h.cached.ol = [box('Inbox', { specialUse: '\\Inbox', _graphFolderId: 'g-inbox' }), box('Projects', { _graphFolderId: 'g-proj' })];
    const { onClose } = draw({ node: { path: 'Clients', name: 'Clients', _graphFolderId: 'g-src' } });
    await chooseAccount('ol');
    await waitFor(() => expect(row('Projects')).toBeTruthy());
    await pick('Projects');
    await waitFor(() => expect(confirm().disabled).toBe(false));
    fireEvent.click(confirm());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls('folder_move.start')).toEqual([{
      sourceAccountId: 'src', sourcePath: 'Clients', sourceFolderId: 'g-src', destAccountId: 'ol', destPath: 'Projects', destFolderId: 'g-proj',
    }]);
  });

  it('without Premium another account is locked behind the upsell; the folder\'s own account stays free', async () => {
    useSettingsStore.setState({ billingProfile: null });
    h.cached.dst = THEIRS;
    const { onUpgrade, onClose } = draw();
    // Its own account: free.
    expect(rows().length).toBeGreaterThan(1);
    // Another: named as Premium in the list, and no folders to pick there.
    const option = [...accountSelect().options].find((o) => o.value === 'dst');
    expect(option.textContent).toBe(words('folderMove.accountLocked', { email: 'me@gmail.test' }));
    await chooseAccount('dst');
    expect(dialog().textContent).toContain(en['folderMove.premiumUpsell']);
    expect(rows()).toEqual([]);
    expect(confirm().disabled).toBe(true);
    expect(h.live).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: en['common.upgrade'] }));
    expect(onUpgrade).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(calls('folder_move.plan')).toEqual([]);
  });

  it('a start the daemon refuses stays open and says why in catalog words', async () => {
    h.replies['folder_move.start'] = () => Promise.reject(new Error('E_FOLDER_MOVE_RUNNING: job-0'));
    const { onClose } = draw();
    await pick('Archive');
    await waitFor(() => expect(confirm().disabled).toBe(false));
    fireEvent.click(confirm());
    await waitFor(() => expect(dialog().textContent).toContain(en['errors.E_FOLDER_MOVE_RUNNING']));
    expect(dialog().textContent).not.toContain('job-0');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a filter narrows the folders, Top level always stays', () => {
    draw();
    fireEvent.change(screen.getByLabelText(en['moveTo.searchFolders']), { target: { value: 'proj' } });
    expect(rows()).toEqual(['', 'Projects']);
  });
});
