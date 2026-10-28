/**
 * Refresh, pressed while a branch is listed.
 *
 * refreshCurrentView already knows the unified view is not a folder it can
 * hand to activateAccount. A branch listing is the third kind of view and was
 * not: activateAccount clears `mailboxScope` on purpose (that is what makes an
 * ordinary folder open ordinary), so Refresh collapsed the list to the branch
 * root — with the heading still saying "across N folders" — until the reader
 * clicked the folder again. bson73, discussion #1.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

let state;
vi.mock('../../../stores/mailStore', () => ({
  useMailStore: {
    getState: () => state,
    setState: (patch) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; },
  },
}));
vi.mock('../../db', () => ({}));
vi.mock('../../api', () => ({}));
vi.mock('../../cacheManager', () => ({
  invalidateRestoreDescriptors: vi.fn(),
  getAccountCacheMailboxes: () => null,
  listGraphMessages: vi.fn(),
}));
const mockInvalidateProbe = vi.fn();
vi.mock('../../syncProbe', () => ({ invalidate: (...a) => mockInvalidateProbe(...a) }));
const mockForceMailboxRefetch = vi.fn();
vi.mock('../helpers/mailboxRefetch', () => ({
  forceMailboxRefetch: (...a) => mockForceMailboxRefetch(...a),
  takeForcedMailboxRefetch: () => false,
}));
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ isAccountHidden: () => false, unreadPerAccount: {} }) },
}));
const mockRefreshFolderStatus = vi.fn().mockResolvedValue(null);
const mockInvalidateFolderStatus = vi.fn();
vi.mock('../folderStatus', () => ({
  refreshFolderStatus: (...a) => mockRefreshFolderStatus(...a),
  invalidateFolderStatus: (...a) => mockInvalidateFolderStatus(...a),
}));

const { refreshCurrentView } = await import('../refreshAccounts');

beforeEach(() => {
  mockInvalidateProbe.mockReset().mockResolvedValue({ invalidated: true });
  mockInvalidateFolderStatus.mockReset().mockResolvedValue({ invalidated: true });
  mockForceMailboxRefetch.mockReset();
  mockRefreshFolderStatus.mockReset().mockResolvedValue(null);
  state = {
    accounts: [{ id: 'acct-1' }],
    activeAccountId: 'acct-1',
    activeMailbox: 'Kunden',
    mailboxes: [],
    unifiedInbox: false,
    unifiedFolder: null,
    mailboxScope: null,
    activateAccount: vi.fn().mockResolvedValue(undefined),
    loadSubtree: vi.fn().mockResolvedValue(undefined),
    refreshAllAccounts: vi.fn().mockResolvedValue({}),
    loadUnifiedInbox: vi.fn().mockResolvedValue(undefined),
  };
});

describe('refreshCurrentView', () => {
  it('re-lists the branch instead of collapsing it to the root folder', async () => {
    state.mailboxScope = { root: 'Kunden', paths: ['Kunden', 'Kunden.Company XY'] };

    await refreshCurrentView();

    expect(state.loadSubtree).toHaveBeenCalledWith('acct-1', 'Kunden');
    expect(state.activateAccount).not.toHaveBeenCalled();
    expect(state.mailboxScope).not.toBe(null);
  });

  it('still refreshes an ordinary folder through activateAccount', async () => {
    await refreshCurrentView();

    expect(state.activateAccount).toHaveBeenCalledWith('acct-1', 'Kunden');
    expect(state.loadSubtree).not.toHaveBeenCalled();
  });

  it('waits for both native invalidations before activating the open folder', async () => {
    let enteredProbe;
    let enteredFolder;
    let releaseProbe;
    let releaseFolder;
    const probeStarted = new Promise(resolve => { enteredProbe = resolve; });
    const folderStarted = new Promise(resolve => { enteredFolder = resolve; });
    const probeHeld = new Promise(resolve => { releaseProbe = resolve; });
    const folderHeld = new Promise(resolve => { releaseFolder = resolve; });
    mockInvalidateProbe.mockImplementation(() => { enteredProbe(); return probeHeld; });
    mockInvalidateFolderStatus.mockImplementation(() => { enteredFolder(); return folderHeld; });

    const refresh = refreshCurrentView();
    await Promise.all([probeStarted, folderStarted]);
    expect(state.activateAccount).not.toHaveBeenCalled();
    releaseProbe({ invalidated: true });
    await probeHeld;
    expect(state.activateAccount).not.toHaveBeenCalled();
    releaseFolder({ invalidated: true });
    await refresh;
    expect(state.activateAccount).toHaveBeenCalledWith('acct-1', 'Kunden');
  });

  it('forces the folder list to be refetched for the active account', async () => {
    await refreshCurrentView();

    expect(mockForceMailboxRefetch).toHaveBeenCalledWith('acct-1');
  });

  // The sweep is throttled to one a minute per account, so a Refresh inside
  // that minute would leave every closed folder's unread count as it was —
  // which is exactly what the button is pressed to fix. Refresh drops the
  // timestamp instead of adding a second sweep: activateAccount runs one of
  // its own a few lines later, and forcing meant every Refresh sent STATUS for
  // up to 50 folders TWICE on one background session.
  it('invalidates the closed folders unread sweep instead of forcing a second one', async () => {
    await refreshCurrentView();

    expect(mockInvalidateFolderStatus).toHaveBeenCalledWith('acct-1');
    expect(mockRefreshFolderStatus).not.toHaveBeenCalled();
  });
});
