// @vitest-environment jsdom
//
// The scan cache stores each message's rewritten body and its alert list. It
// was keyed on the bare UID, which is unique per MAILBOX — so the next message
// to carry UID 41 (another folder, another account) was handed the first one's
// body, and the row tooltip listed the first one's links. Keys are now
// `accountId-mailbox-uid`, the shape selectEmail uses for its body cache.

import { describe, it, expect } from 'vitest';
import { scanEmailLinks, getCachedAlerts, getAlertsForEmails, classifyLink, isScannableHref } from '../linkSafety';

const INBOX_BODY = '<p>Body of the inbox message</p><a href="https://example.com/a">a</a>';
const SENT_BODY = '<p>Body of the sent message</p><a href="https://example.com/b">b</a>';
const PHISH_BODY = '<a href="https://evil.test/login">https://bank.test</a>';

const state = {
  activeAccountId: 'acct-1',
  activeMailbox: 'INBOX',
  getSentMailboxPath: () => 'Sent',
};

describe('scanEmailLinks', () => {
  it('gives each message its own body when two mailboxes share a UID', () => {
    const first = scanEmailLinks(INBOX_BODY, 'acct-1-INBOX-41');
    expect(first.modifiedBodyHtml).toContain('inbox message');

    const second = scanEmailLinks(SENT_BODY, 'acct-1-Sent-41');
    expect(second.modifiedBodyHtml).toContain('sent message');
    expect(second.modifiedBodyHtml).not.toContain('inbox message');

    // Both stay cached: they are different messages, not a replacement.
    expect(scanEmailLinks(INBOX_BODY, 'acct-1-INBOX-41')).toBe(first);
  });

  it('replaces the cached entry rather than bypassing it', () => {
    scanEmailLinks(INBOX_BODY, 'acct-1-INBOX-42');
    const second = scanEmailLinks('<a href="javascript:alert(1)">go</a>', 'acct-1-INBOX-42');
    expect(second.maxAlertLevel).toBe('red');
    // The row/tooltip lookup reads the cache by the same key: it must answer
    // with the alerts of the message now cached there, not the evicted one's.
    expect(getCachedAlerts('acct-1-INBOX-42')).toEqual(second.alerts);
  });

  it('still serves the same body from cache', () => {
    const first = scanEmailLinks(INBOX_BODY, 'acct-1-INBOX-43');
    // Identity, not equality: a rescan would build a new object, which is the
    // difference between a cache and a no-op.
    expect(scanEmailLinks(INBOX_BODY, 'acct-1-INBOX-43')).toBe(first);
  });

  it('flags a link whose text and href disagree', () => {
    const scan = scanEmailLinks(PHISH_BODY, 'acct-1-INBOX-44');
    expect(scan.maxAlertLevel).toBe('red');
    expect(scan.modifiedBodyHtml).toContain('data-link-alert="red"');
  });

  it('scans without caching when the message cannot be located', () => {
    const scan = scanEmailLinks(PHISH_BODY, null);
    expect(scan.maxAlertLevel).toBe('red');
    expect(getCachedAlerts(null)).toBeNull();
  });
});

describe('getCachedAlerts', () => {
  it('does not hand account A\'s links to account B\'s message with the same UID', () => {
    scanEmailLinks(PHISH_BODY, 'acct-1-INBOX-41');
    expect(getCachedAlerts('acct-1-INBOX-41')).toHaveLength(1);
    // Same UID, different account: nothing has been scanned for it.
    expect(getCachedAlerts('acct-2-INBOX-41')).toBeNull();
  });
});

describe('getAlertsForEmails', () => {
  it('resolves each row through the view state instead of its bare UID', () => {
    scanEmailLinks(PHISH_BODY, 'acct-1-INBOX-77');

    // Untagged row of the active account → acct-1/INBOX → the cached alerts.
    expect(getAlertsForEmails([{ uid: 77 }], state)).toHaveLength(1);

    // Same UID carried by another account's row → no alerts at all.
    expect(getAlertsForEmails([{ uid: 77, _accountId: 'acct-2', _mailbox: 'INBOX' }], state)).toBeNull();

    // Same UID in the active account's Sent folder → also a different message.
    expect(getAlertsForEmails([{ uid: 77, _fromSentFolder: true }], state)).toBeNull();
  });
});

// The social card's links list classifies with the same rules as the reader's scan.
describe('classifyLink', () => {
  it('red for a script or data scheme, and for text that shows another site', () => {
    expect(classifyLink('javascript:x()', 'go')).toMatchObject({ level: 'red', reason: 'Link uses dangerous javascript: scheme' });
    expect(classifyLink('data:text/html,hi', '')).toMatchObject({ level: 'red' });
    expect(classifyLink('https://evil.test/login', 'https://bank.test')).toMatchObject({
      level: 'red', textDomain: 'bank.test', actualDomain: 'evil.test', reason: 'Link text shows bank.test but goes to evil.test',
    });
  });

  it('yellow for a redirect through another site, but not through an allowlisted shortener', () => {
    expect(classifyLink('https://track.test/r?url=https%3A%2F%2Fother.test%2F', 'Offer')).toMatchObject({
      level: 'yellow', reason: 'Link redirects through track.test to other.test',
    });
    expect(classifyLink('https://bit.ly/r?url=https%3A%2F%2Fother.test%2F', 'Offer').level).toBeNull();
  });

  it('no level for an ordinary link', () => {
    expect(classifyLink('https://fine.test/a', 'A nice page')).toMatchObject({ level: null, reason: '' });
  });

  it('agrees with what the scan alerts on', () => {
    const body = '<a href="https://evil.test/login">https://bank.test</a><a href="https://fine.test/a">ok</a>';
    expect(scanEmailLinks(body, null).alerts.map(a => a.level)).toEqual(['red']);
    expect(classifyLink('https://evil.test/login', 'https://bank.test').level).toBe('red');
  });
});

describe('isScannableHref', () => {
  it('web addresses and script/data schemes only', () => {
    for (const href of ['https://a.test', 'http://a.test', 'javascript:x()', 'data:text/html,x']) expect(isScannableHref(href), href).toBe(true);
    for (const href of ['', '#top', 'cid:img', 'mailto:a@b.test', 'tel:+1', '/relative', 'page.html']) expect(isScannableHref(href), href).toBe(false);
  });
});
