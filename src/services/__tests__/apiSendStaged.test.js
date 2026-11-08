// compose.send answers `mayHaveSent: true` for a send cut off after the server
// may have taken it. sendStaged throws that as an error carrying the flag, so
// the outbox keeps it as uncertain; any other reply passes through unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('../transport', () => ({ send: (...a) => mockSend(...a) }));

// api.js reads `window.__TAURI__` once, at import.
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, ...(globalThis.window || {}), __TAURI__: {} };
const { sendStaged } = await import('../api.js');

const params = { accountId: 'a1', mailbox: 'Sent', uid: 3, messageId: '<m@x>' };

beforeEach(() => { mockSend.mockReset(); });

describe('sendStaged', () => {
  it('throws a may-have-sent reply with the flag and the daemon words', async () => {
    mockSend.mockResolvedValue({ success: false, mayHaveSent: true, error: 'SMTP connection failed: closed' });
    const err = await sendStaged({}, {}, params).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.mayHaveSent).toBe(true);
    expect(err.message).toBe('SMTP connection failed: closed');
  });

  it('returns a success as it came', async () => {
    const reply = { success: true, mayHaveSent: false, messageId: '250 ok', entry: { uid: 3 } };
    mockSend.mockResolvedValue(reply);
    await expect(sendStaged({}, {}, params)).resolves.toEqual(reply);
  });

  it('leaves a plain error as it was, without the flag', async () => {
    mockSend.mockRejectedValue(new Error('Recipient address rejected'));
    const err = await sendStaged({}, {}, params).catch(e => e);
    expect(err.message).toBe('Recipient address rejected');
    expect(err.mayHaveSent).toBeUndefined();
  });
});
