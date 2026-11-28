// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { setLocale, t } from '../../i18n/index.js';
import { formatDateLong } from '../../utils/dateFormat';

vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal()),
  lifecycleSync: vi.fn().mockResolvedValue({ rows: [] }),
  lifecycleMarkSeen: vi.fn().mockResolvedValue({ rows: [] }),
  lifecycleDismiss: vi.fn().mockResolvedValue({ rows: [] }),
}));

vi.mock('../../services/billingApi', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchPricing: vi.fn().mockRejectedValue(new Error('offline')),
}));

const { useSettingsStore } = await import('../../stores/settingsStore');
const { useLifecycleStore } = await import('../../stores/lifecycleStore');
const { LifecycleMessageView } = await import('../LifecycleMessageView');

const row = (id, kind) => ({ id, kind, atMs: Date.UTC(2026, 10, 3, 9, 30), seen: true, dismissed: false });

beforeEach(async () => {
  await setLocale('en');
  await useSettingsStore.persist.rehydrate();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  useLifecycleStore.setState({ rows: [], openId: null });
});
afterEach(cleanup);

describe('LifecycleMessageView', () => {
  it('renders nothing when no message is open', () => {
    const { container } = render(<LifecycleMessageView onOpenBilling={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('reads like a message: from MailVault, a subject, the text and when it came', () => {
    useLifecycleStore.setState({ rows: [row('free-nudge', 'free-nudge')], openId: 'free-nudge' });
    render(<LifecycleMessageView onOpenBilling={() => {}} />);
    expect(screen.getByTestId('lifecycle-message-from').textContent).toBe(t('lifecycle.from'));
    expect(screen.getByRole('heading', { name: t('lifecycle.freeNudge.subject') })).toBeTruthy();
    expect(screen.getByTestId('lifecycle-message-body').textContent).toBe(t('lifecycle.freeNudge.body'));
    expect(screen.getByTestId('lifecycle-message-date').textContent).not.toBe('');
  });

  it('a trial note names the day the trial ends', () => {
    const end = '2026-11-05T10:00:00.000Z';
    useSettingsStore.setState({ billingProfile: { status: 'trialing', premiumAccess: true, hasSubscription: true, currentPeriodEnd: end } });
    useLifecycleStore.setState({ rows: [row('trial-ending:20400', 'trial-ending')], openId: 'trial-ending:20400' });
    render(<LifecycleMessageView onOpenBilling={() => {}} />);
    expect(screen.getByTestId('lifecycle-message-body').textContent)
      .toBe(t('lifecycle.trialEnding.body', { date: formatDateLong(end) }));
  });

  it('says plainly that it was written by the app and how to turn it off', () => {
    useLifecycleStore.setState({ rows: [row('free-nudge', 'free-nudge')], openId: 'free-nudge' });
    render(<LifecycleMessageView onOpenBilling={() => {}} />);
    expect(screen.getByTestId('lifecycle-message-footer').textContent).toBe(t('lifecycle.footer'));
  });

  it('the button opens Billing', () => {
    const onOpenBilling = vi.fn();
    useLifecycleStore.setState({ rows: [row('plan-ended:1', 'plan-ended')], openId: 'plan-ended:1' });
    render(<LifecycleMessageView onOpenBilling={onOpenBilling} />);
    fireEvent.click(screen.getByTestId('lifecycle-open-billing'));
    expect(onOpenBilling).toHaveBeenCalledOnce();
  });

  it('Close returns to the empty reader', () => {
    useLifecycleStore.setState({ rows: [row('free-nudge', 'free-nudge')], openId: 'free-nudge' });
    render(<LifecycleMessageView onOpenBilling={() => {}} />);
    fireEvent.click(screen.getByTestId('lifecycle-message-close'));
    expect(useLifecycleStore.getState().openId).toBeNull();
  });

  it('the free note tells the Premium story in illustrated scenes, then what stays free', () => {
    useLifecycleStore.setState({ rows: [row('free-nudge', 'free-nudge')], openId: 'free-nudge' });
    render(<LifecycleMessageView onOpenBilling={() => {}} />);
    const scenes = screen.getAllByTestId('lifecycle-scene');
    expect(scenes.map((li) => li.dataset.scene)).toEqual(['backups', 'cleanup', 'privacy']);
    for (const li of scenes) {
      const id = li.dataset.scene;
      expect(li.textContent).toContain(t(`lifecycle.freeNudge.scene.${id}.title`));
      expect(li.textContent).toContain(t(`lifecycle.freeNudge.scene.${id}.blurb`));
      expect(li.querySelector('img')?.getAttribute('src')).toBeTruthy();
    }
    const free = screen.getByTestId('lifecycle-free-feature');
    expect(free.textContent).toContain(t('lifecycle.freeNudge.freeTitle'));
    expect(free.textContent).toContain(t('lifecycle.freeBadge'));
    expect(screen.getByTestId('lifecycle-message-outro').textContent).toBe(t('lifecycle.freeNudge.outro'));
    const star = screen.getByTestId('lifecycle-star');
    expect(star.textContent).toContain(t('lifecycle.freeNudge.star.title'));
    expect(star.textContent).toContain(t('lifecycle.freeNudge.star.blurb'));
    const link = screen.getByTestId('lifecycle-star-link');
    expect(link.getAttribute('href')).toBe('https://github.com/GraphicMeat/mail-vault-app');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.textContent).toBe(t('lifecycle.freeNudge.star.link'));
  });

  it('other notes carry no feature list', () => {
    useLifecycleStore.setState({ rows: [row('plan-ended:1', 'plan-ended')], openId: 'plan-ended:1' });
    render(<LifecycleMessageView onOpenBilling={() => {}} />);
    expect(screen.queryAllByTestId('lifecycle-scene')).toHaveLength(0);
    expect(screen.queryByTestId('lifecycle-star')).toBeNull();
    expect(screen.queryByTestId('lifecycle-message-outro')).toBeNull();
    expect(screen.queryByTestId('lifecycle-free-feature')).toBeNull();
  });

  it.each([
    ['trial-ending', 'lifecycle.trialEnding.cta'],
    ['checkout-left', 'lifecycle.checkoutLeft.cta'],
    ['plan-ended', 'lifecycle.planEnded.cta'],
  ])('the %s note names its own next step on the button, never "Open Billing"', (kind, ctaKey) => {
    useLifecycleStore.setState({ rows: [row(`${kind}:1`, kind)], openId: `${kind}:1` });
    render(<LifecycleMessageView onOpenBilling={() => {}} />);
    const label = screen.getByTestId('lifecycle-open-billing').textContent;
    expect(label).toBe(t(ctaKey));
    expect(label).not.toBe(ctaKey);
    expect(label).not.toMatch(/open billing/i);
  });

  it('renders nothing for a kind this version does not know', () => {
    useLifecycleStore.setState({ rows: [row('x', 'from-the-future')], openId: 'x' });
    const { container } = render(<LifecycleMessageView onOpenBilling={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  describe('the offer in the free note', () => {
    const eur = { currency: 'eur', monthly: 400, yearly: 2500, pricingMode: 'manual', standardMonthly: 600, standardYearly: 3900, trialDays: 14 };
    const open = (kind = 'free-nudge', onOpenBilling = () => {}) => {
      useLifecycleStore.setState({ rows: [row(kind, kind)], openId: kind });
      render(<LifecycleMessageView onOpenBilling={onOpenBilling} />);
    };
    const price = (plan) => screen.getByTestId(`lifecycle-plan-${plan}`);

    it('is a limited offer for you, family and friends, with two plan buttons in the local currency', () => {
      useSettingsStore.setState({ premiumPricing: { ...eur, fetchedAt: Date.now() } });
      open();
      const offer = screen.getByTestId('lifecycle-offer');
      expect(offer.textContent).toContain(t('lifecycle.freeNudge.offer.title'));
      expect(offer.textContent).toContain(t('lifecycle.freeNudge.offer.blurb'));
      const buttons = offer.querySelectorAll('button');
      expect([...buttons].map((b) => b.dataset.testid)).toEqual(['lifecycle-plan-yearly', 'lifecycle-plan-monthly']);
    });

    it('yearly is the best offer: try Premium free, then the yearly price, 36% off the struck standard price', () => {
      useSettingsStore.setState({ premiumPricing: { ...eur, fetchedAt: Date.now() } });
      open();
      const yearly = price('yearly');
      expect(yearly.textContent).toContain(t('lifecycle.freeNudge.offer.bestOffer'));
      expect(yearly.textContent).toContain(t('lifecycle.freeNudge.cta'));
      expect(yearly.textContent).toContain(t('lifecycle.freeNudge.offer.trialDays', { days: 14 }));
      expect(yearly.textContent).toContain(t('lifecycle.freeNudge.offer.perYear', { price: '€25' }));
      expect(yearly.textContent).toContain(t('lifecycle.freeNudge.offer.off', { percent: 36 }));
      expect(yearly.querySelector('s').textContent).toBe('€39');
    });

    it('monthly quotes its own price, 33% off the struck standard price', () => {
      useSettingsStore.setState({ premiumPricing: { ...eur, fetchedAt: Date.now() } });
      open();
      const monthly = price('monthly');
      expect(monthly.textContent).toContain(t('settings.billing.monthly'));
      expect(monthly.textContent).toContain(t('lifecycle.freeNudge.offer.perMonth', { price: '€4' }));
      expect(monthly.textContent).toContain(t('lifecycle.freeNudge.offer.off', { percent: 33 }));
      expect(monthly.querySelector('s').textContent).toBe('€6');
      expect(monthly.textContent).not.toContain(t('lifecycle.freeNudge.offer.bestOffer'));
    });

    it.each(['yearly', 'monthly'])('the %s button opens Billing with that plan chosen', (plan) => {
      useSettingsStore.setState({ premiumPricing: { ...eur, fetchedAt: Date.now() } });
      const onOpenBilling = vi.fn();
      open('free-nudge', onOpenBilling);
      fireEvent.click(price(plan));
      expect(useSettingsStore.getState().billingPlanChoice).toBe(plan);
      expect(onOpenBilling).toHaveBeenCalledOnce();
    });

    it('the free note has no separate button: the plans are the buttons', () => {
      useSettingsStore.setState({ premiumPricing: { ...eur, fetchedAt: Date.now() } });
      open();
      expect(screen.queryByTestId('lifecycle-open-billing')).toBeNull();
    });

    it('a customer who already had a trial is not offered one', () => {
      useSettingsStore.setState({ premiumPricing: { ...eur, trialDays: 0, fetchedAt: Date.now() } });
      open();
      expect(price('yearly').textContent).not.toContain(t('lifecycle.freeNudge.cta'));
      expect(price('yearly').textContent).toContain(t('settings.billing.yearly'));
    });

    it('once early access is over it quotes the prices without calling them limited or discounted', () => {
      useSettingsStore.setState({ premiumPricing: { ...eur, monthly: 600, yearly: 3900, fetchedAt: Date.now() } });
      open();
      expect(screen.getByTestId('lifecycle-offer').textContent).not.toContain(t('lifecycle.freeNudge.offer.title'));
      expect(price('yearly').querySelector('s')).toBeNull();
      expect(price('yearly').textContent).not.toMatch(/% off/);
      expect(price('yearly').textContent).toContain(t('lifecycle.freeNudge.offer.perYear', { price: '€39' }));
    });

    it('where checkout converts the currency, it says so under the plans', () => {
      useSettingsStore.setState({ premiumPricing: { ...eur, pricingMode: 'adaptive', fetchedAt: Date.now() } });
      open();
      expect(screen.getByTestId('lifecycle-offer-currency').textContent)
        .toBe(t('settings.billing.pricesShownCheckoutConvertLocal', { pricing: 'EUR' }));
    });

    it('a price in the local currency needs no currency note', () => {
      useSettingsStore.setState({ premiumPricing: { ...eur, fetchedAt: Date.now() } });
      open();
      expect(screen.queryByTestId('lifecycle-offer-currency')).toBeNull();
    });

    it.each(['trial-ending', 'checkout-left', 'plan-ended'])('the %s note quotes no price', (kind) => {
      useSettingsStore.setState({ premiumPricing: { ...eur, fetchedAt: Date.now() } });
      open(kind);
      expect(screen.queryByTestId('lifecycle-offer')).toBeNull();
      expect(screen.getByTestId('lifecycle-open-billing')).toBeTruthy();
    });
  });
});
