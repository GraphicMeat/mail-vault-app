// @vitest-environment jsdom
// The Premium screen: the store's disclosures and links, prices only from the store, the purchase
// and Restore states, the website sign-in (code, wrong code, a replaced device), a lapsed
// Premium, the Settings row, and the upkeep (`premium.js`) and the locked-feature entry point.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';

const engine = vi.hoisted(() => ({
  calls: [],
  products: [],
  productsError: null,
  purchase: null,
  restore: [],
  restoreError: null,
  start: () => ({ ok: true }),
  verify: () => ({ premium: true, source: 'web', expiresMs: 1_900_000_000_000 }),
  status: { premium: false, source: null, expiresMs: null },
  refresh: () => ({ premium: false, source: null, expiresMs: null }),
  handlers: new Map(),
}));

const fail = (code) => Object.assign(new Error(code), { code });

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    const run = (v) => (typeof v === 'function' ? v(params) : v);
    switch (method) {
      case 'mobile.premium.status': return run(engine.status);
      case 'mobile.premium.refresh': return run(engine.refresh);
      case 'mobile.premium.webSignIn.start': return run(engine.start);
      case 'mobile.premium.webSignIn.verify': return run(engine.verify);
      case 'mobile.settings.get': return { notifications: 'off', notificationPreview: true };
      default: throw fail('UNSUPPORTED');
    }
  }),
  listen: vi.fn((name, handler) => {
    engine.handlers.set(name, handler);
    return () => engine.handlers.delete(name);
  }),
  storeProducts: vi.fn(async () => {
    if (engine.productsError) throw fail(engine.productsError);
    return engine.products;
  }),
  storePurchase: vi.fn(async (id) => {
    engine.calls.push(['purchase', id]);
    const out = typeof engine.purchase === 'function' ? engine.purchase(id) : engine.purchase;
    if (out instanceof Error) throw out;
    return out;
  }),
  storeRestore: vi.fn(async () => {
    engine.calls.push(['restore']);
    if (engine.restoreError) throw fail(engine.restoreError);
    return engine.restore;
  }),
  notificationPermission: vi.fn(async () => ({ granted: true })),
  requestNotificationPermission: vi.fn(async () => ({ granted: true })),
}));

const { default: Premium } = await import('../Premium.jsx');
const { default: Settings } = await import('../Settings.jsx');
const { useMobileStore } = await import('../store.js');
const { openPaywall, startPremiumSync, PREMIUM_FEATURES, premiumSummary } = await import('../premium.js');
const { t } = await import('../i18n.js');
const { formatFullDate } = await import('../format.js');

const MONTH = { id: 'p.month', title: 'MailVault Premium Monthly', price: 'QQ 7.77', period: 'P1M' };
const YEAR = { id: 'p.year', title: 'MailVault Premium Yearly', price: 'QQ 77.7', period: 'P1Y' };
const EXPIRES = 1_900_000_000_000;

const FREE = { premium: false, source: null, expiresMs: null };

beforeEach(() => {
  engine.calls = [];
  engine.products = [MONTH, YEAR];
  engine.productsError = null;
  engine.purchase = { status: 'purchased', platform: 'apple', productId: YEAR.id, premium: { premium: true, source: 'apple', expiresMs: EXPIRES } };
  engine.restore = [];
  engine.restoreError = null;
  engine.start = () => ({ ok: true });
  engine.verify = () => ({ premium: true, source: 'web', expiresMs: EXPIRES });
  engine.status = FREE;
  engine.refresh = FREE;
  engine.handlers = new Map();
  useMobileStore.setState({ premium: FREE, premiumLost: null, premiumLapsed: false, paywall: null, accounts: [] });
});
afterEach(cleanup);

const ready = async () => { await screen.findByRole('radio', { name: /QQ 7\.77/ }); };
const click = (name) => fireEvent.click(screen.getByRole('button', { name }));
const field = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('the plans and the store disclosures', () => {
  it('shows both plans with the store prices and every required disclosure with working links', async () => {
    render(<Premium onClose={() => {}} />);
    await ready();
    expect(screen.getByRole('radio', { name: /Monthly.*QQ 7\.77 per month/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Yearly.*QQ 77\.7 per year/ })).toBeTruthy();
    // Renewal, charge and cancellation terms.
    expect(screen.getByText(/renews automatically at the price and for the period shown above/)).toBeTruthy();
    expect(screen.getByText(/Payment is charged to your App Store account/)).toBeTruthy();
    expect(screen.getByText(/cancel at least 24 hours before the current period ends/)).toBeTruthy();
    // Terms, Privacy and the store's manage page are real links.
    const href = (name) => screen.getByRole('link', { name }).getAttribute('href');
    expect(href('Terms of Use')).toBe('https://mailvaultapp.com/terms.html');
    expect(href('Privacy Policy')).toBe('https://mailvaultapp.com/privacy.html');
    expect(href('Manage subscription')).toBe('https://apps.apple.com/account/subscriptions');
    for (const a of screen.getAllByRole('link')) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toContain('noopener');
    }
  });

  it('points the manage link at Google Play on Android', async () => {
    const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 14)');
    render(<Premium onClose={() => {}} />);
    await ready();
    expect(screen.getByRole('link', { name: 'Manage subscription' }).getAttribute('href')).toBe('https://play.google.com/store/account/subscriptions');
    expect(screen.getByText(/Payment is charged to your Google Play account/)).toBeTruthy();
    ua.mockRestore();
  });

  it('offers no web price, no web purchase link and no share-to-unlock', async () => {
    render(<Premium onClose={() => {}} />);
    await ready();
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs.filter((h) => !/^https:\/\/(mailvaultapp\.com\/(terms|privacy)\.html|apps\.apple\.com\/|play\.google\.com\/)/.test(h))).toEqual([]);
    expect(document.body.textContent).not.toMatch(/checkout|activate|share/i);
  });

  it('takes every price from the store: a different store string shows as given', async () => {
    engine.products = [{ ...MONTH, price: 'ZZ 1,23' }, { ...YEAR, price: 'ZZ 4,56' }];
    render(<Premium onClose={() => {}} />);
    await screen.findByRole('radio', { name: /ZZ 1,23 per month/ });
    expect(screen.getByRole('radio', { name: /ZZ 4,56 per year/ })).toBeTruthy();
  });

  it('says so when the store offers no plan, and retries', async () => {
    engine.products = [];
    render(<Premium onClose={() => {}} />);
    expect((await screen.findByRole('alert')).textContent).toBe(t('mobile.premium.products.none'));
    expect(screen.getByRole('button', { name: 'Subscribe' }).disabled).toBe(true);
    engine.productsError = 'UNAVAILABLE';
    engine.products = [MONTH, YEAR];
    cleanup();
    render(<Premium onClose={() => {}} />);
    expect((await screen.findByRole('alert')).textContent).toBe(t('mobile.error.UNAVAILABLE'));
    engine.productsError = null;
    click('Retry');
    await ready();
  });

  it('highlights the locked feature that opened it', async () => {
    render(<Premium feature="followUp" onClose={() => {}} />);
    await ready();
    const marked = document.querySelectorAll('[data-mv-highlight="true"]');
    expect(marked).toHaveLength(1);
    expect(marked[0].getAttribute('data-mv-feature')).toBe('followUp');
    expect(document.querySelectorAll('[data-mv-feature]')).toHaveLength(PREMIUM_FEATURES.length);
  });
});

describe('subscribe', () => {
  it('buys the chosen plan (yearly first) and shows Premium on', async () => {
    render(<Premium onClose={() => {}} />);
    await ready();
    expect(screen.getByRole('radio', { name: /Yearly/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: /Monthly/ }));
    engine.purchase = { status: 'purchased', platform: 'apple', productId: MONTH.id, premium: { premium: true, source: 'apple', expiresMs: EXPIRES } };
    click('Subscribe');
    await waitFor(() => expect(useMobileStore.getState().premium.premium).toBe(true));
    expect(engine.calls.filter((c) => c[0] === 'purchase')).toEqual([['purchase', MONTH.id]]);
    // The page never verifies a purchase itself.
    expect(engine.calls.map((c) => c[0])).not.toContain('mobile.premium.verify');
    expect((await screen.findByRole('status')).textContent).toContain('Premium: active until');
  });

  it('disables the buttons while the store sheet is up', async () => {
    let finish;
    engine.purchase = () => { throw new Error('unused'); };
    const transport = await import('../transport.js');
    transport.storePurchase.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
    render(<Premium onClose={() => {}} />);
    await ready();
    click('Subscribe');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Waiting for the store…' }).disabled).toBe(true));
    expect(screen.getByRole('button', { name: 'Restore purchases' }).disabled).toBe(true);
    await act(async () => { finish({ status: 'cancelled', platform: 'apple', productId: YEAR.id }); });
    expect(screen.getByRole('button', { name: 'Subscribe' }).disabled).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a cancelled purchase leaves no message', async () => {
    engine.purchase = { status: 'cancelled', platform: 'apple', productId: YEAR.id };
    render(<Premium onClose={() => {}} />);
    await ready();
    click('Subscribe');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Subscribe' }).disabled).toBe(false));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a pending purchase says it waits for approval', async () => {
    engine.purchase = { status: 'pending', platform: 'apple', productId: YEAR.id };
    render(<Premium onClose={() => {}} />);
    await ready();
    click('Subscribe');
    expect((await screen.findByRole('status')).textContent).toBe(t('mobile.premium.result.pending'));
    expect(useMobileStore.getState().premium.premium).toBe(false);
  });

  it('a paid purchase the server has not confirmed yet says Premium follows', async () => {
    for (const code of ['NETWORK', 'RATE_LIMITED']) {
      engine.purchase = { status: 'purchased', platform: 'apple', productId: YEAR.id, error: { code } };
      render(<Premium onClose={() => {}} />);
      await ready();
      click('Subscribe');
      expect((await screen.findByRole('status')).textContent).toBe(t('mobile.premium.result.activating'));
      cleanup();
    }
  });

  it('maps a refusal and the shell codes to their messages', async () => {
    for (const [out, code] of [
      [{ status: 'purchased', platform: 'apple', productId: YEAR.id, error: { code: 'REFUSED' } }, 'REFUSED'],
      [{ status: 'purchased', platform: 'google', productId: YEAR.id, error: { code: 'UNVERIFIED' } }, 'UNVERIFIED'],
      [fail('OWNED'), 'OWNED'],
      [fail('UNAVAILABLE'), 'UNAVAILABLE'],
      [fail('BUSY'), 'BUSY'],
      [fail('NOT_FOUND'), 'NOT_FOUND'],
      [fail('WHATEVER'), 'INTERNAL'],
    ]) {
      engine.purchase = out;
      render(<Premium onClose={() => {}} />);
      await ready();
      click('Subscribe');
      expect((await screen.findByRole('alert')).textContent).toBe(t(`mobile.error.${code}`));
      cleanup();
    }
  });
});

describe('restore purchases', () => {
  it('turns Premium on from a restored subscription', async () => {
    engine.restore = [{ platform: 'apple', productId: YEAR.id, premium: { premium: true, source: 'apple', expiresMs: EXPIRES } }];
    render(<Premium onClose={() => {}} />);
    await ready();
    click('Restore purchases');
    await waitFor(() => expect(useMobileStore.getState().premium).toEqual({ premium: true, source: 'apple', expiresMs: EXPIRES }));
  });

  it('says so when there is nothing to restore, or nothing active', async () => {
    render(<Premium onClose={() => {}} />);
    await ready();
    click('Restore purchases');
    expect((await screen.findByRole('status')).textContent).toBe(t('mobile.premium.result.restoreNone'));
    engine.restore = [{ platform: 'apple', productId: YEAR.id, premium: { premium: false, source: null, expiresMs: null } }];
    click('Restore purchases');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(t('mobile.premium.result.restoreInactive')));
  });

  it('shows the install limit and a failed restore', async () => {
    engine.restore = [{ platform: 'apple', productId: YEAR.id, error: { code: 'INSTALL_LIMIT' } }];
    render(<Premium onClose={() => {}} />);
    await ready();
    click('Restore purchases');
    expect((await screen.findByRole('alert')).textContent).toBe(t('mobile.error.INSTALL_LIMIT'));
    engine.restoreError = 'UNAVAILABLE';
    click('Restore purchases');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(t('mobile.error.UNAVAILABLE')));
  });
});

describe('sign in with the website account', () => {
  const toCode = async () => {
    render(<Premium onClose={() => {}} />);
    await ready();
    click('Already have Premium from the MailVault website? Sign in');
    field('Email address', ' ada@example.test ');
    click('Send code');
    await screen.findByLabelText('Code');
  };

  it('asks for the email, sends the code in the page language, then signs in', async () => {
    await toCode();
    expect(engine.calls.find((c) => c[0] === 'mobile.premium.webSignIn.start')[1]).toEqual({ email: 'ada@example.test', lang: 'en' });
    expect(screen.getByText(/code to ada@example\.test/)).toBeTruthy();
    field('Code', ' 493817 ');
    click('Sign in');
    await screen.findByText(t('mobile.premium.web.done'));
    const [, params] = engine.calls.find((c) => c[0] === 'mobile.premium.webSignIn.verify');
    expect(params).toMatchObject({ email: 'ada@example.test', code: '493817' });
    expect(useMobileStore.getState().premium).toEqual({ premium: true, source: 'web', expiresMs: EXPIRES });
    expect(screen.queryByText(/signed out of this account/)).toBeNull();
  });

  it('names the device a sign-in signed out', async () => {
    engine.verify = () => ({ premium: true, source: 'web', expiresMs: EXPIRES, replacedClient: { clientName: 'Ada iPad', platform: 'ios', lastSeenMs: 1 } });
    await toCode();
    field('Code', '493817');
    click('Sign in');
    expect((await screen.findByText(/Ada iPad was signed out of this account/)).textContent).toBe(t('mobile.premium.web.replaced', { name: 'Ada iPad' }));
  });

  it('keeps the code step on a wrong code, and asks for a new code once it expired', async () => {
    await toCode();
    engine.verify = () => { throw fail('CODE_WRONG'); };
    field('Code', '000000');
    click('Sign in');
    expect((await screen.findByRole('alert')).textContent).toBe(t('mobile.error.CODE_WRONG'));
    expect(screen.getByLabelText('Code')).toBeTruthy();
    engine.verify = () => { throw fail('CODE_EXPIRED'); };
    click('Sign in');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(t('mobile.error.CODE_EXPIRED')));
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    click('Send a new code');
    await waitFor(() => expect(engine.calls.filter((c) => c[0] === 'mobile.premium.webSignIn.start')).toHaveLength(2));
  });

  it('shows a lost place and rate limits', async () => {
    await toCode();
    engine.verify = () => { throw fail('DEVICE_REPLACED'); };
    field('Code', '493817');
    click('Sign in');
    // The form's message, and the screen's note about the lost place.
    await waitFor(() => expect(screen.getAllByRole('alert').map((a) => a.textContent)).toEqual([t('mobile.premium.deviceReplaced'), t('mobile.error.DEVICE_REPLACED')]));
    expect(useMobileStore.getState().premiumLost).toBe('DEVICE_REPLACED');
    engine.verify = () => { throw fail('RATE_LIMITED'); };
    click('Sign in');
    await waitFor(() => expect(screen.getAllByRole('alert').pop().textContent).toBe(t('mobile.error.RATE_LIMITED')));
  });

  it('an account with no Premium says so and changes nothing', async () => {
    engine.verify = () => FREE;
    await toCode();
    field('Code', '493817');
    click('Sign in');
    expect((await screen.findByRole('alert')).textContent).toBe(t('mobile.premium.web.noPremium'));
    expect(useMobileStore.getState().premium.premium).toBe(false);
  });

  it('reports a start failure', async () => {
    engine.start = () => { throw fail('NETWORK'); };
    render(<Premium onClose={() => {}} />);
    await ready();
    click('Already have Premium from the MailVault website? Sign in');
    field('Email address', 'ada@example.test');
    click('Send code');
    expect((await screen.findByRole('alert')).textContent).toBe(t('mobile.error.NETWORK'));
    expect(screen.queryByLabelText('Code')).toBeNull();
  });

  it('opens straight at the email step from Sign in again', async () => {
    render(<Premium signIn onClose={() => {}} />);
    await ready();
    expect(screen.getByLabelText('Email address')).toBeTruthy();
  });
});

describe('Premium state', () => {
  it('active Premium shows the summary and no purchase buttons', async () => {
    useMobileStore.getState().setPremium({ premium: true, source: 'google', expiresMs: EXPIRES });
    render(<Premium onClose={() => {}} />);
    expect((await screen.findByRole('status')).textContent).toBe(`Premium: active until ${formatFullDate(EXPIRES)} (Google Play)`);
    expect(screen.queryByRole('button', { name: 'Subscribe' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Manage subscription' }).getAttribute('href')).toBe('https://play.google.com/store/account/subscriptions');
  });

  it('a lapsed Premium says it ended and offers the plans again', async () => {
    useMobileStore.getState().setPremium({ premium: true, source: 'apple', expiresMs: EXPIRES });
    useMobileStore.getState().setPremium(FREE);
    expect(useMobileStore.getState().premiumLapsed).toBe(true);
    render(<Premium onClose={() => {}} />);
    await ready();
    expect(screen.getByText('Your Premium has ended.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Subscribe' })).toBeTruthy();
  });

  it('a phone whose place was taken says why', async () => {
    useMobileStore.getState().setPremiumLost('DEVICE_REPLACED');
    render(<Premium onClose={() => {}} />);
    await ready();
    expect(screen.getByText(t('mobile.premium.deviceReplaced'))).toBeTruthy();
  });
});

describe('Settings', () => {
  it('shows Free, then the active line with source and date', async () => {
    render(<Settings onClose={() => {}} />);
    expect(screen.getByText('Free')).toBeTruthy();
    act(() => useMobileStore.getState().setPremium({ premium: true, source: 'web', expiresMs: EXPIRES }));
    expect(screen.getByText(`Premium: active until ${formatFullDate(EXPIRES)} (Website)`)).toBeTruthy();
    expect(premiumSummary({ premium: true, source: 'apple', expiresMs: EXPIRES })).toContain('(App Store)');
  });

  it('opens the paywall from the Premium row', () => {
    render(<Settings onClose={() => {}} />);
    fireEvent.click(document.querySelector('[data-mv-premium-row]'));
    expect(useMobileStore.getState().paywall).toEqual({ feature: null, signIn: false });
  });

  it('a replaced phone shows the reason with Sign in again, which opens the sign-in', () => {
    useMobileStore.getState().setPremiumLost('DEVICE_REPLACED');
    render(<Settings onClose={() => {}} />);
    expect(screen.getByText(t('mobile.premium.deviceReplaced'), { exact: false })).toBeTruthy();
    click('Sign in again');
    expect(useMobileStore.getState().paywall).toEqual({ feature: null, signIn: true });
  });
});

describe('upkeep and the locked-feature entry point', () => {
  it('reads the status, refreshes, follows the changed event and stops', async () => {
    engine.status = { premium: true, source: 'apple', expiresMs: EXPIRES };
    engine.refresh = { premium: true, source: 'apple', expiresMs: EXPIRES + 1 };
    const stop = startPremiumSync();
    await waitFor(() => expect(useMobileStore.getState().premium.expiresMs).toBe(EXPIRES + 1));
    expect(engine.calls.map((c) => c[0])).toEqual(['mobile.premium.status', 'mobile.premium.refresh']);
    act(() => engine.handlers.get('mobile.premium.changed')(FREE));
    expect(useMobileStore.getState().premium.premium).toBe(false);
    expect(useMobileStore.getState().premiumLapsed).toBe(true);
    stop();
    expect(engine.handlers.has('mobile.premium.changed')).toBe(false);
  });

  it('a refresh that says the place was taken is remembered', async () => {
    engine.refresh = () => { throw fail('DEVICE_REPLACED'); };
    const stop = startPremiumSync();
    await waitFor(() => expect(useMobileStore.getState().premiumLost).toBe('DEVICE_REPLACED'));
    stop();
  });

  it('openPaywall(feature) opens the layer with that feature, and ignores an unknown one', () => {
    openPaywall('scheduledSend');
    expect(useMobileStore.getState().paywall).toEqual({ feature: 'scheduledSend', signIn: false });
    openPaywall('nonsense');
    expect(useMobileStore.getState().paywall).toEqual({ feature: null, signIn: false });
    useMobileStore.getState().closePaywall();
    expect(useMobileStore.getState().paywall).toBeNull();
  });
});
