// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { setLocale, t } from '../../../i18n/index.js';

const { PlanPicker, planCtaLabel, defaultPlanId } = await import('../PlanPicker');

const MONTHLY = { planId: 'monthly', interval: 'month', amount: 400, formattedAmount: '$4', trialDays: 0, trialEligible: true };
const YEARLY = {
  planId: 'yearly', interval: 'year', amount: 2500, formattedAmount: '$25', monthlyEquivalent: '$2',
  savingsPercent: 48, trialDays: 14, trialEligible: true,
};

beforeEach(async () => { await setLocale('en'); });
afterEach(cleanup);

describe('PlanPicker', () => {
  it('lists yearly first, as radios, with the selected plan checked', () => {
    render(<PlanPicker plans={[MONTHLY, YEARLY]} selectedId="yearly" onSelect={() => {}} />);
    const radios = screen.getAllByRole('radio');
    expect(radios.map(r => r.value)).toEqual(['yearly', 'monthly']);
    expect(radios[0].checked).toBe(true);
    expect(radios[1].checked).toBe(false);
  });

  it('shows the price of each plan and what yearly saves against monthly', () => {
    render(<PlanPicker plans={[MONTHLY, YEARLY]} selectedId="yearly" onSelect={() => {}} />);
    const yearly = screen.getByTestId('plan-yearly');
    expect(within(yearly).getByText(/\$25/)).toBeTruthy();
    expect(within(yearly).getByText(t('settings.billing.savePercent', { percent: 48 }))).toBeTruthy();
    expect(within(screen.getByTestId('plan-monthly')).getByText(/\$4/)).toBeTruthy();
    expect(within(screen.getByTestId('plan-monthly')).queryByText(/Save/)).toBeNull();
  });

  it('says the trial length and what follows it only for a trial-eligible yearly plan', () => {
    const { rerender } = render(<PlanPicker plans={[MONTHLY, YEARLY]} selectedId="yearly" onSelect={() => {}} />);
    expect(within(screen.getByTestId('plan-yearly')).getByText(
      t('settings.billing.daysFreeThenMonth', { yearlyPlan: 14, yearlyPlan2: '$2' }))).toBeTruthy();
    rerender(<PlanPicker plans={[MONTHLY, { ...YEARLY, trialEligible: false }]} selectedId="yearly" onSelect={() => {}} />);
    expect(within(screen.getByTestId('plan-yearly')).queryByText(/days free/)).toBeNull();
    expect(within(screen.getByTestId('plan-yearly')).getByText('~$2/month')).toBeTruthy();
  });

  it('reports the plan the user picks', () => {
    const onSelect = vi.fn();
    render(<PlanPicker plans={[MONTHLY, YEARLY]} selectedId="yearly" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(t('settings.billing.monthly')) }));
    expect(onSelect).toHaveBeenCalledWith('monthly');
  });

  it('renders whatever plan it has when the other is missing', () => {
    render(<PlanPicker plans={[YEARLY]} selectedId="yearly" onSelect={() => {}} />);
    expect(screen.getAllByRole('radio')).toHaveLength(1);
  });
});

describe('planCtaLabel and defaultPlanId', () => {
  it('starts a trial on a trial-eligible yearly plan and upgrades otherwise', () => {
    expect(planCtaLabel(YEARLY)).toBe(t('settings.billing.startFreeTrial'));
    expect(planCtaLabel({ ...YEARLY, trialEligible: false })).toBe(t('common.upgrade'));
    expect(planCtaLabel(MONTHLY)).toBe(t('common.upgrade'));
  });

  it('preselects yearly, else the only plan, else nothing', () => {
    expect(defaultPlanId([MONTHLY, YEARLY])).toBe('yearly');
    expect(defaultPlanId([MONTHLY])).toBe('monthly');
    expect(defaultPlanId([])).toBeNull();
    expect(defaultPlanId(undefined)).toBeNull();
  });
});
