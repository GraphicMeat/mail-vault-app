// @vitest-environment jsdom
/**
 * A social capture of the app window asks one message's header for its real
 * sender-details popover (privacyStore.captureSenderDetails), open inline so the
 * shot can see it, and the popover's own values mask or reveal like any other.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { SenderVerificationBadge } from '../EmailHeaderComponent';
import { usePrivacyStore } from '../../../stores/privacyStore';
import { setPrivacyDictionary } from '../../../utils/privacy/privacyDictionary';
import { buildNameDictionary } from '../../../utils/privacy/piiDetector';

const email = {
  uid: 3, _accountId: 'acct', _mailbox: 'Junk',
  from: { name: 'Prize Desk', address: 'win@prize.example' },
  replyTo: [{ address: 'collect@elsewhere.example' }],
  authenticationResults: 'mx; spf=fail; dkim=pass; dmarc=pass',
};
const target = { uid: 3, accountId: 'acct', mailbox: 'Junk' };
const capture = (value) => act(() => usePrivacyStore.getState().setCaptureSenderDetails(value));
const popover = (container) => container.querySelector('[data-capture-overlay]');

beforeEach(() => {
  vi.spyOn(usePrivacyStore.persist, 'hasHydrated').mockReturnValue(true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePrivacyStore.setState({ enabled: false, peek: false, captureMask: false, captureReveal: null, captureSenderDetails: null });
  setPrivacyDictionary(buildNameDictionary({ names: ['Prize Desk'] }), { ready: true });
});
afterEach(() => {
  cleanup();
  usePrivacyStore.setState({ enabled: false, captureReveal: null, captureSenderDetails: null });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SenderVerificationBadge under a capture', () => {
  it('shows no popover until a capture names this message, then opens it inline, and closes it after', () => {
    const { container } = render(<SenderVerificationBadge email={email} />);
    expect(popover(container)).toBeNull();
    capture(target);
    expect(popover(container).textContent).toContain('Sender Details');
    expect(popover(container).textContent).toContain('win@prize.example');
    // Inline under the badge (the capture's DOM clone sees it), not portaled to the body.
    expect(container.contains(popover(container))).toBe(true);
    capture(null);
    expect(popover(container)).toBeNull();
  });

  it('only the named message opens: another uid, folder or account does not', () => {
    const { container } = render(<SenderVerificationBadge email={email} />);
    for (const other of [{ ...target, uid: 4 }, { ...target, mailbox: 'INBOX' }, { ...target, accountId: 'other' }]) {
      capture(other);
      expect(popover(container), JSON.stringify(other)).toBeNull();
    }
  });

  it('a message with nothing to flag has no shield, but a capture still shows its box', () => {
    const plain = { uid: 3, _accountId: 'acct', _mailbox: 'Junk', from: { address: 'a@x.example' } };
    const { container } = render(<SenderVerificationBadge email={plain} />);
    expect(container.innerHTML).toBe('');
    capture(target);
    expect(container.querySelector('[data-testid="sender-verification"]')).toBeNull();
    expect(popover(container).textContent).toContain('No authentication data available');
  });

  it('masks the sender in the popover while privacy masks, and shows exactly the revealed values', () => {
    usePrivacyStore.setState({ enabled: true });
    const { container } = render(<SenderVerificationBadge email={email} />);
    capture(target);
    let text = popover(container).textContent;
    expect(text).not.toContain('win@prize.example');
    expect(text).not.toContain('Prize Desk');
    expect(text).not.toContain('collect@elsewhere.example');
    expect(text).toContain('xxx@xxxxx.xxxxxxx');
    act(() => usePrivacyStore.getState().setCaptureReveal(['win@prize.example', 'prize desk']));
    text = popover(container).textContent;
    expect(text).toContain('win@prize.example');
    expect(text).toContain('Prize Desk');
    // The Reply-To is not in the set: still masked.
    expect(text).not.toContain('collect@elsewhere.example');
    act(() => usePrivacyStore.getState().setCaptureReveal(null));
    expect(popover(container).textContent).not.toContain('win@prize.example');
  });
});
