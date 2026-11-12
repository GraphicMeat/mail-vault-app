// @vitest-environment jsdom
/**
 * The corner chip of Move folder. The daemon job reports by
 * `folder-move-progress`; the chip renders what it says (counts, the phase,
 * where the original went or why it was kept), offers Pause / Resume /
 * Cancel / Discard, and is never a modal. It follows MboxUploadProgress: its
 * own state, fed by events, a burst of counts rendered at most once per
 * interval.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('framer-motion', () => {
  const div = React.forwardRef(({ children, initial, animate, exit, transition, ...props }, ref) =>
    React.createElement('div', { ...props, ref }, children));
  return { motion: { div }, AnimatePresence: ({ children }) => children };
});
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: () => Promise.reject(new Error('ENOENT')),
  writeTextFile: () => Promise.resolve(),
  exists: () => Promise.resolve(false),
  mkdir: () => Promise.resolve(),
  remove: () => Promise.resolve(),
}));

const listeners = {};
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event, cb) => {
    (listeners[event] ||= new Set()).add(cb);
    return () => listeners[event].delete(cb);
  }),
}));

let statusReply;
let controlReply;
const sendMock = vi.fn((cmd) => {
  if (cmd === 'folder_move.status') return typeof statusReply === 'function' ? statusReply() : Promise.resolve(statusReply);
  if (cmd.startsWith('folder_move.')) return controlReply(cmd);
  return Promise.resolve(null);
});
vi.mock('../../services/transport', () => ({ send: (...a) => sendMock(...a) }));

const { FolderMoveProgress, RENDER_EVERY_MS } = await import('../FolderMoveProgress');
const { useMailStore } = await import('../../stores/mailStore');
await import('../../services/workflows/bindStoreActions');
const en = (await import('../../i18n/locales/en.json')).default;
const originalRefresh = useMailStore.getState().refreshCurrentView;

const JOB = 'job-1';
const ANSWER = { 'folder_move.pause': 'paused', 'folder_move.resume': 'resumed', 'folder_move.cancel': 'cancelled', 'folder_move.discard': 'discarded' };
const ev = (o = {}) => ({
  jobId: JOB, sourceAccountId: 'src', destAccountId: 'dst', sourcePath: 'Clients', destPath: 'Archive',
  state: 'running', active: true, total: 10, copied: 0, skipped: 0, failed: 0, currentFolder: 'Clients', folders: [],
  retired: false, retiredTo: null, sourceKeptReason: null, rateLimitedFor: null, error: null, foldersCreated: 0,
  ...o,
});
const journal = (o = {}) => ev({ active: false, live: false, state: 'stopped', updatedAt: 1, ...o });
const words = (key, vars = {}) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{{${k}}}`, v), en[key]);

const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
const fire = (payload) => act(() => { for (const cb of listeners['folder-move-progress'] || []) cb({ payload }); });
const reconnect = () => act(async () => { for (const cb of listeners['daemon-reconnected'] || []) cb({ payload: null }); await flush(); });
const tick = () => act(async () => { vi.advanceTimersByTime(RENDER_EVERY_MS); });
const calls = (cmd) => sendMock.mock.calls.filter(([c]) => c === cmd).map(([, a]) => a);

const chip = () => screen.queryByTestId('folder-move-chip');
const job = (id = JOB) => document.querySelector(`[data-testid="folder-move-job"][data-job-id="${id}"]`);
const face = (id) => job(id)?.getAttribute('data-state') ?? null;
const button = (name, id = JOB) => job(id)?.querySelector(`[data-testid="folder-move-${name}"]`) ?? null;
const buttons = (id = JOB) => [...(job(id)?.querySelectorAll('button[data-testid^="folder-move-"]') || [])]
  .map((b) => b.getAttribute('data-testid').replace('folder-move-', '')).sort();

const ready = () => act(async () => {
  await vi.waitFor(() => {
    expect(listeners['folder-move-progress']?.size).toBe(1);
    expect(listeners['daemon-reconnected']?.size ?? 0).toBeGreaterThanOrEqual(1);
    expect(calls('folder_move.status').length).toBeGreaterThanOrEqual(1);
  }, { timeout: 15_000, interval: 20 });
  await flush();
});
async function mount() {
  render(<FolderMoveProgress />);
  await ready();
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  statusReply = { jobs: [] };
  controlReply = (cmd) => Promise.resolve({ jobId: JOB, [ANSWER[cmd]]: true });
  sendMock.mockClear();
  useMailStore.setState({ activeAccountId: 'another-account', unifiedInbox: false });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  for (const k of Object.keys(listeners)) delete listeners[k];
  useMailStore.setState({ refreshCurrentView: originalRefresh });
});

describe('FolderMoveProgress', () => {
  it('shows nothing while no move is known, and asks the daemon for its jobs on start', async () => {
    await mount();
    expect(calls('folder_move.status')).toEqual([{}]);
    expect(chip()).toBeNull();
  });

  it('a running move shows its counts and a bar, with Pause and Cancel', async () => {
    await mount();
    fire(ev({ copied: 3, skipped: 1, failed: 1 }));
    expect(face()).toBe('running');
    expect(job().textContent).toContain(words('folderMove.titleRunning', { name: 'Clients' }));
    expect(job().textContent).toContain(words('folderMove.counts', { copied: '3', skipped: '1', failed: '1' }));
    expect(job().querySelector('[role="progressbar"]').getAttribute('aria-valuenow')).toBe('50');
    expect(buttons()).toEqual(['cancel', 'pause']);
  });

  // Checking holds nothing a pause could hold, but a cancel still keeps the
  // original until the rename; once the original is being moved, neither
  // does anything.
  it('names the phase the daemon is in, and offers only what still works in it', async () => {
    await mount();
    fire(ev({ state: 'verifying' }));
    expect(job().textContent).toContain(words('folderMove.titleVerifying', { name: 'Clients' }));
    expect(buttons()).toEqual(['cancel']);
    fire(ev({ state: 'retiring' }));
    expect(job().textContent).toContain(words('folderMove.titleRetiring', { name: 'Clients' }));
    expect(buttons()).toEqual([]);
  });

  it('renders a burst of counts at most once per interval, and a change of state at once', async () => {
    await mount();
    fire(ev({ copied: 0 }));
    for (let i = 1; i <= 20; i += 1) fire(ev({ copied: i }));
    expect(job().textContent).toContain(words('folderMove.counts', { copied: '0', skipped: '0', failed: '0' }));
    await tick();
    expect(job().textContent).toContain(words('folderMove.counts', { copied: '20', skipped: '0', failed: '0' }));
    fire(ev({ copied: 21 }));
    fire(ev({ state: 'paused', copied: 21 }));
    expect(face()).toBe('paused');
    expect(job().textContent).toContain(words('folderMove.counts', { copied: '21', skipped: '0', failed: '0' }));
  });

  it('a server limiting the move says so', async () => {
    await mount();
    fire(ev({ rateLimitedFor: 30 }));
    expect(job().textContent).toContain(en['folderMove.rateLimited']);
  });

  it('a paused move offers Resume and Cancel, and each calls the daemon for this job', async () => {
    await mount();
    fire(ev());
    fireEvent.click(button('pause'));
    await act(flush);
    expect(calls('folder_move.pause')).toEqual([{ jobId: JOB }]);
    // The chip moves on the daemon's event, not on the button.
    expect(face()).toBe('running');
    fire(ev({ state: 'paused' }));
    expect(face()).toBe('paused');
    expect(job().textContent).toContain(words('folderMove.titlePaused', { name: 'Clients' }));
    expect(buttons()).toEqual(['cancel', 'resume']);
    fireEvent.click(button('resume'));
    await act(flush);
    expect(calls('folder_move.resume')).toEqual([{ jobId: JOB }]);
    fireEvent.click(button('cancel'));
    await act(flush);
    expect(calls('folder_move.cancel')).toEqual([{ jobId: JOB }]);
  });

  it('after a restart a move the daemon kept a journal of shows as stopped, with Resume and Discard', async () => {
    statusReply = { jobs: [journal({ copied: 4 })] };
    await mount();
    expect(face()).toBe('stopped');
    expect(job().textContent).toContain(words('folderMove.titleStopped', { name: 'Clients' }));
    expect(job().textContent).toContain(en['folderMove.stoppedHint']);
    expect(buttons()).toEqual(['discard', 'resume']);
    fireEvent.click(button('discard'));
    await act(flush);
    expect(calls('folder_move.discard')).toEqual([{ jobId: JOB }]);
    // A journal with no worker: the chip lets it go on the answer.
    expect(chip()).toBeNull();
  });

  it('a finished move says where the original went, and offers only Dismiss', async () => {
    await mount();
    fire(ev({ active: false, state: 'done', copied: 10, retired: true, retiredTo: 'Trash/Clients', foldersCreated: 2 }));
    expect(face()).toBe('done');
    expect(job().textContent).toContain(words('folderMove.titleDone', { name: 'Clients' }));
    expect(job().textContent).toContain(words('folderMove.retiredTo', { path: 'Trash/Clients' }));
    expect(buttons()).toEqual(['dismiss']);
    fireEvent.click(button('dismiss'));
    expect(chip()).toBeNull();
  });

  // A same-account move with a free destination is one server rename: done,
  // nothing retired, and nothing kept either.
  it('a rename in place reads as moved, never as an original kept', async () => {
    await mount();
    fire(ev({ active: false, state: 'done', destAccountId: 'src', destPath: null, total: 0, retired: false, retiredTo: null }));
    expect(face()).toBe('done');
    expect(job().textContent).toContain(words('folderMove.titleDone', { name: 'Clients' }));
    expect(job().textContent).not.toContain(words('folderMove.titleKept', { name: 'Clients' }));
    expect(job().textContent).not.toMatch(/kept|Trash|copied/);
  });

  it.each([
    ['unverified', 'folderMove.keptUnverified'],
    ['failed', 'folderMove.keptFailed'],
    ['no_trash', 'folderMove.keptNoTrash'],
    ['rename_failed', 'folderMove.keptRenameFailed'],
  ])('a move that kept the original (%s) says why, and can be resumed or discarded', async (reason, key) => {
    await mount();
    fire(ev({ active: false, state: 'partial', copied: 9, failed: 1, sourceKeptReason: reason }));
    expect(face()).toBe('stopped');
    expect(job().textContent).toContain(words('folderMove.titleKept', { name: 'Clients' }));
    expect(job().textContent).toContain(en[key]);
    expect(buttons()).toEqual(['discard', 'resume']);
  });

  it('a cancelled move keeps its journal: Resume and Discard', async () => {
    await mount();
    fire(ev({ active: false, state: 'cancelled', sourceKeptReason: 'cancelled' }));
    expect(face()).toBe('stopped');
    expect(job().textContent).toContain(words('folderMove.titleCancelled', { name: 'Clients' }));
    expect(buttons()).toEqual(['discard', 'resume']);
  });

  it('a failed move shows the code in catalog words, never the daemon\'s text', async () => {
    await mount();
    fire(ev({ active: false, state: 'failed', sourceKeptReason: 'failed', error: 'E_FOLDER_MOVE_SIGN_IN' }));
    expect(job().textContent).toContain(words('folderMove.titleFailed', { name: 'Clients' }));
    expect(job().textContent).toContain(en['errors.E_FOLDER_MOVE_SIGN_IN']);
    // The error says why; no second reason beside it.
    expect(job().textContent).not.toContain(en['folderMove.keptFailed']);
    fire(ev({ active: false, state: 'failed', sourceKeptReason: 'failed', error: 'IMAP LIST failed: connection reset' }));
    expect(job().textContent).toContain(en['folderMove.failed']);
    expect(job().textContent).not.toMatch(/connection reset|E_FOLDER/);
  });

  it('says when the vault copies did not all follow the original', async () => {
    await mount();
    fire(ev({ active: false, state: 'done', retired: true, retiredTo: 'Trash/Clients', vaultRenameIncomplete: true }));
    expect(job().textContent).toContain(en['folderMove.vaultIncomplete']);
  });

  it('a discarded move leaves the chip', async () => {
    await mount();
    fire(ev());
    fire(ev({ active: false, state: 'discarded' }));
    expect(chip()).toBeNull();
  });

  it('asks again when the daemon restarts: a move cut off by it now reads as stopped', async () => {
    await mount();
    fire(ev({ copied: 2 }));
    statusReply = { jobs: [journal({ copied: 2 })] };
    await reconnect();
    expect(calls('folder_move.status')).toHaveLength(2);
    expect(face()).toBe('stopped');
  });

  it('a job the daemon no longer knows leaves the chip; another refusal shows catalog words in the row', async () => {
    await mount();
    fire(ev());
    controlReply = () => Promise.reject(new Error('custody store unavailable: closed'));
    fireEvent.click(button('pause'));
    await act(flush);
    expect(job().textContent).toContain(en['folderMove.failed']);
    expect(job().textContent).not.toContain('custody');
    controlReply = () => Promise.reject(new Error(`E_FOLDER_MOVE_NOT_FOUND: ${JOB}`));
    fireEvent.click(button('cancel'));
    await act(flush);
    expect(chip()).toBeNull();
  });

  it('a control the daemon answers false for asks for the jobs again', async () => {
    await mount();
    fire(ev());
    controlReply = (cmd) => Promise.resolve({ jobId: JOB, [ANSWER[cmd]]: false });
    statusReply = { jobs: [journal({ state: 'cancelled', copied: 2 })] };
    fireEvent.click(button('pause'));
    await act(() => vi.waitFor(() => expect(calls('folder_move.status')).toHaveLength(2), { timeout: 10_000 }));
    await act(flush);
    expect(face()).toBe('stopped');
  });

  it('never opens a modal and never takes focus', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    try {
      await mount();
      for (const p of [ev(), ev({ state: 'paused' }), ev({ active: false, state: 'partial', sourceKeptReason: 'failed' }), ev({ active: false, state: 'done' })]) {
        fire(p);
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.activeElement).toBe(input);
      }
    } finally {
      input.remove();
    }
  });

  it('a finished move reloads the account on screen once', async () => {
    const refreshCurrentView = vi.fn(async () => {});
    useMailStore.setState({ activeAccountId: 'dst', activeMailbox: 'INBOX', unifiedInbox: false, refreshCurrentView });
    await mount();
    fire(ev({ active: false, state: 'done', copied: 10, retired: true, retiredTo: 'Trash/Clients' }));
    await vi.waitFor(() => expect(refreshCurrentView).toHaveBeenCalled(), { timeout: 10_000 });
    await act(async () => { vi.advanceTimersByTime(RENDER_EVERY_MS * 3); });
    expect(refreshCurrentView).toHaveBeenCalledTimes(1);
  });
});
