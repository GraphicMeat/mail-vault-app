// @vitest-environment jsdom
//
// The scan cache stores each message's rewritten body. It was keyed on the
// bare UID, which is unique per MAILBOX — so the next message to carry UID 41
// (another folder, another account) was handed the first one's body and the
// viewer rendered it under the right header.

import { describe, it, expect } from 'vitest';
import { scanEmailLinks, getCachedAlerts } from '../linkSafety';

const INBOX_BODY = '<p>Body of the inbox message</p><a href="https://example.com/a">a</a>';
const SENT_BODY = '<p>Body of the sent message</p><a href="https://example.com/b">b</a>';

describe('scanEmailLinks', () => {
  it('gives each message its own body when two mailboxes share a UID', () => {
    const first = scanEmailLinks(INBOX_BODY, 41);
    expect(first.modifiedBodyHtml).toContain('inbox message');

    const second = scanEmailLinks(SENT_BODY, 41);
    expect(second.modifiedBodyHtml).toContain('sent message');
    expect(second.modifiedBodyHtml).not.toContain('inbox message');
  });

  it('replaces the cached entry rather than bypassing it', () => {
    scanEmailLinks(INBOX_BODY, 42);
    const second = scanEmailLinks('<a href="javascript:alert(1)">go</a>', 42);
    expect(second.maxAlertLevel).toBe('red');
    // The row/tooltip lookup reads the cache by UID too: it must answer with
    // the alerts of the message now cached there, not the evicted one's.
    expect(getCachedAlerts(42)).toEqual(second.alerts);
  });

  it('still serves the same body from cache', () => {
    const first = scanEmailLinks(INBOX_BODY, 43);
    // Identity, not equality: a rescan would build a new object, which is the
    // difference between a cache and a no-op.
    expect(scanEmailLinks(INBOX_BODY, 43)).toBe(first);
  });

  it('flags a link whose text and href disagree', () => {
    const scan = scanEmailLinks('<a href="https://evil.test/login">https://bank.test</a>', 44);
    expect(scan.maxAlertLevel).toBe('red');
    expect(scan.modifiedBodyHtml).toContain('data-link-alert="red"');
  });
});
