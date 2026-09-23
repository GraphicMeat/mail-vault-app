// The unread filter's sticky keep set.
//
// Reading a message marks it read, and with the filter on that used to take
// the row off the list the moment the selection moved on — the message you
// just read disappeared from under you. A message read while the filter is on
// stays until the filter is toggled, which is the only moment the user asks
// for the list to be re-cut.
import { describe, it, expect, beforeEach, vi } from 'vitest';

if (!globalThis.window) globalThis.window = {};
globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
globalThis.window.removeEventListener = globalThis.window.removeEventListener || (() => {});

vi.mock('../../services/db', () => ({
  initDB: vi.fn().mockResolvedValue(undefined),
  getSavedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getArchivedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getVaultUidSets: vi.fn().mockResolvedValue({ saved: new Set(), archived: new Set() }),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getAccounts: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../services/safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useMailStore } = await import('../mailStore');

beforeEach(() => {
  useMailStore.setState({ unreadOnly: false, unreadKeep: new Set() });
});

describe('unread filter keep set', () => {
  it('remembers a message read while the filter is on', () => {
    useMailStore.setState({ unreadOnly: true });
    useMailStore.getState().keepVisibleWhileUnreadFiltered([12]);
    expect([...useMailStore.getState().unreadKeep]).toEqual([12]);
  });

  it('is a new Set each time, so a memo downstream sees the change', () => {
    useMailStore.setState({ unreadOnly: true });
    const before = useMailStore.getState().unreadKeep;
    useMailStore.getState().keepVisibleWhileUnreadFiltered([12]);
    expect(useMailStore.getState().unreadKeep).not.toBe(before);
  });

  it('records nothing while the filter is off', () => {
    useMailStore.getState().keepVisibleWhileUnreadFiltered([12]);
    expect(useMailStore.getState().unreadKeep.size).toBe(0);
  });

  it('is emptied by toggling the filter, in both directions', () => {
    useMailStore.setState({ unreadOnly: true, unreadKeep: new Set([12, 13]) });
    useMailStore.getState().toggleUnreadOnly();
    expect(useMailStore.getState().unreadOnly).toBe(false);
    expect(useMailStore.getState().unreadKeep.size).toBe(0);

    useMailStore.setState({ unreadKeep: new Set([12]) });
    useMailStore.getState().toggleUnreadOnly();
    expect(useMailStore.getState().unreadOnly).toBe(true);
    expect(useMailStore.getState().unreadKeep.size).toBe(0);
  });
});
