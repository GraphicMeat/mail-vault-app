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

const { getVerifiedRawSource, exportEmail } = await import('../emails.js');

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

// `.eml` export of a message the vault has no copy of (On Demand, evicted):
// the daemon's raw source comes from the server, but the light read is
// vault-only and answers null. The export must not hang on it.
describe('exportEmail', () => {
  beforeEach(() => mockInvoke.mockReset());

  const LOCAL_ID = '0123456789abcdef0123456789abcdef0123-INBOX-4';

  it('exports the raw source when the vault holds no light row', async () => {
    const raw = rawWith(ROW_ID);
    mockInvoke.mockImplementation(async (cmd) => (cmd === 'maildir_read_raw_source' ? raw : null));

    const out = await exportEmail(LOCAL_ID);

    expect(out?.rawBase64).toBe(raw);
    expect(out?.filename).toMatch(/\.eml$/);
  });

  it('names the file after the row subject when the vault holds no light row', async () => {
    const raw = rawWith(ROW_ID);
    mockInvoke.mockImplementation(async (cmd) => (cmd === 'maildir_read_raw_source' ? raw : null));

    expect((await exportEmail(LOCAL_ID, 'Quarterly report'))?.filename).toBe('Quarterly_report.eml');
  });

  it('names the file after the subject when the vault has the message', async () => {
    const raw = rawWith(ROW_ID);
    mockInvoke.mockImplementation(async (cmd) => (cmd === 'maildir_read_raw_source' ? raw : { subject: 'Hello there' }));

    expect((await exportEmail(LOCAL_ID))?.filename).toBe('Hello_there.eml');
  });

  it('is null when there are no bytes anywhere', async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'maildir_read_raw_source') throw new Error('Email UID 4 not found');
      return null;
    });

    expect(await exportEmail(LOCAL_ID)).toBeNull();
  });
});
