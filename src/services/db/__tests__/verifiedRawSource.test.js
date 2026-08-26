// "View Source" hands the reader the vault file verbatim. The vault is keyed
// (accountId, mailbox, uid) with no per-file generation proof, so after a
// UIDVALIDITY reissue that file is another message — and the panel presented it
// under this row's header, complete with someone else's Return-Path and body.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInvoke = vi.fn();

vi.mock('../../transport.js', () => ({ send: (...a) => mockInvoke(...a) }));
vi.mock('../accounts.js', () => ({
  initDB: vi.fn().mockResolvedValue(undefined),
  initBasic: vi.fn().mockResolvedValue(undefined),
  accountDir: () => '',
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: vi.fn(), exists: vi.fn(), BaseDirectory: {},
}));

const { getVerifiedRawSource } = await import('../emails.js');

const b64 = (s) => Buffer.from(s, 'binary').toString('base64');

const rawWith = (messageId, body = 'hello') =>
  b64([
    'Return-Path: <bounces@example.net>',
    'From: "StrictSeal" <strictseal@hotmail.com>',
    'Subject: Your product is now live on StrictSeal',
    `Message-Id: ${messageId}`,
    '',
    body,
  ].join('\r\n'));

const ROW_ID = '<4GX4VJ7EJKN_6a8f0d4c87839_82d252d96f43b4_sprut@zendesk.com>';

describe('getVerifiedRawSource', () => {
  beforeEach(() => mockInvoke.mockReset());

  it('refuses a vault file whose Message-ID contradicts the row', async () => {
    mockInvoke.mockResolvedValue(rawWith('<202603192236.72893218187@smtp-relay.mailin.fr>'));

    const { b64: out, error } = await getVerifiedRawSource('acc1', 'INBOX', 4, { messageId: ROW_ID });

    expect(out).toBeNull();
    expect(error).toMatch(/different message/i);
  });

  it('returns the file when it is this message', async () => {
    const raw = rawWith(ROW_ID);
    mockInvoke.mockResolvedValue(raw);

    const { b64: out, error } = await getVerifiedRawSource('acc1', 'INBOX', 4, { messageId: ROW_ID });

    expect(out).toBe(raw);
    expect(error).toBeNull();
  });

  it('ignores brackets — an unbracketed id is the same id', async () => {
    mockInvoke.mockResolvedValue(rawWith(ROW_ID.slice(1, -1)));

    const { error } = await getVerifiedRawSource('acc1', 'INBOX', 4, { messageId: ROW_ID });

    expect(error).toBeNull();
  });

  it('reads the header block only — a quoted parent id is not this message', async () => {
    mockInvoke.mockResolvedValue(
      rawWith(ROW_ID, 'On Tue someone wrote:\r\nMessage-Id: <202603192236.7289@smtp-relay.mailin.fr>')
    );

    const { error } = await getVerifiedRawSource('acc1', 'INBOX', 4, { messageId: ROW_ID });

    expect(error).toBeNull();
  });

  it('lets a missing id through — absence proves nothing', async () => {
    mockInvoke.mockResolvedValue(b64('From: a@b.c\r\nSubject: no id\r\n\r\nbody'));

    const { b64: out, error } = await getVerifiedRawSource('acc1', 'INBOX', 4, { messageId: ROW_ID });

    expect(out).toBeTruthy();
    expect(error).toBeNull();
  });
});
