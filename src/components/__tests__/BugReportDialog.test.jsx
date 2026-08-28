// @vitest-environment jsdom
//
// The bug button used to go straight to an email nobody else could read. The
// dialog exists so a report can land in a public thread instead — so what this
// guards is the routing: three channels, the two GitHub ones on the live
// discussion URLs, email last as the private fallback, and the warning that
// stops a log full of email addresses being pasted into a public thread.

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const openInBrowser = vi.fn(() => Promise.resolve(true));
vi.mock('../../services/billingApi', () => ({ openInBrowser: (url) => openInBrowser(url) }));

import { BugReportDialog } from '../BugReportDialog';

const click = (testid) => fireEvent.click(screen.getByTestId(testid).querySelector('button'));

afterEach(() => { cleanup(); openInBrowser.mockClear(); });

describe('BugReportDialog', () => {
  it('renders nothing while closed', () => {
    render(<BugReportDialog open={false} onClose={() => {}} onEmail={() => {}} />);
    expect(screen.queryByTestId('bug-report-dialog')).toBeNull();
  });

  it('files a new report in the bug-reports category, not the generic new-discussion page', () => {
    const onClose = vi.fn();
    render(<BugReportDialog open onClose={onClose} onEmail={() => {}} />);
    click('bug-option-github');
    expect(openInBrowser).toHaveBeenCalledWith(
      'https://github.com/GraphicMeat/mail-vault-app/discussions/new?category=bug-reports'
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('opens the discussion index for browsing existing reports', () => {
    render(<BugReportDialog open onClose={() => {}} onEmail={() => {}} />);
    click('bug-option-discussions');
    expect(openInBrowser).toHaveBeenCalledWith('https://github.com/GraphicMeat/mail-vault-app/discussions');
  });

  it('keeps the email channel — it hands off to compose, it does not open a browser', () => {
    const onEmail = vi.fn();
    render(<BugReportDialog open onClose={() => {}} onEmail={onEmail} />);
    click('bug-option-email');
    expect(onEmail).toHaveBeenCalled();
    expect(openInBrowser).not.toHaveBeenCalled();
  });

  it('offers email last — the public thread is the first thing read', () => {
    render(<BugReportDialog open onClose={() => {}} onEmail={() => {}} />);
    const order = [...screen.getByTestId('bug-report-dialog').querySelectorAll('[data-testid^="bug-option-"]')]
      .map(el => el.dataset.testid);
    expect(order).toEqual(['bug-option-github', 'bug-option-discussions', 'bug-option-email']);
  });

  it('warns against posting logs to the public thread, and names email as the way to send them', () => {
    render(<BugReportDialog open onClose={() => {}} onEmail={() => {}} />);
    const note = screen.getByTestId('bug-privacy-note').textContent;
    expect(note).toMatch(/logs/i);
    expect(note).toMatch(/email addresses/i);
    expect(note).toMatch(/email instead/i);
  });

  it('links the X profile and the maker site', () => {
    const onClose = vi.fn();
    render(<BugReportDialog open onClose={onClose} onEmail={() => {}} />);

    fireEvent.click(screen.getByTestId('bug-follow-x'));
    expect(openInBrowser).toHaveBeenCalledWith('https://x.com/GraphicMeat');

    fireEvent.click(screen.getByTestId('bug-maker-logo'));
    expect(openInBrowser).toHaveBeenCalledWith('https://graphicmeat.com');

    expect(screen.getByAltText('Graphic Meat')).toBeTruthy();
    expect(screen.getByTestId('bug-report-dialog').textContent).toContain('Cooked over an');
  });
});
