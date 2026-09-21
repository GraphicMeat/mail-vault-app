/**
 * The two body-fetch RPCs discover the same fact in two shapes.
 *
 * `imap_get_email_light` answers `{success:false, gone:true}`; `imap_get_email`
 * answers with an RPC ERROR whose message carries the `E_UID_GONE:` prefix
 * (handlers/imap.rs). The prefix is the wire format and stays — it is a live
 * i18n catalog key (`errors.E_UID_GONE`, nine locales) and both the daemon and
 * the Tauri proxy pin it in their own tests — so the reconciliation happens
 * here: `fetchEmail` reads it and throws the same `MessageGoneError` that
 * `fetchEmailLight` throws, which is what lets a caller prune a stale row
 * instead of showing a failure with nothing to retry.
 *
 * The negative matters as much: a body fetch that merely failed proves nothing
 * about the server, and must not come back wearing a proof.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSend = vi.fn();
vi.mock('../transport.js', () => ({ send: (...a) => mockSend(...a) }));
vi.mock('../../i18n/index.js', () => ({ t: (k) => k }));

globalThis.window = globalThis.window || {};
globalThis.window.__TAURI__ = { core: { invoke: () => {} } };

const { fetchEmail, MessageGoneError } = await import('../api.js');

const ACCOUNT = { id: 'acct1', email: 'luke@mock.test' };

beforeEach(() => vi.clearAllMocks());

describe('fetchEmail on the daemon E_UID_GONE reply', () => {
  it('throws the same MessageGoneError the light path throws', async () => {
    mockSend.mockRejectedValue(new Error('E_UID_GONE: Message UID 30 is no longer in INBOX'));

    const error = await fetchEmail(ACCOUNT, 30, 'INBOX').catch(e => e);

    expect(error).toBeInstanceOf(MessageGoneError);
    expect(error.messageGone).toBe(true);
    expect(error.uid).toBe(30);
    expect(error.mailbox).toBe('INBOX');
  });

  it('reads a rejection that arrives as a bare string too', async () => {
    // transport/daemonClient normalise most of these, but a Tauri `Err(String)`
    // reaching this layer unwrapped is one `.message` away from silently
    // failing the match — and the guard would then never fire in production
    // while every mocked test still passed.
    mockSend.mockRejectedValue('E_UID_GONE: Message UID 7 is no longer in Archive');

    const error = await fetchEmail(ACCOUNT, 7, 'Archive').catch(e => e);

    expect(error.messageGone).toBe(true);
    expect(error.uid).toBe(7);
    expect(error.mailbox).toBe('Archive');
  });

  it('carries the prefix nowhere: the message is the readable half only', async () => {
    mockSend.mockRejectedValue(new Error('E_UID_GONE: Message UID 30 is no longer in INBOX'));

    const error = await fetchEmail(ACCOUNT, 30, 'INBOX').catch(e => e);

    expect(error.message).not.toContain('E_UID_GONE');
    expect(error.message).toBe('Message UID 30 is no longer in INBOX');
  });
});

describe('fetchEmail on every other failure', () => {
  it('passes an ordinary failure through untouched', async () => {
    mockSend.mockRejectedValue(new Error('Connection lost for luke@mock.test while fetching UID 30'));

    const error = await fetchEmail(ACCOUNT, 30, 'INBOX').catch(e => e);

    expect(error.messageGone).toBeUndefined();
    expect(error.message).toContain('Connection lost');
  });

  it('does not match the token in the middle of some other message', async () => {
    mockSend.mockRejectedValue(new Error('Failed to fetch email: E_UID_GONE: was in the log'));

    const error = await fetchEmail(ACCOUNT, 30, 'INBOX').catch(e => e);

    expect(error.messageGone).toBeUndefined();
  });

  it('returns the email untouched when the fetch succeeds', async () => {
    mockSend.mockResolvedValue({ email: { uid: 30, subject: 'Luke message 30' } });

    await expect(fetchEmail(ACCOUNT, 30, 'INBOX')).resolves.toEqual({ uid: 30, subject: 'Luke message 30' });
  });
});
