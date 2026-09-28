// @vitest-environment jsdom
//
// The reply/forward "original message" frame used to hardcode
// `frameBody(html, null, false)`, so it rendered a quoted message's remote
// images and tracking beacons no matter what the reading pane's tracker
// blocking setting said. It now reads the same `isTrackerBlockingActive`
// gate as EmailViewer/ChatBubbleView/EmailPreviewFrame, driving the real
// settings store rather than a stubbed flag.

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

const { useSettingsStore } = await import('../../stores/settingsStore');
const { OriginalFrame } = await import('../OriginalFrame');

const PREMIUM = { hasSubscription: true, premiumAccess: true, status: 'active' };
const FREE = { hasSubscription: false };
const BEACON = 'https://example.list-manage.com/track/open.php?u=8f2&id=a91';
const MAIL = `<p>Hi</p><img src="${BEACON}" width="1" height="1">`;

function renderFrame(billingProfile, trackerBlockingEnabled = true) {
  useSettingsStore.setState({ billingProfile, trackerBlockingEnabled });
  const { container } = render(<OriginalFrame html={MAIL} dark={false} title="Original Message" />);
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
});
