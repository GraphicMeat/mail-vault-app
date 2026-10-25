import { describe, it, expect, vi } from 'vitest';
import { sameReply, applyReplyFill } from '../sameReply';

// One window per (message, mode): a second Reply to the message already open
// comes forward instead of stacking — the full-width header is a compose
// trigger now, and a double-click would otherwise open two.
describe('sameReply', () => {
  const msg = { uid: 7, messageId: '<a@x>', _accountId: 'acct-1', _mailbox: 'INBOX' };

  it('matches the same message in the same mode', () => {
    expect(sameReply({ mode: 'reply', replyTo: msg }, { mode: 'reply', replyTo: { ...msg } })).toBe(true);
  });

  it('a different mode is a different window', () => {
    expect(sameReply({ mode: 'reply', replyTo: msg }, { mode: 'forward', replyTo: msg })).toBe(false);
  });

  it('tells messages apart by Message-ID before uid', () => {
    expect(sameReply({ mode: 'reply', replyTo: msg }, { mode: 'reply', replyTo: { ...msg, messageId: '<b@x>' } })).toBe(false);
  });

  it('without a Message-ID the same uid in another account or folder is another message', () => {
    const bare = { uid: 7, _accountId: 'acct-1', _mailbox: 'INBOX' };
    expect(sameReply({ mode: 'reply', replyTo: bare }, { mode: 'reply', replyTo: { ...bare } })).toBe(true);
    expect(sameReply({ mode: 'reply', replyTo: bare }, { mode: 'reply', replyTo: { ...bare, _accountId: 'acct-2' } })).toBe(false);
    expect(sameReply({ mode: 'reply', replyTo: bare }, { mode: 'reply', replyTo: { ...bare, _mailbox: 'Sent' } })).toBe(false);
  });

  it('a new or prefilled compose never matches anything', () => {
    expect(sameReply({ initialData: { to: 'a@x' } }, { initialData: { to: 'a@x' } })).toBe(false);
    expect(sameReply({ mode: 'reply', replyTo: msg }, { initialData: { to: 'a@x' } })).toBe(false);
  });
});

// A radial reply opens on the header, then calls back once its body
// resolves. That second call must only ever patch the window it was opened
// for — never reopen one the user closed, sent or minimized in the meantime.
describe('applyReplyFill', () => {
  const header = { uid: 7, _accountId: 'acct-1', _mailbox: 'INBOX' };
  const resolved = { ...header, html: '<p>Hi</p>' };
  const prepared = { source: resolved, result: { quotedHtml: '<p>quoted</p>', contextHtml: '<p>context</p>', bodyAvailable: true } };
  const fillState = { mode: 'reply', replyTo: resolved, _fillFrom: header };

  it('leaves the windows unchanged when nothing matches (sent, discarded or closed)', () => {
    const windows = [{ id: 1, mode: 'reply', replyTo: { ...header, uid: 99 }, minimized: false }];
    expect(applyReplyFill(windows, fillState, prepared)).toBe(windows);
    expect(applyReplyFill([], fillState, prepared)).toEqual([]);
  });

  it('patches replyTo on the live window it was opened for, without opening or focusing anything', () => {
    const windows = [{ id: 1, mode: 'reply', replyTo: header, minimized: false }];
    const result = applyReplyFill(windows, fillState, prepared);
    expect(result).toEqual([{ id: 1, mode: 'reply', replyTo: resolved, minimized: false, preparedQuote: prepared }]);
  });

  it('never un-minimizes a minimized window, and patches the quote into its snapshot instead', () => {
    const windows = [{
      id: 1, mode: 'reply', replyTo: header, minimized: true,
      snapshot: { body: 'typed reply', _quotedHtml: '' },
      initialData: { body: 'typed reply', _quotedHtml: '' },
    }];
    const result = applyReplyFill(windows, fillState, prepared);
    expect(result[0].minimized).toBe(true);
    expect(result[0].replyTo).toBe(resolved);
    expect(result[0].snapshot).toEqual({ body: 'typed reply', _quotedHtml: '<p>quoted</p>', _contextHtml: '<p>context</p>' });
    expect(result[0].initialData).toEqual({ body: 'typed reply', _quotedHtml: '<p>quoted</p>', _contextHtml: '<p>context</p>' });
  });

  it('never patches a detached native window', () => {
    const windows = [{ id: 1, mode: 'reply', replyTo: header, minimized: false, detached: true, nativeLabel: 'compose-1' }];
    expect(applyReplyFill(windows, fillState, prepared)).toBe(windows);
  });

  it('hands the prepared fill to a live target without recomputing policy', () => {
    const windows = [{ id: 1, mode: 'reply', replyTo: header, minimized: false }];
    applyReplyFill(windows, fillState, prepared);
    expect(applyReplyFill(windows, fillState, prepared)[0].preparedQuote).toBe(prepared);
  });
});

it('refuses a replaced fill window even if its original header still matches', () => {
  const header = { uid: 7, _accountId: 'acct-1', _mailbox: 'INBOX' };
  const windows = [{ id: 2, mode: 'reply', replyTo: header, minimized: true, snapshot: { body: 'new draft' } }];
  expect(applyReplyFill(windows, { mode: 'reply', replyTo: { ...header, html: 'late' }, _fillFrom: header, _fillWindowId: 1 }, () => ({ quotedHtml: 'late', contextHtml: 'late' }))).toBe(windows);
});

it('keeps latest minimized authored fields and immutable issued bytes when a complete prepared quote lands', async () => {
  const { prepareDemoCompose } = await import('../../demo/composePrep');
  const header = { uid: 8, _accountId: 'one', _mailbox: 'INBOX' };
  const html = '界'.repeat(750000) + 'FINAL';
  const result = prepareDemoCompose({ kind: 'message', requestId: 'large', mode: 'reply', accountId: 'one', original: { header: { from: { address: 'sender@example.test' } }, html }, presentation: { originalLabel: 'Original', dateLabel: 'today', subjectCandidate: 'Re: test' }, threadContext: Array.from({ length: 70 }, (_, i) => ({ original: { header: {}, html: `<p>${i}</p>` }, dateLabel: `${i}` })) }, { accounts: [{ id: 'one', email: 'me@example.test' }], values: {}, version: 1 });
  const data = { to: 'typed@example.test', bcc: 'authored@example.test', subject: 'Typed', body: '<p>Template edited</p>', _accountId: 'other', _fromAddress: 'alias@example.test', _baseline: { body: 'before edit' }, _draftId: 'stable', _draftRevision: 9, _draftContent: { revision: 9, snapshot: { html: 'old immutable bytes' } } };
  const windows = [{ id: 8, mode: 'reply', replyTo: header, minimized: true, snapshot: data, initialData: data }];
  const resolved = { ...header, html };
  const filled = applyReplyFill(windows, { mode: 'reply', replyTo: resolved, _fillFrom: header, _fillWindowId: 8 }, { source: resolved, result });
  expect(filled[0].snapshot).toEqual({ ...data, _quotedHtml: result.quotedHtml, _contextHtml: result.contextHtml });
  expect(filled[0].snapshot._draftContent).toBe(data._draftContent);
  expect(filled[0].snapshot._quotedHtml.endsWith(html)).toBe(true); expect(filled[0].snapshot._contextHtml).toContain('<p>69</p>');
  for (const terminal of [{ _draftTerminal: 'sent' }, { _draftCleanupOnly: true }]) {
    const stopped = [{ ...windows[0], snapshot: { ...data, ...terminal } }];
    expect(applyReplyFill(stopped, { mode: 'reply', replyTo: resolved, _fillFrom: header, _fillWindowId: 8 }, { result })).toBe(stopped);
  }
});
