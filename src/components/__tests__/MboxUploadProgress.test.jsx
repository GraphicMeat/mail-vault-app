// @vitest-environment jsdom
/**
 * The corner chip of "Import and restore to the server" (MBOX import mode 1).
 * The daemon job runs for hours and reports by `mbox-import-progress`; the
 * chip renders what it says (counts, bytes, the daemon's own ETA, throttling,
 * a refused sign-in), offers Pause / Resume / Cancel / Discard, and is never a
 * modal. It follows the indexing chip (b9c323dac): its own state, fed by
 * events, so a progress event re-renders the chip and never the message list.
 */
import React, { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('framer-motion', () => {
  const div = React.forwardRef(({ children, initial, animate, exit, transition, ...props }, ref) =>
    React.createElement('div', { ...props, ref }, children));
  return { motion: { div }, AnimatePresence: ({ children }) => children };
});
// `db/keychain.js` reads the app data dir as a module side effect the moment
// the `db` barrel loads (the mail store pulls it in).
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
  if (cmd === 'mbox_upload_status') return typeof statusReply === 'function' ? statusReply() : Promise.resolve(statusReply);
  if (cmd.startsWith('mbox_upload_')) return controlReply(cmd);
  return Promise.resolve(null);
});
vi.mock('../../services/transport', () => ({ send: (...a) => sendMock(...a) }));

const openMock = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: (...a) => openMock(...a), save: vi.fn() }));

const refreshMock = vi.fn();
vi.mock('../../services/authUtils', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureFreshToken: (...a) => refreshMock(...a),
}));

const { MboxUploadProgress, RENDER_EVERY_MS } = await import('../MboxUploadProgress');
const { useMailStore } = await import('../../stores/mailStore');
const { takeForcedMailboxRefetch } = await import('../../services/workflows/helpers/mailboxRefetch');
const en = (await import('../../i18n/locales/en.json')).default;

const JOB = 'job-1';
const ACCT = 'acct-a';
const originalRefresh = useMailStore.getState().refreshCurrentView;
const ev = (o = {}) => ({
  mode: 'server', jobId: JOB, accountId: ACCT, fileName: 'Takeout.mbox',
  active: true, state: 'running', total: 0, completed: 0,
  bytesDone: 0, bytesTotal: 1000, uploadedCount: 0, skippedCount: 0, failedCount: 0,
  paused: false, throttled: false, needsSignIn: false, etaSeconds: null,
  ...o,
});
const journal = (o = {}) => ev({ active: false, live: false, state: 'paused', paused: true, updatedAt: 1, ...o });

const fire = (payload) => act(() => { for (const cb of listeners['mbox-import-progress'] || []) cb({ payload }); });
const reconnect = () => act(async () => { for (const cb of listeners['daemon-reconnected'] || []) cb({ payload: null }); await flush(); });
const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
// Counts that change within one state are held for at most this long.
const tick = () => act(async () => { vi.advanceTimersByTime(RENDER_EVERY_MS); });
// A resume first looks the account up (loaded on demand): wait for its call.
const settled = (cmd, expected) => act(() => vi.waitFor(() => expect(calls(cmd)).toEqual(expected), { timeout: 10_000 }));

const chip = () => screen.queryByTestId('mbox-upload-chip');
const job = (id = JOB) => document.querySelector(`[data-testid="mbox-upload-job"][data-job-id="${id}"]`);
const face = (id) => job(id)?.getAttribute('data-state') ?? null;
const button = (name, id = JOB) => job(id)?.querySelector(`[data-testid="mbox-upload-${name}"]`) ?? null;
const buttons = (id = JOB) => [...(job(id)?.querySelectorAll('[data-testid^="mbox-upload-"]') || [])]
  .map((b) => b.getAttribute('data-testid').replace('mbox-upload-', ''))
  .filter((n) => n !== 'job')
  .sort();
const calls = (cmd) => sendMock.mock.calls.filter(([c]) => c === cmd).map(([, a]) => a);

// The service loads the event API on demand: wait until both listeners are on
// and the status reply has landed, not for a fixed number of ticks.
const ready = () => act(async () => {
  await vi.waitFor(() => {
    expect(listeners['mbox-import-progress']?.size).toBe(1);
    // Other stores may listen for a restarted daemon too.
    expect(listeners['daemon-reconnected']?.size).toBeGreaterThanOrEqual(1);
  }, { timeout: 10_000 });
  await flush();
});

async function mount(props = {}) {
  const utils = render(<MboxUploadProgress {...props} />);
  await ready();
  return utils;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  statusReply = { jobs: [] };
  controlReply = (cmd) => Promise.resolve({ jobId: JOB, [cmd.replace('mbox_upload_', '')]: true });
  sendMock.mockClear();
  openMock.mockReset();
  refreshMock.mockReset().mockImplementation(async (a) => a);
  useMailStore.setState({ activeAccountId: 'another-account', unifiedInbox: false });
  takeForcedMailboxRefetch(ACCT);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  for (const k of Object.keys(listeners)) delete listeners[k];
  useMailStore.setState({ refreshCurrentView: originalRefresh });
});

describe('MboxUploadProgress', () => {
  it('shows nothing while no upload is known, and asks the daemon for its jobs on start', async () => {
    await mount();
    expect(calls('mbox_upload_status')).toEqual([{}]);
    expect(chip()).toBeNull();
  });

  it('a running upload shows its counts, a bar on the bytes read, Pause and Cancel, and no ETA until the daemon sends one', async () => {
    await mount();
    fire(ev({ uploadedCount: 12, skippedCount: 3, failedCount: 1, bytesDone: 250 }));
    expect(face()).toBe('running');
    expect(job().textContent).toContain('Uploading Takeout.mbox to the server');
    expect(job().textContent).toContain('12 uploaded, 3 skipped, 1 failed');
    expect(job().querySelector('[role="progressbar"]').getAttribute('aria-valuenow')).toBe('25');
    // The app never estimates on its own: no daemon ETA, no "left".
    expect(job().textContent).not.toMatch(/left/);
    expect(buttons()).toEqual(['cancel', 'pause']);

    fire(ev({ uploadedCount: 13, bytesDone: 260, etaSeconds: 3 * 3600 + 20 * 60 + 9 }));
    await tick();
    expect(job().textContent).toContain('About 3 h 20 min left');
    expect(job().textContent).toContain('13 uploaded');
  });

  it('writes the daemon\'s ETA in minutes, or as under a minute', async () => {
    await mount();
    fire(ev({ etaSeconds: 90 }));
    expect(job().textContent).toContain('About 1 min left');
    fire(ev({ etaSeconds: 30, throttled: true }));
    expect(job().textContent).toContain('Less than a minute left');
    fire(ev({ etaSeconds: null }));
    expect(job().textContent).not.toMatch(/left/);
  });

  it('a throttled upload says the server is limiting it and keeps Pause and Cancel', async () => {
    await mount();
    fire(ev({ throttled: true }));
    expect(face()).toBe('throttled');
    expect(job().textContent).toContain(en['mboxUpload.throttled']);
    expect(buttons()).toEqual(['cancel', 'pause']);
    fire(ev({ throttled: false }));
    expect(face()).toBe('running');
    expect(job().textContent).not.toContain(en['mboxUpload.throttled']);
  });

  it('Pause, Resume and Cancel call the daemon for this job', async () => {
    await mount();
    fire(ev());
    fireEvent.click(button('pause'));
    await act(flush);
    expect(calls('mbox_upload_pause')).toEqual([{ jobId: JOB }]);

    // The chip moves on the daemon's event, not on the button.
    expect(face()).toBe('running');
    fire(ev({ state: 'paused', paused: true }));
    expect(face()).toBe('paused');
    expect(job().textContent).toContain('Upload of Takeout.mbox paused');
    expect(buttons()).toEqual(['cancel', 'resume']);

    fireEvent.click(button('resume'));
    await settled('mbox_upload_resume', [{ jobId: JOB }]);
    expect(openMock).not.toHaveBeenCalled();

    fireEvent.click(button('cancel'));
    await act(flush);
    expect(calls('mbox_upload_cancel')).toEqual([{ jobId: JOB }]);
  });

  it('a sign-in the server refused says so, offers the account settings, and counts nothing as failed', async () => {
    const onOpenAccounts = vi.fn();
    await mount({ onOpenAccounts });
    fire(ev({ state: 'needsSignIn', paused: true, needsSignIn: true, uploadedCount: 2, failedCount: 0 }));
    expect(face()).toBe('needsSignIn');
    expect(job().textContent).toContain(en['mboxUpload.needsSignIn']);
    expect(job().textContent).toContain('2 uploaded, 0 skipped, 0 failed');
    expect(buttons()).toEqual(['cancel', 'resume', 'sign-in']);

    fireEvent.click(button('sign-in'));
    expect(onOpenAccounts).toHaveBeenCalledWith(ACCT);
    fireEvent.click(button('resume'));
    await settled('mbox_upload_resume', [{ jobId: JOB }]);
  });

  // The daemon never refreshes an OAuth token; a resume on the expired one
  // would only hold the job again.
  it('resuming an upload held for a refused sign-in refreshes the account\'s token first', async () => {
    const original = useMailStore.getState().accounts;
    const account = { id: ACCT, email: 'me@gmail.test', authType: 'oauth2', oauth2RefreshToken: 'r', oauth2ExpiresAt: 1 };
    useMailStore.setState({ accounts: [account] });
    const order = [];
    refreshMock.mockImplementation(async (a) => { order.push(`refresh ${a.id}`); return a; });
    controlReply = (cmd) => { order.push(cmd); return Promise.resolve({ jobId: JOB, resumed: true, restarted: false }); };
    try {
      await mount({ onOpenAccounts: vi.fn() });
      fire(ev({ state: 'needsSignIn', paused: true, needsSignIn: true }));
      fireEvent.click(button('resume'));
      await settled('mbox_upload_resume', [{ jobId: JOB }]);
      expect(refreshMock).toHaveBeenCalledWith(account);
      expect(order).toEqual([`refresh ${ACCT}`, 'mbox_upload_resume']);
    } finally {
      useMailStore.setState({ accounts: original });
    }
  });

  it('with no account settings to open, a refused sign-in is a plain message', async () => {
    await mount();
    fire(ev({ state: 'needsSignIn', paused: true, needsSignIn: true }));
    expect(job().textContent).toContain(en['mboxUpload.needsSignIn']);
    expect(buttons()).toEqual(['cancel', 'resume']);
  });

  it('after a restart, an upload the daemon kept a journal of shows as stopped, with Resume and Discard', async () => {
    statusReply = { jobs: [journal({ uploadedCount: 40, skippedCount: 1, bytesDone: 400 })] };
    await mount();
    expect(face()).toBe('stopped');
    expect(job().textContent).toContain('Upload of Takeout.mbox stopped');
    expect(job().textContent).toContain('40 uploaded, 1 skipped, 0 failed');
    expect(job().querySelector('[role="progressbar"]').getAttribute('aria-valuenow')).toBe('40');
    expect(buttons()).toEqual(['discard', 'resume']);

    fireEvent.click(button('discard'));
    await act(flush);
    expect(calls('mbox_upload_discard')).toEqual([{ jobId: JOB }]);
    // A journal with no worker sends no event: the chip lets it go itself.
    expect(chip()).toBeNull();
  });

  it('a stopped upload whose file the daemon may no longer read is resumed with the file picked again', async () => {
    statusReply = { jobs: [journal()] };
    let n = 0;
    controlReply = (cmd) => (cmd === 'mbox_upload_resume' && (n += 1) === 1
      ? Promise.reject(new Error('Failed to read mbox file: Operation not permitted (os error 1)'))
      : Promise.resolve({ jobId: JOB, resumed: true, restarted: false }));
    openMock.mockResolvedValue('/Users/me/Downloads/Takeout.mbox');
    await mount();
    fireEvent.click(button('resume'));
    // The picker is loaded on demand: wait for the second call, not a tick count.
    await act(() => vi.waitFor(() => expect(calls('mbox_upload_resume')).toHaveLength(2), { timeout: 10_000 }));
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(calls('mbox_upload_resume')).toEqual([{ jobId: JOB }, { jobId: JOB, sourcePath: '/Users/me/Downloads/Takeout.mbox' }]);
    // Nothing went wrong that the user has to read.
    expect(job().textContent).not.toContain(en['mboxUpload.actionFailed']);
    expect(job().textContent).not.toMatch(/os error/);
  });

  it('a cancelled upload keeps its journal: Resume and Discard, not Pause', async () => {
    await mount();
    fire(ev({ uploadedCount: 5 }));
    fire(ev({ active: false, state: 'cancelled', total: 5, uploadedCount: 5 }));
    expect(face()).toBe('stopped');
    expect(buttons()).toEqual(['discard', 'resume']);
  });

  it('a discarded upload leaves the chip', async () => {
    await mount();
    fire(ev());
    fire(ev({ active: false, state: 'discarded' }));
    expect(chip()).toBeNull();
  });

  it('a file that stopped being readable shows the catalog words, never the daemon\'s', async () => {
    await mount();
    fire(ev({ active: false, state: 'paused', paused: true, error: 'E_MBOX_UPLOAD_READ: No such file or directory (os error 2)' }));
    expect(face()).toBe('stopped');
    expect(job().textContent).toContain(en['errors.E_MBOX_UPLOAD_READ']);
    expect(job().textContent).not.toMatch(/os error|No such file/);
  });

  it('a job the daemon no longer knows leaves the chip; another refusal shows catalog words in the chip, not an alert', async () => {
    const alert = vi.fn();
    vi.stubGlobal('alert', alert);
    try {
      await mount();
      fire(ev());
      controlReply = () => Promise.reject(new Error('custody store unavailable: closed'));
      fireEvent.click(button('pause'));
      await act(flush);
      expect(job().textContent).toContain(en['mboxUpload.actionFailed']);
      expect(job().textContent).not.toContain('custody');

      controlReply = (cmd) => Promise.reject(new Error(`E_MBOX_UPLOAD_NOT_FOUND: ${JOB}`));
      fireEvent.click(button('cancel'));
      await act(flush);
      expect(chip()).toBeNull();
      expect(alert).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a finished upload shows its summary and reloads the account on screen, once', async () => {
    const refreshCurrentView = vi.fn(async () => {});
    useMailStore.setState({ activeAccountId: ACCT, unifiedInbox: false, refreshCurrentView });
    await mount();
    fire(ev({ uploadedCount: 4 }));
    fire(ev({ active: false, state: 'done', total: 5, completed: 5, uploadedCount: 5, skippedCount: 2, failedCount: 0, bytesDone: 1000, foldersChanged: true }));
    // The store and the folder-count sweep are loaded on demand.
    await vi.waitFor(() => expect(refreshCurrentView).toHaveBeenCalled(), { timeout: 10_000 });
    expect(face()).toBe('done');
    expect(job().textContent).toContain('Upload of Takeout.mbox finished');
    expect(job().textContent).toContain('5 uploaded, 2 skipped, 0 failed');
    expect(buttons()).toEqual(['dismiss']);
    expect(refreshCurrentView).toHaveBeenCalledTimes(1);
    expect(takeForcedMailboxRefetch(ACCT)).toBe(true);

    // The summary stays until dismissed; later renders reload nothing again.
    await act(async () => { vi.advanceTimersByTime(RENDER_EVERY_MS * 5); });
    expect(face()).toBe('done');
    expect(refreshCurrentView).toHaveBeenCalledTimes(1);
    fireEvent.click(button('dismiss'));
    expect(chip()).toBeNull();
  });

  it('never opens a modal and never takes focus, in any state', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    try {
      await mount({ onOpenAccounts: vi.fn() });
      for (const payload of [
        ev(),
        ev({ throttled: true, etaSeconds: 600 }),
        ev({ state: 'paused', paused: true }),
        ev({ state: 'needsSignIn', paused: true, needsSignIn: true }),
        ev({ active: false, state: 'cancelled' }),
        ev({ active: false, state: 'done', uploadedCount: 0 }),
      ]) {
        fire(payload);
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(screen.queryByRole('alertdialog')).toBeNull();
        expect(document.activeElement).toBe(input);
      }
    } finally {
      input.remove();
    }
  });

  it('renders a burst of progress at most once per interval, never touches the mail store, and shows a pause at once', async () => {
    const commits = vi.fn();
    render(<Profiler id="chip" onRender={commits}><MboxUploadProgress /></Profiler>);
    await ready();
    fire(ev({ uploadedCount: 0 }));
    expect(face()).toBe('running');

    const storeChanges = vi.fn();
    const unsubscribe = useMailStore.subscribe(storeChanges);
    try {
      const before = commits.mock.calls.length;
      for (let i = 1; i <= 50; i += 1) fire(ev({ uploadedCount: i, bytesDone: i * 10 }));
      // Fifty events in one interval: nothing rendered yet...
      expect(commits.mock.calls.length).toBe(before);
      expect(job().textContent).toContain('0 uploaded');
      expect(job().textContent).not.toContain('50 uploaded');
      await tick();
      // ...then one render, with the newest counts.
      expect(commits.mock.calls.length).toBe(before + 1);
      expect(job().textContent).toContain('50 uploaded');

      // A change of state is not held back: the pause shows without waiting.
      fire(ev({ uploadedCount: 51, bytesDone: 510 }));
      fire(ev({ state: 'paused', paused: true, uploadedCount: 51, bytesDone: 510 }));
      expect(face()).toBe('paused');
      expect(job().textContent).toContain('51 uploaded');
      expect(storeChanges).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('ignores the progress of the other import modes', async () => {
    await mount();
    fire({ total: 0, completed: 3, active: true, bytesDone: 10, bytesTotal: 100 });
    expect(chip()).toBeNull();
  });

  it('shows one row per job: two accounts can each run one', async () => {
    await mount();
    fire(ev());
    fire(ev({ jobId: 'job-2', accountId: 'acct-b', fileName: 'Other.mbox', state: 'paused', paused: true }));
    expect(face(JOB)).toBe('running');
    expect(face('job-2')).toBe('paused');
    fireEvent.click(button('resume', 'job-2'));
    await settled('mbox_upload_resume', [{ jobId: 'job-2' }]);
  });

  it('asks again when the daemon restarts: a job cut off by it now reads as stopped', async () => {
    await mount();
    fire(ev({ uploadedCount: 9 }));
    expect(face()).toBe('running');
    statusReply = { jobs: [journal({ uploadedCount: 9 })] };
    await reconnect();
    expect(calls('mbox_upload_status')).toHaveLength(2);
    expect(face()).toBe('stopped');
  });

  it('a daemon that cannot list its jobs leaves the chip as it was', async () => {
    statusReply = () => Promise.reject(new Error('errors.daemonOutdated'));
    await mount();
    expect(chip()).toBeNull();
    fire(ev());
    expect(face()).toBe('running');
  });
});
