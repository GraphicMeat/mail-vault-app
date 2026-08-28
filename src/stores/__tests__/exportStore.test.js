import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = {
  accounts: [
    { id: 'acct-1', email: 'rowan@primecut.studio' },
    { id: 'acct-2', email: 'studio@primecut.studio' },
  ],
  activeAccountId: 'acct-1',
  activeMailbox: 'INBOX',
};
vi.mock('../mailStore', () => ({ useMailStore: { getState: () => state } }));

let premium = true;
vi.mock('../settingsStore', () => ({
  useSettingsStore: { getState: () => ({ billingProfile: null }) },
  hasPremiumAccess: () => premium,
}));

const { useExportStore } = await import('../exportStore');

const msg = (over = {}) => ({ uid: 1, subject: 'Root', ...over });

beforeEach(() => {
  useExportStore.setState({ target: null, showSamples: false });
  state.activeAccountId = 'acct-1';
  state.activeMailbox = 'INBOX';
  premium = true;
});

describe('openExport', () => {
  it('stamps the active account and mailbox when the surface names neither', () => {
    useExportStore.getState().openExport({ messages: [msg()] });
    expect(useExportStore.getState().target).toMatchObject({
      account: 'rowan@primecut.studio', mailbox: 'INBOX',
    });
  });

  // A unified row belongs to whichever account it came from, not to whichever
  // account happens to be active — stamping the active one would write false
  // provenance into the exported file's footer.
  it("follows the message's own account in a unified list", () => {
    useExportStore.getState().openExport({
      messages: [msg({ _accountId: 'acct-2', _mailbox: 'Archive' })],
    });
    expect(useExportStore.getState().target).toMatchObject({
      account: 'studio@primecut.studio', mailbox: 'Archive',
    });
  });

  it('lets a caller that knows better say so', () => {
    useExportStore.getState().openExport({
      messages: [msg({ _accountId: 'acct-2' })], account: 'override@x.test', mailbox: 'Sent',
    });
    expect(useExportStore.getState().target).toMatchObject({
      account: 'override@x.test', mailbox: 'Sent',
    });
  });

  it('falls back to the account id when the account has no address', () => {
    useExportStore.getState().openExport({ messages: [msg({ _accountId: 'acct-gone' })] });
    expect(useExportStore.getState().target.account).toBe('acct-gone');
  });

  it('carries the messages through untouched', () => {
    const messages = [msg(), msg({ uid: 2 })];
    useExportStore.getState().openExport({ messages });
    expect(useExportStore.getState().target.messages).toBe(messages);
  });
});

// Every configurable choice in the export dialog is premium, so for a free
// user it was a gate in front of a gate. The samples carry their own Upgrade
// button, so that is where the click lands — and it lands there for all four
// entry points because the routing is here, not at the call sites.
describe('the free-user route', () => {
  it('opens the samples instead of the dialog', () => {
    premium = false;
    useExportStore.getState().openExport({ messages: [msg()] });
    expect(useExportStore.getState().showSamples).toBe(true);
    expect(useExportStore.getState().target).toBeNull();
  });

  it('still opens the dialog with a subscription', () => {
    useExportStore.getState().openExport({ messages: [msg()] });
    expect(useExportStore.getState().showSamples).toBe(false);
    expect(useExportStore.getState().target).not.toBeNull();
  });
});

describe('open and close', () => {
  it('closeExport clears the target', () => {
    useExportStore.getState().openExport({ messages: [msg()] });
    useExportStore.getState().closeExport();
    expect(useExportStore.getState().target).toBeNull();
  });

  it('samples open and close independently of the dialog', () => {
    useExportStore.getState().openSamples();
    expect(useExportStore.getState().showSamples).toBe(true);
    useExportStore.getState().closeSamples();
    expect(useExportStore.getState().showSamples).toBe(false);
  });
});
