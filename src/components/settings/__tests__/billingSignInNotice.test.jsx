// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';
import React from 'react';

vi.mock('lucide-react', () => new Proxy({}, {
  get: (_t, name) => (props) => React.createElement('span', { 'data-icon': String(name), ...props }),
}));

import { signInFailureNotice } from '../BillingSettings';

describe('signInFailureNotice', () => {
  it('explains an email the billing server has never seen', () => {
    const msg = signInFailureNotice({ hasSubscription: false, customerId: null });
    expect(msg).toMatch(/No subscription found/i);
  });

  it('distinguishes a known customer with no live subscription', () => {
    const msg = signInFailureNotice({ hasSubscription: false, customerId: 'cus_123' });
    expect(msg).toMatch(/No active subscription/i);
  });

  it('names the ended subscription', () => {
    expect(signInFailureNotice({ hasSubscription: true, status: 'canceled' })).toMatch(/ended/i);
  });

  it('points a failed payment at the portal', () => {
    expect(signInFailureNotice({ hasSubscription: true, status: 'past_due' })).toMatch(/payment/i);
  });

  it('reports a device that could not be activated', () => {
    const msg = signInFailureNotice({
      hasSubscription: true, status: 'active', premiumAccess: true, clientAccessGranted: false,
    });
    expect(msg).toMatch(/device/i);
  });

  it('falls back to the raw status rather than saying nothing', () => {
    expect(signInFailureNotice({ hasSubscription: true, status: 'paused' })).toMatch(/paused/);
  });

  it('returns nothing when there was no server answer', () => {
    expect(signInFailureNotice(null)).toBeNull();
  });
});
