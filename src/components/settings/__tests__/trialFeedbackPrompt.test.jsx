// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const openInBrowser = vi.fn(() => Promise.resolve(true));
vi.mock('../../../services/billingApi', () => ({ openInBrowser: (url) => openInBrowser(url) }));

import { TrialFeedbackPrompt, isTrialing } from '../TrialFeedbackPrompt';

afterEach(() => { cleanup(); openInBrowser.mockClear(); });

describe('isTrialing', () => {
  it('is true only for a subscription in its free trial', () => {
    expect(isTrialing({ hasSubscription: true, status: 'trialing' })).toBe(true);
    expect(isTrialing({ hasSubscription: true, status: 'active' })).toBe(false);
    expect(isTrialing({ hasSubscription: false, status: 'trialing' })).toBe(false);
    expect(isTrialing({ hasSubscription: true, status: 'canceled' })).toBe(false);
    expect(isTrialing(null)).toBe(false);
  });
});

describe('TrialFeedbackPrompt', () => {
  it('asks whether the trial user is having issues', () => {
    render(<TrialFeedbackPrompt onReportBug={() => {}} />);
    expect(screen.getByTestId('trial-feedback-question').textContent).toMatch(/having issues with MailVault/i);
    expect(screen.getByTestId('trial-feedback-yes')).toBeTruthy();
    expect(screen.getByTestId('trial-feedback-no')).toBeTruthy();
    // Nothing to report until they say so.
    expect(screen.queryByTestId('trial-feedback-report')).toBeNull();
  });

  it('on Yes offers the report-a-bug menu and the promise to answer fast', () => {
    const onReportBug = vi.fn();
    render(<TrialFeedbackPrompt onReportBug={onReportBug} />);
    fireEvent.click(screen.getByTestId('trial-feedback-yes'));

    expect(screen.getByTestId('trial-feedback-promise').textContent).toMatch(/satisf/i);
    expect(screen.getByTestId('trial-feedback-promise').textContent).toMatch(/quickly/i);

    const report = screen.getByTestId('trial-feedback-report');
    expect(report.textContent).toBe('Report a bug or suggest a feature');
    fireEvent.click(report);
    expect(onReportBug).toHaveBeenCalledTimes(1);
  });

  it('links the discussion thread', () => {
    render(<TrialFeedbackPrompt onReportBug={() => {}} />);
    fireEvent.click(screen.getByTestId('trial-feedback-yes'));
    const link = screen.getByTestId('trial-feedback-thread');
    expect(link.dataset.url).toBe('https://github.com/GraphicMeat/mail-vault-app/discussions/1');
    fireEvent.click(link);
    expect(openInBrowser).toHaveBeenCalledWith('https://github.com/GraphicMeat/mail-vault-app/discussions/1');
  });

  it('on No says thanks and shows nothing to report', () => {
    render(<TrialFeedbackPrompt onReportBug={() => {}} />);
    fireEvent.click(screen.getByTestId('trial-feedback-no'));
    expect(screen.getByTestId('trial-feedback-thanks')).toBeTruthy();
    expect(screen.queryByTestId('trial-feedback-report')).toBeNull();
    expect(screen.queryByTestId('trial-feedback-yes')).toBeNull();
  });
});
