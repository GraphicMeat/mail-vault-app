/**
 * A Graph delete always goes to Deleted Items, so the wire call carries no
 * `permanent` flag. (The IMAP delete's intent, `mode`, is sent by
 * `deleteQueueSubmit`; the daemon decides what it means for the folder,
 * src-daemon/src/message_delete.rs.)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSend = vi.fn();
vi.mock('../transport.js', () => ({ send: (...a) => mockSend(...a) }));
vi.mock('../../i18n/index.js', () => ({ t: (k) => k }));

globalThis.window = globalThis.window || {};
globalThis.window.__TAURI__ = { core: { invoke: () => {} } };

const api = await import('../api.js');

const OUTLOOK = {
  id: 'acc-outlook', email: 'padme@outlook.test', authType: 'oauth2', oauth2Transport: 'graph',
  oauth2AccessToken: 'header.payload.signature',
};

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({ success: true });
});

describe('graphDeleteMessage', () => {
  it('sends no permanent flag (a Graph delete always goes to Deleted Items)', async () => {
    await api.graphDeleteMessage(OUTLOOK, 'm1', { accountId: 'acc-outlook', mailbox: 'INBOX', uid: 7 });
    expect(mockSend.mock.calls[0][0]).toBe('graph_delete_message');
    expect(mockSend.mock.calls[0][1]).not.toHaveProperty('permanent');
  });
});
