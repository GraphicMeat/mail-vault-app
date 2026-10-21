// A banner that carries a one-time code gets two buttons on macOS, Copy &
// delete and Delete. Rust has no catalog, so their titles travel with it.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('../transport', () => ({ send: (...a) => mockSend(...a) }));

// api.js reads `window.__TAURI__` once, at import.
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, ...(globalThis.window || {}), __TAURI__: {} };
const { sendNotification } = await import('../api.js');

beforeEach(() => { mockSend.mockReset().mockResolvedValue(null); });

describe('sendNotification', () => {
  it('sends the action titles with a banner that carries a code', async () => {
    const target = { accountId: 'a1', mailbox: 'INBOX', uid: 7, code: '26313' };
    await sendNotification('PlayBall', '26313\nPassword Reset Request', undefined, target);
    expect(mockSend).toHaveBeenCalledWith('send_notification', {
      title: 'PlayBall', body: '26313\nPassword Reset Request', target,
      actions: { copyDelete: 'Copy & delete', delete: 'Delete' },
    });
  });

  it('sends no actions without a code', async () => {
    const target = { accountId: 'a1', mailbox: 'INBOX', uid: 7 };
    await sendNotification('Ada', 'Hello', 'Ping', target);
    expect(mockSend).toHaveBeenCalledWith('send_notification', { title: 'Ada', body: 'Hello', sound: 'Ping', target });
  });
});
