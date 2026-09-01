// The bulk modal's range pick has to become real list selection, and that
// selection has to outlive the modal closing — otherwise minimizing to the
// bubble silently throws the user's 27-message selection away.
import { describe, it, expect, beforeEach, vi } from 'vitest';

if (!globalThis.window) globalThis.window = {};
globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
globalThis.window.removeEventListener = globalThis.window.removeEventListener || (() => {});

vi.mock('../../services/db', () => ({
  initDB: vi.fn().mockResolvedValue(undefined),
  getSavedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getArchivedEmailIds: vi.fn().mockResolvedValue(new Set()),
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
const { invalidateChatAndThreadCaches } = await import('../slices/messageListSlice');

beforeEach(() => {
  useMailStore.setState({
    activeMailbox: 'INBOX.Spam',
    selectedEmailIds: new Set(),
    sortedEmails: [],
    sentEmails: [],
    bulkModalOpen: false,
    bulkSession: null,
  });
  // getChatEmails/getThreads memoize behind a fingerprint that several of these
  // cases match exactly (same mailbox, same list length, same first/last uid).
  // Without this, a case reads the previous case's messages.
  invalidateChatAndThreadCaches();
});

describe('bulk session', () => {
  it('setSelection replaces the selection wholesale', () => {
    useMailStore.getState().setSelection([1, 2, 3]);
    expect([...useMailStore.getState().selectedEmailIds]).toEqual([1, 2, 3]);

    useMailStore.getState().setSelection([4]);
    expect([...useMailStore.getState().selectedEmailIds]).toEqual([4]);
  });

  it('minimize keeps the session and the selection, only hides the modal', () => {
    useMailStore.getState().openBulkModal();
    useMailStore.getState().setSelection([1, 2]);
    useMailStore.getState().setBulkSession({ step: 2, range: { type: 'all' } });

    useMailStore.getState().minimizeBulkModal();

    const s = useMailStore.getState();
    expect(s.bulkModalOpen).toBe(false);
    expect(s.bulkSession.active).toBe(true);
    expect(s.bulkSession.step).toBe(2);
    expect(s.bulkSession.range).toEqual({ type: 'all' });
    expect(s.selectedEmailIds.size).toBe(2);
  });

  it('reopening restores the step and range the session was minimized at', () => {
    useMailStore.getState().openBulkModal();
    useMailStore.getState().setBulkSession({ step: 2, range: { type: 'year', year: 2026 } });
    useMailStore.getState().minimizeBulkModal();

    useMailStore.getState().openBulkModal();

    const s = useMailStore.getState();
    expect(s.bulkModalOpen).toBe(true);
    expect(s.bulkSession.step).toBe(2);
    expect(s.bulkSession.range).toEqual({ type: 'year', year: 2026 });
  });

  it('ending the session clears both the session and the selection', () => {
    useMailStore.getState().openBulkModal();
    useMailStore.getState().setSelection([1, 2, 3]);

    useMailStore.getState().endBulkSession();

    const s = useMailStore.getState();
    expect(s.bulkSession).toBe(null);
    expect(s.bulkModalOpen).toBe(false);
    expect(s.selectedEmailIds.size).toBe(0);
  });

  it('a hand-edited checkbox survives minimize — the bubble count follows it', () => {
    useMailStore.getState().openBulkModal();
    useMailStore.getState().setSelection([1, 2, 3]);
    useMailStore.getState().minimizeBulkModal();

    useMailStore.getState().toggleEmailSelection(2);

    expect(useMailStore.getState().selectedEmailIds.size).toBe(2);
    expect(useMailStore.getState().bulkSession.active).toBe(true);
  });

  // A session belongs to exactly one (account, mailbox, viewMode) — bound at
  // creation so EmailList can tell "still the same folder and view" apart
  // from "user navigated away" and end a session that no longer applies.
  // viewMode matters because "All" resolves against a different pool in
  // local-only view than in server view, for the very same mailbox.
  it('openBulkModal binds the session to the account, mailbox, and viewMode active at creation', () => {
    useMailStore.setState({ activeAccountId: 'acct-9', activeMailbox: 'INBOX.Spam', viewMode: 'local' });

    useMailStore.getState().openBulkModal();

    const s = useMailStore.getState();
    expect(s.bulkSession.accountId).toBe('acct-9');
    expect(s.bulkSession.mailbox).toBe('INBOX.Spam');
    expect(s.bulkSession.viewMode).toBe('local');
  });

  // The bar and the bulk modal must agree: the modal selects against the whole
  // sidecar cache, so most of a range selection can sit outside the paginated
  // render window. Threading only sees the window — those rows used to count
  // as zero, so the bar read "52 selected (65 emails)" while the modal (and
  // the archive that followed) worked on 65.
  it('counts selected messages that are outside the render window', () => {
    useMailStore.setState({
      activeMailbox: 'INBOX',
      sortedEmails: [
        { uid: 1, messageId: '<a@x>' },
        { uid: 2, messageId: '<b@x>' },
      ],
    });
    useMailStore.getState().setSelection([1, 2, 3, 4]);

    expect(useMailStore.getState().getSelectionSummary()).toEqual({ threads: 4, emails: 4 });
  });

  it('still collapses a loaded thread to one unit', () => {
    useMailStore.setState({
      activeMailbox: 'INBOX',
      sortedEmails: [
        { uid: 1, messageId: '<a@x>' },
        { uid: 2, messageId: '<b@x>', inReplyTo: '<a@x>' },
      ],
    });
    useMailStore.getState().setSelection([1, 2]);

    expect(useMailStore.getState().getSelectionSummary()).toEqual({ threads: 1, emails: 2 });
  });

  // The reported defect: two checked rows, bar reads "11 selected (4
  // conversations)". An INBOX list threads INBOX + Sent together, so the row
  // is one conversation on screen; counting over INBOX alone splits it again
  // at every point where the only link was a reply the user sent.
  it('counts a conversation linked only through a sent reply as one conversation', () => {
    useMailStore.setState({
      activeMailbox: 'INBOX',
      activeAccountId: 'acct-1',
      sortedEmails: [
        { uid: 1, messageId: '<a@x>' },
        { uid: 3, messageId: '<c@x>', inReplyTo: '<b@x>' },
      ],
      sentEmails: [
        { uid: 90, messageId: '<b@x>', inReplyTo: '<a@x>', _accountId: 'acct-1' },
      ],
    });
    useMailStore.getState().setSelection([1, 3]);

    expect(useMailStore.getState().getSelectionSummary()).toEqual({ threads: 1, emails: 2 });
  });
});

// A thread row's checkbox is one control over every message in the row. Toggling
// them one at a time inverted a partly-selected row instead of following the box
// the user just clicked, and wrote to the store once per message.
describe('setEmailsSelected', () => {
  const row = [{ uid: 1 }, { uid: 2 }, { uid: 3 }];

  it('checks the whole row, then clears the whole row', () => {
    useMailStore.getState().setEmailsSelected(row, true);
    expect([...useMailStore.getState().selectedEmailIds]).toEqual([1, 2, 3]);

    useMailStore.getState().setEmailsSelected(row, false);
    expect(useMailStore.getState().selectedEmailIds.size).toBe(0);
  });

  it('follows the checkbox on a partly-selected row instead of inverting it', () => {
    useMailStore.getState().setSelection([2]);

    useMailStore.getState().setEmailsSelected(row, true);

    expect([...useMailStore.getState().selectedEmailIds].sort()).toEqual([1, 2, 3]);
  });

  it('leaves the rest of the selection alone', () => {
    useMailStore.getState().setSelection([99]);

    useMailStore.getState().setEmailsSelected(row, true);
    useMailStore.getState().setEmailsSelected(row, false);

    expect([...useMailStore.getState().selectedEmailIds]).toEqual([99]);
  });

  it('keys by account AND folder in the unified inbox', () => {
    useMailStore.setState({ activeMailbox: 'UNIFIED' });

    useMailStore.getState().setEmailsSelected(
      [{ uid: 7, _accountId: 'acct-2', _mailbox: 'INBOX' }], true);

    expect([...useMailStore.getState().selectedEmailIds]).toEqual(['acct-2:INBOX:7']);
  });

  it('keeps one account two folders, same uid, as two selections', () => {
    // The unified list merges each account's INBOX with its Sent folder, so
    // this pair is on screen together and a uid names neither of them alone.
    useMailStore.setState({ activeMailbox: 'UNIFIED' });

    useMailStore.getState().setEmailsSelected([
      { uid: 7, _accountId: 'acct-2', _mailbox: 'INBOX' },
      { uid: 7, _accountId: 'acct-2', _mailbox: 'Sent' },
    ], true);

    expect([...useMailStore.getState().selectedEmailIds].sort())
      .toEqual(['acct-2:INBOX:7', 'acct-2:Sent:7']);
  });
});
