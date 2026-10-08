// An email outside the inbox cannot be unread: a sent message was sent, not
// received. The unread filter in such a folder can only ever be empty, so
// turning it on flashes the open folder in the sidebar, which says "nothing
// unread lives here", instead of leaving an unexplained empty list next to an
// account badge that counts the inbox.
import { describe, it, expect, beforeEach, vi } from 'vitest';

if (!globalThis.window) globalThis.window = {};
globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
globalThis.window.removeEventListener = globalThis.window.removeEventListener || (() => {});

vi.mock('../../services/db', () => ({
  initDB: vi.fn().mockResolvedValue(undefined),
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
const store = () => useMailStore.getState();

beforeEach(() => {
  useMailStore.setState({
    unreadOnly: false, unreadKeep: new Set(), unreadFlash: null, unifiedInbox: false, activeMailbox: 'INBOX',
  });
});

describe('unread filter in a folder that is not the inbox', () => {
  it('flashes the open folder when the filter goes on', () => {
    useMailStore.setState({ activeMailbox: '[Gmail]/Sent Mail' });
    store().toggleUnreadOnly();
    expect(store().unreadOnly).toBe(true);
    expect(store().unreadFlash).toMatchObject({ path: '[Gmail]/Sent Mail' });
  });

  it('flashes again on every turn-on, so the sidebar can replay it', () => {
    useMailStore.setState({ activeMailbox: 'Sent' });
    store().toggleUnreadOnly();
    const first = store().unreadFlash.n;
    store().toggleUnreadOnly();
    store().toggleUnreadOnly();
    expect(store().unreadFlash.n).toBeGreaterThan(first);
  });

  it('does not flash when the filter goes off', () => {
    useMailStore.setState({ activeMailbox: 'Sent', unreadOnly: true });
    store().toggleUnreadOnly();
    expect(store().unreadOnly).toBe(false);
    expect(store().unreadFlash).toBeNull();
  });

  it('does not flash in the inbox, where unread mail lives', () => {
    store().toggleUnreadOnly();
    expect(store().unreadOnly).toBe(true);
    expect(store().unreadFlash).toBeNull();
  });

  it('does not flash in All Inboxes, which has no folder row to flash', () => {
    useMailStore.setState({ unifiedInbox: true, activeMailbox: 'Sent' });
    store().toggleUnreadOnly();
    expect(store().unreadFlash).toBeNull();
  });

  it('clearUnreadFlash ends the flash', () => {
    useMailStore.setState({ activeMailbox: 'Sent' });
    store().toggleUnreadOnly();
    store().clearUnreadFlash();
    expect(store().unreadFlash).toBeNull();
  });
});
