/**
 * `imap_get_email_light` answers a download-ahead fetch (`intent: 'backfill'`)
 * with `{success:false, limitReached:true, limitBytes, resumeAfterMs}` once the
 * account's daily download limit is spent (handlers/imap.rs). `fetchEmailLight`
 * turns that into a `LimitReachedError` so the pipeline can sleep until the
 * reset instead of retrying; an ordinary reply must not come back wearing it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSend = vi.fn();
vi.mock('../transport.js', () => ({ send: (...a) => mockSend(...a) }));
vi.mock('../../i18n/index.js', () => ({ t: (k) => k }));

globalThis.window = globalThis.window || {};
globalThis.window.__TAURI__ = { core: { invoke: () => {} } };

const { fetchEmailLight, LimitReachedError } = await import('../api.js');

const ACCOUNT = { id: 'acct1', email: 'luke@mock.test' };

beforeEach(() => vi.clearAllMocks());

describe('fetchEmailLight at the daily download limit', () => {
  it('throws LimitReachedError carrying the limit and the reset time', async () => {
    mockSend.mockResolvedValue({
      success: false, limitReached: true, limitBytes: 2097152000, resumeAfterMs: 1773187200000, uid: 7, mailbox: 'INBOX',
    });

    const error = await fetchEmailLight(ACCOUNT, 7, 'INBOX', 'acct1', { background: true, intent: 'backfill' }).catch(e => e);

    expect(error).toBeInstanceOf(LimitReachedError);
    expect(error.limitReached).toBe(true);
    expect(error.limitBytes).toBe(2097152000);
    expect(error.resumeAfterMs).toBe(1773187200000);
    expect(error.uid).toBe(7);
    expect(error.mailbox).toBe('INBOX');
  });

  it('returns an ordinary reply untouched', async () => {
    mockSend.mockResolvedValue({ success: true, email: { uid: 7 }, cached: true });

    const email = await fetchEmailLight(ACCOUNT, 7, 'INBOX', 'acct1', { intent: 'backfill' });

    expect(email).toMatchObject({ uid: 7, vaultCached: true });
  });
});
