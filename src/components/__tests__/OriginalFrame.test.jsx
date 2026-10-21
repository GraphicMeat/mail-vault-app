// @vitest-environment jsdom
//
// The reply/forward "original message" frame used to hardcode blocking off,
// so it rendered a quoted message's remote images and tracking beacons no
// matter what the reading pane's tracker blocking setting said. It reads the
// same `isTrackerBlockingActive` gate as EmailViewer/ChatBubbleView/
// EmailPreviewFrame, driving the real settings store rather than a stubbed
// flag, and frames the daemon's answer (`body.scan`, stubbed here the way the
// daemon answers: the beacon swapped for its marker when blocking).

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';

vi.mock('../../stores/safeStorage', () => {
  const store = {};
  return {
    safeStorage: {
      getItem: (key) => store[key] || null,
      setItem: (key, val) => { store[key] = val; },
      removeItem: (key) => { delete store[key]; },
    },
  };
});

vi.mock('../../services/bodyScan', async (orig) => {
  const { stubBodyScan, bodyScanAnswer } = await import('../../test/bodyScan');
  return stubBodyScan(orig, (html, opts) => {
    if (html.includes('PENDING')) return undefined;
    if (html.includes('UNSCANNED')) return { ...bodyScanAnswer(html), scanned: false };
    return bodyScanAnswer(html, opts.blocking ? { html: html.replace(/<img[^>]*>/, '<span data-mv-tracker-blocked="Mailchimp"></span>'), count: 1 } : {});
  });
});

const { useSettingsStore } = await import('../../stores/settingsStore');
const { OriginalFrame } = await import('../OriginalFrame');
const { usePrivacyStore } = await import('../../stores/privacyStore');

const PREMIUM = { hasSubscription: true, premiumAccess: true, status: 'active' };
const FREE = { hasSubscription: false };
const BEACON = 'https://example.list-manage.com/track/open.php?u=8f2&id=a91';
const MAIL = `<p>Hi</p><img src="${BEACON}" width="1" height="1">`;

function renderFrame(billingProfile, trackerBlockingEnabled = true, html = MAIL) {
  useSettingsStore.setState({ billingProfile, trackerBlockingEnabled });
  const { container } = render(<OriginalFrame html={html} dark={false} title="Original Message" />);
  return container.querySelector('iframe').getAttribute('srcdoc');
}

afterEach(() => cleanup());

describe('OriginalFrame', () => {
  it('strips the beacon when the reader would block it (premium, blocking on)', () => {
    const doc = renderFrame(PREMIUM, true);
    expect(doc).not.toContain('list-manage.com');
    expect(doc).toContain('data-mv-tracker-blocked');
  });

  it('keeps the beacon when the user turned tracker blocking off', () => {
    expect(renderFrame(PREMIUM, false)).toContain(BEACON);
  });

  it('keeps the beacon for a free user, matching the reading pane', () => {
    expect(renderFrame(FREE, true)).toContain(BEACON);
  });

  it('frames nothing while the scan is asked', () => {
    expect(renderFrame(PREMIUM, true, `${MAIL}PENDING`)).toBe('');
  });

  it('frames a body the daemon could not scan with remote images refused', () => {
    expect(renderFrame(FREE, true, `${MAIL}UNSCANNED`)).toContain('content="img-src data: blob: cid:"');
  });
});

describe('OriginalFrame under privacy mode', () => {
  afterEach(() => usePrivacyStore.setState({ enabled: false }));
  it('starts gated (head style and inline html opacity), and plain when privacy is off', () => {
    usePrivacyStore.setState({ enabled: true });
    const gated = new DOMParser().parseFromString(renderFrame(FREE), 'text/html');
    expect(gated.head.querySelector('style#mv-privacy-gate')).not.toBeNull();
    expect(gated.documentElement.getAttribute('style')).toBe('opacity:0!important');
    cleanup();
    usePrivacyStore.setState({ enabled: false });
    const plain = new DOMParser().parseFromString(renderFrame(FREE), 'text/html');
    expect(plain.getElementById('mv-privacy-gate')).toBeNull();
    expect(plain.documentElement.hasAttribute('style')).toBe(false);
  });
});
