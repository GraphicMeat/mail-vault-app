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
  const buildQuote = () => ({ quotedHtml: '<p>quoted</p>', contextHtml: '<p>context</p>' });
  const fillState = { mode: 'reply', replyTo: resolved, _fillFrom: header };

  it('leaves the windows unchanged when nothing matches (sent, discarded or closed)', () => {
    const windows = [{ id: 1, mode: 'reply', replyTo: { ...header, uid: 99 }, minimized: false }];
    expect(applyReplyFill(windows, fillState, buildQuote)).toBe(windows);
    expect(applyReplyFill([], fillState, buildQuote)).toEqual([]);
  });

  it('patches replyTo on the live window it was opened for, without opening or focusing anything', () => {
    const windows = [{ id: 1, mode: 'reply', replyTo: header, minimized: false }];
    const result = applyReplyFill(windows, fillState, buildQuote);
    expect(result).toEqual([{ id: 1, mode: 'reply', replyTo: resolved, minimized: false }]);
  });

  it('never un-minimizes a minimized window, and patches the quote into its snapshot instead', () => {
    const build = vi.fn(buildQuote);
    const windows = [{
      id: 1, mode: 'reply', replyTo: header, minimized: true,
      snapshot: { body: 'typed reply', _quotedHtml: '' },
      initialData: { body: 'typed reply', _quotedHtml: '' },
    }];
    const result = applyReplyFill(windows, fillState, build);
    expect(result[0].minimized).toBe(true);
    expect(result[0].replyTo).toBe(resolved);
    expect(result[0].snapshot).toEqual({ body: 'typed reply', _quotedHtml: '<p>quoted</p>', _contextHtml: '<p>context</p>' });
    expect(result[0].initialData).toEqual({ body: 'typed reply', _quotedHtml: '<p>quoted</p>', _contextHtml: '<p>context</p>' });
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('never patches a detached native window', () => {
    const windows = [{ id: 1, mode: 'reply', replyTo: header, minimized: false, detached: true, nativeLabel: 'compose-1' }];
    expect(applyReplyFill(windows, fillState, buildQuote)).toBe(windows);
  });

  it('does not call buildQuote at all for a live (non-minimized) target', () => {
    const build = vi.fn(buildQuote);
    const windows = [{ id: 1, mode: 'reply', replyTo: header, minimized: false }];
    applyReplyFill(windows, fillState, build);
    expect(build).not.toHaveBeenCalled();
  });
});
