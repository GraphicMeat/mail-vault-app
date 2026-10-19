// @vitest-environment jsdom
// With the daemon down the shield says the sender was not checked, instead of
// drawing nothing (which reads as "nothing to flag").
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

const daemonCall = vi.fn();
vi.mock('../../../services/daemonClient', () => ({ daemonCall: (...a) => daemonCall(...a) }));

const { SenderVerificationBadge } = await import('../EmailHeaderComponent');
const { _resetSenderVerdicts } = await import('../../../services/senderVerdict');
const { t } = await import('../../../i18n/index.js');

const email = { uid: 3, from: { name: 'Prize Desk', address: 'win@prize.example' }, authenticationResults: 'mx; spf=fail; dkim=fail' };

beforeEach(() => {
  _resetSenderVerdicts();
  daemonCall.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('SenderVerificationBadge with the daemon down', () => {
  it('shows a "not checked" shield', async () => {
    daemonCall.mockRejectedValue(new Error('daemon unavailable'));
    const { container } = render(<SenderVerificationBadge email={email} />);
    const badge = await waitFor(() => {
      const b = container.querySelector('[data-testid="sender-verification"]');
      if (!b) throw new Error('no shield yet');
      return b;
    });
    expect(badge.getAttribute('data-status')).toBe('unavailable');
    expect(badge.getAttribute('title')).toBe(t('util.senderCheck.senderNotChecked'));
    expect(t('util.senderCheck.senderNotChecked')).not.toBe('util.senderCheck.senderNotChecked');
  });

  it('asks again on the next look and shows the real verdict', async () => {
    daemonCall.mockRejectedValueOnce(new Error('daemon unavailable'));
    const first = render(<SenderVerificationBadge email={email} />);
    await waitFor(() => expect(first.container.querySelector('[data-status="unavailable"]')).not.toBeNull());
    cleanup();
    daemonCall.mockResolvedValueOnce({ status: 'danger', tooltip: [], issues: [], auth: { spf: 'fail', dkim: 'fail', dmarc: null }, dkim: null });
    const second = render(<SenderVerificationBadge email={email} />);
    await waitFor(() => expect(second.container.querySelector('[data-status="danger"]')).not.toBeNull());
  });
});
