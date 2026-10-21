// @vitest-environment jsdom
//
// Cleanup preview and Time Capsule used to hand the raw mail to a bare srcdoc
// with no CSP and no tracker strip: opening a message there fired the beacons
// the reading pane blocks. They now render through the reader's template and
// the same `isTrackerBlockingActive` gate — these cases pin that, driving the
// real settings store rather than a stubbed flag. The scan is the daemon's
// (`body.scan`), stubbed the way it answers: the beacon swapped for its marker
// when blocking.

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';

vi.mock('../../../stores/safeStorage', () => {
  const store = {};
  return {
    safeStorage: {
      getItem: (key) => store[key] || null,
      setItem: (key, val) => { store[key] = val; },
      removeItem: (key) => { delete store[key]; },
    },
  };
});

vi.mock('../../../services/bodyScan', async (orig) => {
  const { stubBodyScan, bodyScanAnswer } = await import('../../../test/bodyScan');
  return stubBodyScan(orig, (html, opts) => bodyScanAnswer(html, opts.blocking
    ? { html: html.replace(/<img[^>]*>/, '<span data-mv-tracker-blocked="Mailchimp"></span>'), count: 1 } : {}));
});

const { useSettingsStore } = await import('../../../stores/settingsStore');
const { EmailPreviewFrame, buildEmailPreviewHtml } = await import('../EmailPreviewFrame');
const { getEmailBodyContent } = await import('../../../utils/emailIframeTemplate');

const PREMIUM = { hasSubscription: true, premiumAccess: true, status: 'active' };
const FREE = { hasSubscription: false };
const BEACON = 'https://example.list-manage.com/track/open.php?u=8f2&id=a91';
const MAIL = `<!DOCTYPE html><html><body><p>Hi</p><img src="${BEACON}" width="1" height="1"><script>window.pwned = 1</script></body></html>`;

function renderFrame(billingProfile, trackerBlockingEnabled = true) {
  useSettingsStore.setState({ billingProfile, trackerBlockingEnabled });
  const { container } = render(<EmailPreviewFrame html={MAIL} title="preview" />);
  return container.querySelector('iframe');
}

/** The script-src of the first CSP <meta>, which must lead <head>. */
function leadingScriptSrc(doc) {
  const head = doc.match(/<head>([\s\S]*?)<\/head>/i)[1].trim();
  const m = head.match(/^<meta http-equiv="Content-Security-Policy" content="([^"]*)"/i);
  return m && m[1].split(';').map(s => s.trim()).find(s => s.startsWith('script-src'));
}

afterEach(() => cleanup());

describe('buildEmailPreviewHtml', () => {
  it('carries the reader CSP and leaves the mail script un-nonced', () => {
    const doc = buildEmailPreviewHtml(getEmailBodyContent(MAIL), false);
    expect(leadingScriptSrc(doc)).toMatch(/^script-src 'nonce-[A-Za-z0-9+/=_-]+'$/);
    expect(doc).toMatch(/<script>window\.pwned = 1<\/script>/);
    // Unwrapped, not nested: one document, not the mail's <html> inside ours.
    expect(doc.match(/<html/gi)).toHaveLength(1);
  });

  it('refuses remote images for a body the daemon could not scan', () => {
    expect(buildEmailPreviewHtml('<p>x</p>', false, true)).toContain('content="img-src data: blob: cid:"');
    expect(buildEmailPreviewHtml('<p>x</p>', false)).not.toContain('img-src');
  });
});

describe('EmailPreviewFrame', () => {
  it('renders the CSP document with the beacon stripped for an active blocker', () => {
    const iframe = renderFrame(PREMIUM);
    const doc = iframe.getAttribute('srcdoc');
    expect(leadingScriptSrc(doc)).toMatch(/^script-src 'nonce-/);
    expect(doc).not.toContain('list-manage.com');
    expect(doc).toContain('data-mv-tracker-blocked');
    // Still no scripts at all in the preview frame.
    expect(iframe.getAttribute('sandbox')).toBe('allow-same-origin');
  });

  it('matches the reader for a free user: CSP yes, beacon strip no', () => {
    const doc = renderFrame(FREE).getAttribute('srcdoc');
    expect(leadingScriptSrc(doc)).toMatch(/^script-src 'nonce-/);
    expect(doc).toContain('list-manage.com');
  });

  it('keeps the beacon when the user turned blocking off', () => {
    expect(renderFrame(PREMIUM, false).getAttribute('srcdoc')).toContain('list-manage.com');
  });
});
