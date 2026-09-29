// Track B (B2): the OAuth callback finishes the add on its own, which meant
// addAccount() could no longer sit blocked on the first-account activation —
// activateAccount's mailbox listing + first sync can run far longer than the
// save itself, and the caller (AccountModal) only needs the save to land
// before it reports success.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAccountLogicalKey = vi.fn(a => `${a.email}|${a.imapHost || a.oauth2Provider || ''}`);
const mockSaveAccount = vi.fn().mockResolvedValue(undefined);
vi.mock('../../db', () => ({
  accountLogicalKey: (...a) => mockAccountLogicalKey(...a),
  saveAccount: (...a) => mockSaveAccount(...a),
}));

const mockTestConnection = vi.fn().mockResolvedValue({ success: true });
vi.mock('../../api', () => ({
  testConnection: (...a) => mockTestConnection(...a),
  graphListFolders: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../graphConfig', () => ({
  isGraphAccount: () => false,
}));

vi.mock('../../authUtils', () => ({
  ensureFreshToken: vi.fn(async a => a),
}));

const mockActivateAccount = vi.fn(() => new Promise(() => {})); // never resolves within a test

vi.mock('../../../stores/mailStore', () => {
  const state = { accounts: [], activateAccount: (...a) => mockActivateAccount(...a) };
  const useMailStore = () => state;
  useMailStore.getState = () => state;
  useMailStore.setState = updater => {
    Object.assign(state, typeof updater === 'function' ? updater(state) : updater);
  };
  return { useMailStore, __mockState: state };
});

const { addAccount } = await import('../addAccount');
const { __mockState } = await import('../../../stores/mailStore');

describe('addAccount — first-account activation is fire-and-forget', () => {
  beforeEach(() => {
    mockSaveAccount.mockClear();
    mockActivateAccount.mockClear();
    mockTestConnection.mockClear();
    __mockState.accounts = [];
  });

  it('resolves once the account is saved, without waiting for activateAccount', async () => {
    const account = await addAccount({
      email: 'user@gmail.com',
      imapHost: 'imap.gmail.com',
      authType: 'oauth2',
      oauth2Provider: 'google',
      oauth2AccessToken: 'AT',
    });

    expect(account.email).toBe('user@gmail.com');
    // The save happened — addAccount genuinely finished its own work, it
    // didn't just skip past it.
    expect(mockSaveAccount).toHaveBeenCalledTimes(1);
    // The connection test that ran before the save carried the typed email,
    // not a blank one — this is the field the Rust side puts straight into
    // "Connection test timed out for <email>".
    expect(mockTestConnection).toHaveBeenCalledTimes(1);
    expect(mockTestConnection.mock.calls[0][0].email).toBe('user@gmail.com');
    // Activation was started (this is the only account, so it qualifies)...
    expect(mockActivateAccount).toHaveBeenCalledTimes(1);
    expect(mockActivateAccount).toHaveBeenCalledWith(account.id, 'INBOX');
    // ...but addAccount already resolved above despite that promise never
    // settling — if it were still awaited, the `await` on the line above
    // would never have returned and this assertion would not run.
  });

  it('does not turn a rejected activation into an unhandled rejection', async () => {
    mockActivateAccount.mockImplementationOnce(() => Promise.reject(new Error('mailbox listing failed')));
    // Must not throw, and must not leave the rejection unhandled — vitest
    // fails the whole run on an unhandled rejection, not just this test.
    await expect(addAccount({ email: 'user2@gmail.com', imapHost: 'imap.gmail.com' })).resolves.toBeTruthy();
  });
});

// The add-account form shows what the connection test reached. The summary
// rides on the value addAccount returns, never on the account that is saved
// and put in the store.
describe('addAccount: the connection test summary', () => {
  beforeEach(() => {
    mockSaveAccount.mockClear();
    mockTestConnection.mockReset();
    __mockState.accounts = [];
  });

  it('returns what the test reached', async () => {
    mockTestConnection.mockResolvedValue({
      success: true,
      host: 'imap.example.test',
      port: 993,
      messageCount: 1204,
      fromAddress: 'me@example.test',
    });

    const added = await addAccount({ email: 'me@example.test', imapHost: 'imap.example.test' });

    expect(added.connectionCheck).toEqual({
      host: 'imap.example.test',
      messageCount: 1204,
      fromAddress: 'me@example.test',
    });
    expect(mockSaveAccount.mock.calls[0][0]).not.toHaveProperty('connectionCheck');
    expect(__mockState.accounts[0]).not.toHaveProperty('connectionCheck');
    expect(added.id).toBe(__mockState.accounts[0].id);
  });

  it('keeps a null count as null', async () => {
    mockTestConnection.mockResolvedValue({ success: true, host: 'imap.example.test', port: 993, messageCount: null, fromAddress: 'me@example.test' });
    const added = await addAccount({ email: 'me2@example.test', imapHost: 'imap.example.test' });
    expect(added.connectionCheck.messageCount).toBeNull();
  });

  it('has no summary when the test named no server (an older daemon)', async () => {
    mockTestConnection.mockResolvedValue({ success: true, message: 'Connection successful' });
    const added = await addAccount({ email: 'me3@example.test', imapHost: 'imap.example.test' });
    expect(added.connectionCheck).toBeNull();
  });
});
