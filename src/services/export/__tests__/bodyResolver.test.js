import { describe, it, expect, vi, beforeEach } from 'vitest';

const getLocalEmailLight = vi.fn();
const fetchEmailLight = vi.fn();
const graphGetMessage = vi.fn();
const hydrateInlineImages = vi.fn(async (email) => email);
const getGraphMessageId = vi.fn(() => 'graph-id-1');
const graphMessageToEmail = vi.fn((msg, uid) => ({ ...msg, uid }));

vi.mock('../../db', () => ({ getLocalEmailLight: (...a) => getLocalEmailLight(...a) }));
vi.mock('../../api', () => ({
  fetchEmailLight: (...a) => fetchEmailLight(...a),
  graphGetMessage: (...a) => graphGetMessage(...a),
  graphCacheMime: vi.fn(async () => {}),
}));
vi.mock('../../authUtils', () => ({ ensureFreshToken: async (a) => a }));
vi.mock('../../attachmentUtils', () => ({ hydrateInlineImages: (...a) => hydrateInlineImages(...a) }));
vi.mock('../../../stores/mailStore', () => ({
  getGraphMessageId: (...a) => getGraphMessageId(...a),
  graphMessageToEmail: (...a) => graphMessageToEmail(...a),
}));
// importOriginal keeps the real bodyMatchesHeader: bodyResolver reuses the
// helper the reading pane already uses, and a factory that lists only
// resolveEmailLocation would hand it `undefined`.
vi.mock('../../../stores/slices/unifiedHelpers', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveEmailLocation: (email) => (email.uid === 99 ? null : { accountId: 'acct-1', mailbox: 'INBOX' }),
}));

const { resolveMessageBody } = await import('../bodyResolver');

const header = { uid: 42, messageId: '<right@x>', subject: 'Root', from: 'a@x.test' };
const store = { accounts: [{ id: 'acct-1' }], getFromCache: () => null };
const graphStore = { accounts: [{ id: 'acct-1', oauth2Transport: 'graph', oauth2AccessToken: 'tok' }] };

beforeEach(() => {
  getLocalEmailLight.mockReset();
  fetchEmailLight.mockReset();
  graphGetMessage.mockReset();
  hydrateInlineImages.mockClear();
});

describe('resolveMessageBody', () => {
  it('returns the vault copy when it answers for this header', async () => {
    getLocalEmailLight.mockResolvedValue({ uid: 42, messageId: '<right@x>', html: '<p>vault</p>' });
    const out = await resolveMessageBody(header, store);
    expect(out.ok).toBe(true);
    expect(out.email.html).toBe('<p>vault</p>');
    expect(fetchEmailLight).not.toHaveBeenCalled();
  });

  it('asks the server when the vault copy belongs to another message', async () => {
    getLocalEmailLight.mockResolvedValue({ uid: 42, messageId: '<wrong@x>', html: '<p>someone else</p>' });
    fetchEmailLight.mockResolvedValue({ uid: 42, messageId: '<right@x>', html: '<p>server</p>' });
    const out = await resolveMessageBody(header, store);
    expect(fetchEmailLight).toHaveBeenCalled();
    expect(out.email.html).toBe('<p>server</p>');
  });

  it('refuses a server answer that contradicts the header', async () => {
    getLocalEmailLight.mockResolvedValue(null);
    fetchEmailLight.mockResolvedValue({ uid: 42, messageId: '<wrong@x>', html: '<p>wrong message</p>' });
    const out = await resolveMessageBody(header, store);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/mismatch/i);
  });

  it('refuses to guess when the location is unknown', async () => {
    const out = await resolveMessageBody({ ...header, uid: 99 }, store);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/location/i);
    expect(getLocalEmailLight).not.toHaveBeenCalled();
  });

  it('reports the failure rather than throwing when both sources fail', async () => {
    getLocalEmailLight.mockRejectedValue(new Error('disk gone'));
    fetchEmailLight.mockRejectedValue(new Error('offline'));
    const out = await resolveMessageBody(header, store);
    expect(out.ok).toBe(false);
    expect(out.reason).toBeTruthy();
  });

  // A helper that knows only the IMAP path returns an empty body for every
  // Graph account instead of failing loudly, so the branch is asserted here
  // rather than discovered by an Outlook user.
  it('goes through Graph for a Graph account instead of fetchEmailLight', async () => {
    getLocalEmailLight.mockResolvedValue(null);
    graphGetMessage.mockResolvedValue({ messageId: '<right@x>', html: '<p>graph</p>' });
    const out = await resolveMessageBody(header, graphStore);
    expect(graphGetMessage).toHaveBeenCalled();
    expect(fetchEmailLight).not.toHaveBeenCalled();
    expect(out.ok).toBe(true);
    expect(out.email.html).toBe('<p>graph</p>');
  });

  it('hydrates inline images before handing the body back', async () => {
    getLocalEmailLight.mockResolvedValue({ uid: 42, messageId: '<right@x>', html: '<p>vault</p>' });
    await resolveMessageBody(header, store);
    expect(hydrateInlineImages).toHaveBeenCalledWith(
      expect.objectContaining({ html: '<p>vault</p>' }), 'acct-1', 'INBOX',
    );
  });
});
