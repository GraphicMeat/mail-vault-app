// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { setLocale, t } from '../../i18n/index.js';
import { formatDateLong } from '../../utils/dateFormat';
import { blurbFromAmounts } from '../../utils/pricing';

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
    expect(screen.getByTestId('lifecycle-open-billing').textContent).toBe(t('lifecycle.freeNudge.cta'));
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
    ['free-nudge', 'lifecycle.freeNudge.cta'],
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
    const gbp = { currency: 'gbp', monthly: 350, yearly: 2100, pricingMode: 'manual', standardMonthly: 500, standardYearly: 3300 };
    const open = (kind = 'free-nudge') => {
      useLifecycleStore.setState({ rows: [row(kind, kind)], openId: kind });
      render(<LifecycleMessageView onOpenBilling={() => {}} />);
    };

    it('quotes the price in the local currency, the standard price struck, as a limited offer for family and friends', () => {
      useSettingsStore.setState({ premiumPricing: { ...gbp, fetchedAt: Date.now() } });
      open();
      const offer = screen.getByTestId('lifecycle-offer');
      expect(offer.textContent).toContain(t('lifecycle.freeNudge.offer.title'));
      expect(offer.textContent).toContain(t('lifecycle.freeNudge.offer.blurb'));
      expect(screen.getByTestId('lifecycle-offer-price').textContent).toBe(blurbFromAmounts(350, 2100, 'gbp'));
      const standard = screen.getByTestId('lifecycle-offer-standard');
      expect(standard.textContent).toBe(blurbFromAmounts(500, 3300, 'gbp'));
      expect(standard.tagName).toBe('S');
    });

    it('once early access is over it quotes the price without calling it limited', () => {
      useSettingsStore.setState({ premiumPricing: { ...gbp, monthly: 500, yearly: 3300, fetchedAt: Date.now() } });
      open();
      expect(screen.getByTestId('lifecycle-offer-price').textContent).toBe(blurbFromAmounts(500, 3300, 'gbp'));
      expect(screen.getByTestId('lifecycle-offer').textContent).not.toContain(t('lifecycle.freeNudge.offer.title'));
      expect(screen.queryByTestId('lifecycle-offer-standard')).toBeNull();
    });

    it('where checkout converts the currency, it says so under the price', () => {
      useSettingsStore.setState({ premiumPricing: { ...gbp, currency: 'eur', pricingMode: 'adaptive', fetchedAt: Date.now() } });
      open();
      expect(screen.getByTestId('lifecycle-offer-currency').textContent)
        .toBe(t('settings.billing.pricesShownCheckoutConvertLocal', { pricing: 'EUR' }));
    });

    it('a price in the local currency needs no currency note', () => {
      useSettingsStore.setState({ premiumPricing: { ...gbp, fetchedAt: Date.now() } });
      open();
      expect(screen.queryByTestId('lifecycle-offer-currency')).toBeNull();
    });

    it.each(['trial-ending', 'checkout-left', 'plan-ended'])('the %s note quotes no price', (kind) => {
      useSettingsStore.setState({ premiumPricing: { ...gbp, fetchedAt: Date.now() } });
      open(kind);
      expect(screen.queryByTestId('lifecycle-offer')).toBeNull();
    });
  });
});
