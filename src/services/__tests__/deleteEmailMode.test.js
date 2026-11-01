/**
 * The app says what it wants (`mode`); the daemon decides whether that is a
 * move to Trash or a permanent delete (src-daemon/src/message_delete.rs, which
 * matches INBOX case-insensitively). `deleteEmail` therefore reads no folder
 * name and sends no `permanent` flag: a JS copy of the rule drifted from the
 * daemon's once already (27591bf53, an Inbox purge that only filed the server
 * copy in Trash).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSend = vi.fn();
vi.mock('../transport.js', () => ({ send: (...a) => mockSend(...a) }));
vi.mock('../../i18n/index.js', () => ({ t: (k) => k }));

globalThis.window = globalThis.window || {};
globalThis.window.__TAURI__ = { core: { invoke: () => {} } };

const api = await import('../api.js');

const ACCOUNT = { id: 'acct1', email: 'a@example.com' };
const OUTLOOK = {
  id: 'acc-outlook', email: 'padme@outlook.test', authType: 'oauth2', oauth2Transport: 'graph',
  oauth2AccessToken: 'header.payload.signature',
};

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({ success: true });
});

const sent = () => {
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend.mock.calls[0][0]).toBe('imap_delete_email');
  return mockSend.mock.calls[0][1];
};

describe('api.deleteEmail sends intent, not policy', () => {
  it.each(['INBOX', 'Inbox', 'Sent', '[Gmail]/All Mail', 'Trash'])('mode is "auto" for %s, whatever the folder', async (mailbox) => {
    await api.deleteEmail(ACCOUNT, 7, mailbox);
    const p = sent();
    expect(p).toMatchObject({ account: ACCOUNT, uid: 7, mailbox, mode: 'auto', bin: true });
    expect(p).not.toHaveProperty('permanent');
  });

  it('defaults to the INBOX, still without deciding anything', async () => {
    await api.deleteEmail(ACCOUNT, 7);
    expect(sent()).toMatchObject({ mailbox: 'INBOX', mode: 'auto' });
  });

  it.each(['trash', 'permanent'])('passes an explicit mode "%s" through', async (mode) => {
    await api.deleteEmail(ACCOUNT, 7, 'INBOX', { mode });
    const p = sent();
    expect(p.mode).toBe(mode);
    expect(p).not.toHaveProperty('permanent');
  });

  it('keeps the bin opt-out beside the mode', async () => {
    await api.deleteEmail(ACCOUNT, 7, 'Sent', { mode: 'permanent', bin: false });
    expect(sent()).toMatchObject({ mode: 'permanent', bin: false });
  });

  it('a positional permanent argument is gone: the fourth argument is the options object', async () => {
    expect(api.deleteEmail.length).toBeLessThanOrEqual(3);
    // A stale caller passing `true` would have meant permanent; it is now
    // read as (empty) options and the daemon decides.
    await api.deleteEmail(ACCOUNT, 7, 'INBOX', true);
    const p = sent();
    expect(p.mode).toBe('auto');
    expect(p).not.toHaveProperty('permanent');
  });
});

describe('graphDeleteMessage', () => {
  it('sends no permanent flag (a Graph delete always goes to Deleted Items)', async () => {
    await api.graphDeleteMessage(OUTLOOK, 'm1', { accountId: 'acc-outlook', mailbox: 'INBOX', uid: 7 });
    expect(mockSend.mock.calls[0][0]).toBe('graph_delete_message');
    expect(mockSend.mock.calls[0][1]).not.toHaveProperty('permanent');
  });
});
