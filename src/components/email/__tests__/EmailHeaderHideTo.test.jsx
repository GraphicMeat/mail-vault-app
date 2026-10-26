// @vitest-environment jsdom
/**
 * A social capture of the app window can leave the reader's To row out
 * (privacyStore.captureHideTo). The row is removed from the live layout, not
 * hidden in the clone, so the message frame's rect still matches the shot.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

vi.mock('../../../services/senderVerdict', async (importOriginal) => {
  const { stubSenderVerdicts, verdict } = await import('../../../test/senderVerdicts');
  return stubSenderVerdicts(importOriginal, () => verdict());
});
import { EmailHeader } from '../EmailHeaderComponent';
import { usePrivacyStore } from '../../../stores/privacyStore';

const email = {
  uid: 3, _accountId: 'acct', _mailbox: 'INBOX', subject: 'Hello', date: new Date('2026-09-01T10:00:00Z'),
  from: { name: 'Ana Brandt', address: 'ana@sizzlemedia.co' },
  to: [{ name: 'Rowan Marsh', address: 'rowan@primecut.studio' }],
};
const props = { expanded: false, onToggle() {}, onToggleRaw() {}, onToggleInsights() {} };
const hide = (on) => act(() => usePrivacyStore.getState().setCaptureHideTo(on));

beforeEach(() => {
  vi.spyOn(usePrivacyStore.persist, 'hasHydrated').mockReturnValue(true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePrivacyStore.setState({ enabled: false, captureHideTo: false });
});
afterEach(() => { cleanup(); usePrivacyStore.setState({ captureHideTo: false }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('EmailHeader To row under a capture', () => {
  it('shows the To row, drops it while a capture asks, and brings it back after', () => {
    const { container } = render(<EmailHeader email={email} {...props} />);
    expect(container.textContent).toContain('Rowan Marsh');
    hide(true);
    expect(container.textContent).not.toContain('Rowan Marsh');
    expect(container.textContent).toContain('Ana Brandt');
    hide(false);
    expect(container.textContent).toContain('Rowan Marsh');
  });

  it('keeps Cc when only the To row goes', () => {
    const cc = { ...email, cc: [{ name: 'Theo Park', address: 'theo@skewer.systems' }] };
    const { container } = render(<EmailHeader email={cc} {...props} />);
    hide(true);
    expect(container.textContent).not.toContain('Rowan Marsh');
    expect(container.textContent).toContain('Theo Park');
  });
});
