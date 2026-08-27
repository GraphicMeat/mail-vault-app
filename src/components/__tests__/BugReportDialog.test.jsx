// @vitest-environment jsdom
//
// The bug button used to go straight to an email nobody else could read. The
// dialog exists so a report can land in a public thread instead — so what this
// guards is the routing: three channels, the two GitHub ones on the live
// discussion URLs, and the email one still reaching the compose template.

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
});
