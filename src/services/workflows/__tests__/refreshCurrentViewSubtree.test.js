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
vi.mock('../../syncProbe', () => ({ invalidate: vi.fn() }));
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ isAccountHidden: () => false, unreadPerAccount: {} }) },
}));

const { refreshCurrentView } = await import('../refreshAccounts');

beforeEach(() => {
  state = {
    accounts: [{ id: 'acct-1' }],
    activeAccountId: 'acct-1',
    activeMailbox: 'Kunden',
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
});
