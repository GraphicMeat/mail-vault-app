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

  it('renders nothing for a kind this version does not know', () => {
    useLifecycleStore.setState({ rows: [row('x', 'from-the-future')], openId: 'x' });
    const { container } = render(<LifecycleMessageView onOpenBilling={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
