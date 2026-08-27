// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';
import React from 'react';

vi.mock('lucide-react', () => new Proxy({}, {
  get: (_t, name) => (props) => React.createElement('span', { 'data-icon': String(name), ...props }),
}));

// The component now reaches the OS notification bridge when premium drops.
// Stub it: importing services/api drags in the daemon transport, which has no
// business booting inside a jsdom unit test.
vi.mock('../../../services/api', () => ({
  sendNotification: vi.fn().mockResolvedValue(undefined),
}));

import { signInFailureNotice, premiumDropNotice } from '../BillingSettings';

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

/**
 * 2026-08-27: a signed-in profile refreshed to "no subscription" and the app
 * simply re-rendered as Free — premium features stopped with no message.
 */
describe('premiumDropNotice', () => {
  const premium = { hasSubscription: true, status: 'active', premiumAccess: true };

  it('says nothing when access is kept', () => {
    expect(premiumDropNotice(premium, premium)).toBe(null);
  });

  it('says nothing when there was no access to lose', () => {
    const free = { hasSubscription: false, customerId: 'cus_123' };
    expect(premiumDropNotice(free, free)).toBe(null);
    expect(premiumDropNotice(null, free)).toBe(null);
  });

  it('announces a subscription that ended between two refreshes', () => {
    const msg = premiumDropNotice(premium, { hasSubscription: true, status: 'canceled' });
    expect(msg).toMatch(/Premium access ended on this device/i);
    expect(msg).toMatch(/ended/i);
  });

  it('announces a customer whose subscription is simply gone', () => {
    const msg = premiumDropNotice(premium, { hasSubscription: false, customerId: 'cus_V2LwNvtWmdRnO0' });
    expect(msg).toMatch(/Premium access ended on this device/i);
    expect(msg).toMatch(/No active subscription/i);
  });

  it('names a lost device seat rather than a lost subscription', () => {
    const msg = premiumDropNotice(premium, {
      hasSubscription: true, status: 'active', premiumAccess: true, clientAccessGranted: false,
    });
    expect(msg).toMatch(/this device could not be activated/i);
  });

  it('keeps App Store copy free of external purchase steering', () => {
    const msg = premiumDropNotice(premium, { hasSubscription: false, customerId: 'cus_123' }, { appStore: true });
    expect(msg).not.toMatch(/plan below/i);
  });
});
