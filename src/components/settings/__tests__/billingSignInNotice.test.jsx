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

describe('signInFailureNotice — App Store build', () => {
  const mas = { appStore: true };

  it('never points at plan cards that a MAS build does not render', () => {
    const results = [
      { hasSubscription: false, customerId: null },
      { hasSubscription: false, customerId: 'cus_123' },
      { hasSubscription: true, status: 'canceled' },
      { hasSubscription: true, status: 'incomplete' },
    ];
    for (const result of results) {
      expect(signInFailureNotice(result, mas)).not.toMatch(/plan below/i);
    }
  });

  it('still explains what went wrong', () => {
    expect(signInFailureNotice({ hasSubscription: false, customerId: 'cus_1' }, mas))
      .toMatch(/no active subscription/i);
    expect(signInFailureNotice({ hasSubscription: false, customerId: null }, mas))
      .toMatch(/sign in with the email/i);
    expect(signInFailureNotice({ hasSubscription: true, status: 'canceled' }, mas))
      .toMatch(/ended/i);
  });

  it('never points at the Stripe portal button either', () => {
    const results = [
      { hasSubscription: true, status: 'past_due' },
      { hasSubscription: true, status: 'paused' },
    ];
    for (const result of results) {
      expect(signInFailureNotice(result, mas)).not.toMatch(/Manage Subscription/i);
    }
  });

  it('leaves the default (non-MAS) copy alone', () => {
    expect(signInFailureNotice({ hasSubscription: false, customerId: 'cus_1' }))
      .toMatch(/plan below/i);
  });
});
