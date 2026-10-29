// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const openInBrowser = vi.fn(() => Promise.resolve(true));
vi.mock('../../../services/billingApi', () => ({ openInBrowser: (url) => openInBrowser(url) }));

import { BillingIssuesDialog } from '../BillingIssuesDialog';

afterEach(() => { cleanup(); openInBrowser.mockClear(); });

function open(props = {}) {
  const handlers = { onClose: vi.fn(), onContinue: vi.fn(), onReportBug: vi.fn() };
  render(<BillingIssuesDialog {...handlers} {...props} />);
  return handlers;
}

describe('BillingIssuesDialog', () => {
  it('is a modal that asks whether they are having issues', () => {
    open();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('dialog').textContent).toMatch(/having issues with MailVault/i);
    expect(screen.getByTestId('billing-issues-yes')).toBeTruthy();
    expect(screen.getByTestId('billing-issues-no')).toBeTruthy();
    // Nothing to report until they say so.
    expect(screen.queryByTestId('billing-issues-report')).toBeNull();
  });

  it('under the question, before Yes or No, asks them to report issues and promises a quick turnaround', () => {
    open();
    const intro = screen.getByTestId('billing-issues-intro').textContent;
    expect(intro).toMatch(/report/i);
    expect(intro).toMatch(/care about every one/i);
    expect(intro).toMatch(/super quick/i);
    fireEvent.click(screen.getByTestId('billing-issues-yes'));
    expect(screen.queryByTestId('billing-issues-intro')).toBeNull();
  });

  it('on No carries on to Manage Subscription without a second step', () => {
    const { onContinue } = open();
    fireEvent.click(screen.getByTestId('billing-issues-no'));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('on Yes offers the report-a-bug menu and the promise to answer fast', () => {
    const { onReportBug, onClose, onContinue } = open();
    fireEvent.click(screen.getByTestId('billing-issues-yes'));

    expect(screen.getByTestId('billing-issues-promise').textContent).toMatch(/satisf/i);
    expect(screen.getByTestId('billing-issues-promise').textContent).toMatch(/quickly/i);

    const report = screen.getByTestId('billing-issues-report');
    expect(report.textContent).toBe('Report a bug or suggest a feature');
    fireEvent.click(report);
    expect(onReportBug).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('on Yes says reports are fixed in 6 to 12 hours, none too small, and why Gmail is slow', () => {
    open();
    expect(screen.queryByTestId('billing-issues-resolve')).toBeNull();
    fireEvent.click(screen.getByTestId('billing-issues-yes'));

    const resolve = screen.getByTestId('billing-issues-resolve').textContent;
    expect(resolve).toMatch(/6 to 12 hours/);
    expect(resolve).toMatch(/too small/i);

    const legacy = screen.getByTestId('billing-issues-legacy').textContent;
    expect(legacy).toMatch(/old technology/i);
    expect(legacy).toMatch(/Gmail/);
    expect(legacy).toMatch(/2500 MB a day/);
  });

  it('on Yes still lets them go on to Manage Subscription', () => {
    const { onContinue } = open();
    fireEvent.click(screen.getByTestId('billing-issues-yes'));
    fireEvent.click(screen.getByTestId('billing-issues-continue'));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('links the discussion thread', () => {
    open();
    fireEvent.click(screen.getByTestId('billing-issues-yes'));
    const link = screen.getByTestId('billing-issues-thread');
    expect(link.dataset.url).toBe('https://github.com/GraphicMeat/mail-vault-app/discussions/1');
    fireEvent.click(link);
    expect(openInBrowser).toHaveBeenCalledWith('https://github.com/GraphicMeat/mail-vault-app/discussions/1');
  });

  it('closing it (Escape) stays put: nothing is opened', () => {
    const { onClose, onContinue } = open();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    expect(onContinue).not.toHaveBeenCalled();
  });
});
