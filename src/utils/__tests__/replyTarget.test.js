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

// App's setComposeState runs every compose hand-off through this, so the `f`
// shortcut, the reply fallbacks and other views never open on a snippet.
describe('composeStateWithBody', () => {
  it('replaces a snippet stand-in with the resolved body and attachments', async () => {
    const { composeStateWithBody } = await import('../replyTarget');
    const attachments = [{ filename: 'agenda.pdf', size: 10 }];
    resolveMessageBody.mockReset().mockResolvedValue({ ok: true, email: { text: 'The whole message.', attachments } });
    const snippet = { uid: 7, subject: 'Hi', text: 'The whole', _bodyLoading: true };
    const state = await composeStateWithBody({ mode: 'forward', replyTo: snippet }, { accounts: [] });
    expect(state).toEqual({ mode: 'forward', replyTo: { uid: 7, subject: 'Hi', text: 'The whole message.', attachments } });
  });

  it('hands any other state back as it came, with no fetch', async () => {
    const { composeStateWithBody } = await import('../replyTarget');
    resolveMessageBody.mockReset();
    const loaded = { mode: 'reply', replyTo: { uid: 7, text: 'whole' } };
    expect(await composeStateWithBody(loaded, {})).toBe(loaded);
    expect(await composeStateWithBody({ initialData: {} }, {})).toEqual({ initialData: {} });
    expect(resolveMessageBody).not.toHaveBeenCalled();
  });
});

// App's setComposeState is exactly this: a snippet stand-in never reaches
// openCompose, only the state with the real body does.
describe('openComposeResolved', () => {
  it('opens compose only after the real body replaced a snippet stand-in', async () => {
    const { openComposeResolved } = await import('../replyTarget');
    resolveMessageBody.mockReset().mockResolvedValue({ ok: true, email: { html: '<p>The whole message.</p>' } });
    const openCompose = vi.fn();
    const snippet = { uid: 7, subject: 'Hi', text: 'The whole', _bodyLoading: true };
    const pending = openComposeResolved({ mode: 'reply', replyTo: snippet }, openCompose, { accounts: [] });
    expect(openCompose).not.toHaveBeenCalled();
    await pending;
    expect(openCompose).toHaveBeenCalledTimes(1);
    const [state] = openCompose.mock.calls[0];
    expect(state.replyTo).toEqual({ uid: 7, subject: 'Hi', html: '<p>The whole message.</p>' });
    expect(state.replyTo._bodyLoading).toBeUndefined();
    expect(state.replyTo.text).toBeUndefined();
  });

  it('opens any other state at once, as it came, with no fetch', async () => {
    const { openComposeResolved } = await import('../replyTarget');
    resolveMessageBody.mockReset();
    const openCompose = vi.fn();
    const loaded = { mode: 'forward', replyTo: { uid: 7, text: 'whole' } };
    openComposeResolved(loaded, openCompose, {});
    expect(openCompose).toHaveBeenCalledWith(loaded);
    expect(resolveMessageBody).not.toHaveBeenCalled();
  });
});
