// @vitest-environment jsdom
//
// Tracking pixel detection and removal.
//
// Two failure modes matter more than coverage of the vendor list:
//   1. A false positive strips a real picture out of someone's mail. Every
//      "detects X" case below is paired with a negative control.
//   2. A verdict lands on the wrong message. The cache is keyed by
//      `accountId-mailbox-uid` for the same reason linkSafety's is — a bare
//      UID is unique inside ONE mailbox only.

import { describe, it, expect } from 'vitest';
import { scanTrackers, getCachedTrackers, summarizeTrackers } from '../trackerDetect';
import { TRACKER_PATTERNS, CURATED_PATTERNS, UGLY_EMAIL_PATTERNS, MTB_PATTERNS } from '../trackerList';

const REAL_IMAGE = '<p>Hi</p><img src="https://cdn.example.com/logo.png" width="200" height="60" alt="logo">';

describe('scanTrackers — vendor endpoints', () => {
  it('names the vendor behind a Mailchimp open beacon', () => {
    const html = `<p>Hi</p><img src="https://example.list-manage.com/track/open.php?u=8f2&id=a91" width="1" height="1">`;
    const { trackers, count } = scanTrackers(html, null);
    expect(count).toBe(1);
    expect(trackers[0].vendor).toBe('Mailchimp');
    expect(trackers[0].known).toBe(true);
    expect(trackers[0].domain).toBe('example.list-manage.com');
  });

  it('catches a SendGrid beacon that declares an honest size', () => {
    // Shape heuristics would miss this one — the vendor pass is what fires.
    const html = `<img src="https://u123.wl.sendgrid.net/wf/open?upn=abc" width="20" height="20">`;
    const { trackers } = scanTrackers(html, null);
    expect(trackers).toHaveLength(1);
    expect(trackers[0].vendor).toBe('SendGrid');
  });

  it('leaves an ordinary hosted image alone', () => {
    const { trackers, cleanedBodyHtml } = scanTrackers(REAL_IMAGE, null);
    expect(trackers).toHaveLength(0);
    // Byte-identical: an unchanged body must not churn the iframe's srcDoc.
    expect(cleanedBodyHtml).toBe(REAL_IMAGE);
  });
});

describe('scanTrackers — shape heuristics', () => {
  it('flags a 1×1 image from an unknown host', () => {
    const html = `<img src="https://metrics.unknown-vendor.test/i.gif?e=you" width="1" height="1">`;
    const { trackers } = scanTrackers(html, null);
    expect(trackers).toHaveLength(1);
    expect(trackers[0].known).toBe(false);
    expect(trackers[0].vendor).toBe('metrics.unknown-vendor.test');
    expect(trackers[0].reason).toMatch(/1×1/);
  });

  it('flags an image hidden with CSS even at a normal declared size', () => {
    const html = `<img src="https://beacons.unknown.test/i.png" width="100" height="100" style="display:none">`;
    expect(scanTrackers(html, null).trackers).toHaveLength(1);
  });

  it('flags an image hidden by its container', () => {
    const html = `<div style="display:none;max-height:0"><img src="https://beacons.unknown.test/x.png" width="80" height="80"></div>`;
    expect(scanTrackers(html, null).trackers).toHaveLength(1);
  });

  it('does not flag a small-but-visible icon', () => {
    // 16×16 is a bullet or a social icon, not a beacon. Negative control for
    // the size rule: the threshold has to stay at "invisible", not "small".
    const html = `<img src="https://cdn.example.com/icon.png" width="16" height="16">`;
    expect(scanTrackers(html, null).trackers).toHaveLength(0);
  });

  it('leaves layout spacers alone, even at 1×1', () => {
    // A transparent spacer GIF has been 1×1 since the table-layout era.
    // Stripping one leaves a visible hole in the mail.
    const html = `<img src="https://cdn.example.com/img/spacer.gif" width="1" height="1">`
      + `<img src="https://cdn.example.com/img/transparent.gif" width="1" height="1">`;
    expect(scanTrackers(html, null).trackers).toHaveLength(0);
  });

  it('does not flag inline or embedded images', () => {
    const html = `<img src="cid:logo@example" width="1" height="1">`
      + `<img src="data:image/gif;base64,R0lGOD" width="1" height="1">`;
    expect(scanTrackers(html, null).trackers).toHaveLength(0);
  });

  it('flags a beacon by request path when nothing else gives it away', () => {
    const html = `<img src="https://mail.unknown.test/pixel/abc123.gif">`;
    const { trackers } = scanTrackers(html, null);
    expect(trackers).toHaveLength(1);
    expect(trackers[0].reason).toMatch(/open-tracking endpoint/);
  });
});

describe('scanTrackers — removal', () => {
  it('removes the beacon and leaves a marker in its place', () => {
    const html = `<p>Body</p><img src="https://example.list-manage.com/track/open.php?u=1" width="1" height="1">`;
    const { cleanedBodyHtml } = scanTrackers(html, null);
    expect(cleanedBodyHtml).not.toContain('list-manage.com');
    expect(cleanedBodyHtml).toContain('data-mv-tracker-blocked="Mailchimp"');
    // The rest of the mail survives the round trip.
    expect(cleanedBodyHtml).toContain('<p>Body</p>');
  });

  it('keeps the real images in a body that also carries a beacon', () => {
    const html = `${REAL_IMAGE}<img src="https://u1.wl.sendgrid.net/wf/open?upn=x" width="1" height="1">`;
    const { cleanedBodyHtml, count } = scanTrackers(html, null);
    expect(count).toBe(1);
    expect(cleanedBodyHtml).toContain('cdn.example.com/logo.png');
    expect(cleanedBodyHtml).not.toContain('sendgrid.net');
  });

  it('removes every beacon when a message carries several', () => {
    const html = `<img src="https://a.list-manage.com/track/open.php?u=1" width="1" height="1">`
      + `<img src="https://b.unknown.test/p.gif" width="1" height="1">`;
    const { count, cleanedBodyHtml } = scanTrackers(html, null);
    expect(count).toBe(2);
    expect(cleanedBodyHtml).not.toContain('list-manage');
    // The marker never carries the beacon's host, so nothing about where the
    // request would have gone survives in the document.
    expect(cleanedBodyHtml).not.toContain('b.unknown.test');
    expect(cleanedBodyHtml).toContain('data-mv-tracker-blocked="tracker"');
  });
});

describe('scanTrackers — cache scoping', () => {
  it('gives two mailboxes sharing a UID their own verdicts', () => {
    const tracked = `<img src="https://x.list-manage.com/track/open.php?u=1" width="1" height="1">`;
    const clean = '<p>Nothing to see</p>';

    const inbox = scanTrackers(tracked, 'acct-1-INBOX-41');
    const sent = scanTrackers(clean, 'acct-1-Sent-41');

    expect(inbox.count).toBe(1);
    expect(sent.count).toBe(0);
    expect(getCachedTrackers('acct-1-INBOX-41')).toHaveLength(1);
    expect(getCachedTrackers('acct-1-Sent-41')).toHaveLength(0);
    // A cache hit returns the same object rather than rescanning.
    expect(scanTrackers(tracked, 'acct-1-INBOX-41')).toBe(inbox);
  });

  it('rescans when the body under a key changes', () => {
    const key = 'acct-1-INBOX-77';
    scanTrackers('<p>first</p>', key);
    const second = scanTrackers('<img src="https://y.list-manage.com/track/open.php?u=2" width="1" height="1">', key);
    expect(second.count).toBe(1);
    expect(getCachedTrackers(key)).toHaveLength(1);
  });

  it('returns null cached trackers for a message that has no key', () => {
    expect(getCachedTrackers(null)).toBeNull();
  });
});

describe('summarizeTrackers', () => {
  it('collapses to a count and a de-duplicated vendor list', () => {
    const summary = summarizeTrackers([
      { vendor: 'MailChimp' }, { vendor: 'MailChimp' }, { vendor: 'SendGrid' },
    ]);
    expect(summary).toEqual({ count: 3, vendors: ['MailChimp', 'SendGrid'] });
  });

  it('is null when nothing was found — the glyph renders on truthiness', () => {
    expect(summarizeTrackers([])).toBeNull();
    expect(summarizeTrackers(null)).toBeNull();
  });
});

describe('the bundled pattern list', () => {
  it('carries both upstream lists plus our own additions', () => {
    expect(UGLY_EMAIL_PATTERNS.length).toBeGreaterThanOrEqual(58);
    expect(MTB_PATTERNS.length).toBeGreaterThanOrEqual(400);
    expect(TRACKER_PATTERNS.length).toBe(
      CURATED_PATTERNS.length + UGLY_EMAIL_PATTERNS.length + MTB_PATTERNS.length
    );
  });

  it('puts the curated names first, so a familiar sender keeps a familiar name', () => {
    // MailTrackerBlocker files Mailchimp's endpoint under "Intuit" — true, and
    // not what anyone wants to read in the dialog. Order decides the label.
    const url = 'https://x.list-manage.com/track/open.php?u=1';
    expect(TRACKER_PATTERNS.find(([, re]) => re.test(url))[0]).toBe('Mailchimp');
  });

  it('is all [label, RegExp] pairs — a broken entry would silently match nothing', () => {
    for (const entry of TRACKER_PATTERNS) {
      expect(entry).toHaveLength(2);
      expect(typeof entry[0]).toBe('string');
      expect(entry[1]).toBeInstanceOf(RegExp);
    }
  });

  it('matches no plain https URL — a pattern that broad would strip every image', () => {
    const innocent = 'https://cdn.example.com/images/hero-banner-2026.png';
    const hits = TRACKER_PATTERNS.filter(([, re]) => re.test(innocent));
    expect(hits).toEqual([]);
  });
});
