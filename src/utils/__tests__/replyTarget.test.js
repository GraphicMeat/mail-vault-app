import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveMessageBody = vi.fn();
vi.mock('../../services/export/bodyResolver', () => ({
  resolveMessageBody: (...args) => resolveMessageBody(...args),
}));

import { replyTarget } from '../replyTarget';

// What a reply quotes: the loaded copy when the caller has it, else the header
// merged with what the resolver finds, else the header alone — never a refusal.
describe('replyTarget', () => {
  const header = { uid: 7, subject: 'Hi', from: { address: 'ann@example.com' }, _accountId: 'acct-1' };
  const store = { activeAccountId: 'acct-1' };

  beforeEach(() => { resolveMessageBody.mockClear(); resolveMessageBody.mockResolvedValue({ ok: false }); });

  it('hands back the loaded copy untouched and asks the resolver nothing', async () => {
    const loaded = { ...header, html: '<p>loaded</p>' };
    expect(await replyTarget(header, loaded, store)).toBe(loaded);
    expect(resolveMessageBody).not.toHaveBeenCalled();
  });

  it('keeps a selection captured before body loading with the resolved reply target', async () => {
    resolveMessageBody.mockResolvedValue({ ok: true, email: { html: '<p>fetched</p>' } });

    await expect(replyTarget(header, null, store, 'selected<br>lines')).resolves.toEqual({
      ...header, html: '<p>fetched</p>', _selectedQuoteHtml: 'selected<br>lines',
    });
  });

  it('merges the resolved body over the header when nothing is loaded yet', async () => {
    resolveMessageBody.mockResolvedValue({ ok: true, email: { html: '<p>fetched</p>' } });
    const target = await replyTarget(header, null, store);
    expect(resolveMessageBody).toHaveBeenCalledWith(header, store);
    expect(target).toEqual({ ...header, html: '<p>fetched</p>' });
  });

  it('keeps the header where the resolved copy is silent', async () => {
    resolveMessageBody.mockResolvedValue({ ok: true, email: { html: '<p>x</p>' } });
    expect((await replyTarget(header, null, store))._accountId).toBe('acct-1');
  });

  it('hands the header back when the resolver answers no', async () => {
    expect(await replyTarget(header, null, store)).toBe(header);
  });

  it('hands the header back when the resolver throws', async () => {
    resolveMessageBody.mockRejectedValue(new Error('offline'));
    expect(await replyTarget(header, null, store)).toBe(header);
  });
});

// Download modes (H5): a reader shows the index snippet, marked `_bodyLoading`,
// while a body downloads. That text is not the message: a reply or forward
// made then must never quote or send it.
describe('replyTarget on a snippet stand-in', () => {
  const header = { uid: 7, subject: 'Hi', from: { address: 'ann@example.com' }, _accountId: 'acct-1' };
  const snippet = { ...header, text: 'First line of the', _bodyLoading: true };
  const store = { activeAccountId: 'acct-1' };

  beforeEach(() => { resolveMessageBody.mockReset(); });

  it('resolves the real body, with its attachments, instead of quoting the snippet', async () => {
    const attachments = [{ filename: 'report.pdf', size: 10 }];
    resolveMessageBody.mockResolvedValue({ ok: true, email: { text: 'First line of the whole message.', attachments } });
    const target = await replyTarget(snippet, null, store);
    expect(resolveMessageBody).toHaveBeenCalledWith(header, store);
    expect(target).toEqual({ ...header, text: 'First line of the whole message.', attachments });
    expect(target._bodyLoading).toBeUndefined();
  });

  it('never falls back to the snippet when the body cannot be resolved', async () => {
    resolveMessageBody.mockResolvedValue({ ok: false });
    const target = await replyTarget(snippet, null, store);
    expect(target).toEqual(header);
  });

  it('treats a snippet handed over as `loaded` as nothing loaded', async () => {
    resolveMessageBody.mockResolvedValue({ ok: true, email: { html: '<p>whole</p>' } });
    const target = await replyTarget(header, snippet, store);
    expect(target.html).toBe('<p>whole</p>');
    expect(target.text).toBeUndefined();
  });
});

describe('withoutSnippet', () => {
  it('drops the snippet text and marker, and leaves a real body alone', async () => {
    const { withoutSnippet } = await import('../withoutSnippet');
    const body = { uid: 1, text: 'whole' };
    expect(withoutSnippet(body)).toBe(body);
    expect(withoutSnippet({ uid: 1, text: 'part', _bodyLoading: true })).toEqual({ uid: 1 });
    expect(withoutSnippet(null)).toBe(null);
  });
});
