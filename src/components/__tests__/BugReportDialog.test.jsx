// @vitest-environment jsdom
//
// The bug button used to go straight to an email nobody else could read. The
// dialog exists so a report can land in a public thread instead — so what this
// guards is the routing: five channels ordered as a deflection ladder (FAQ,
// then existing discussions, then a new report), the three GitHub ones on the
// live discussion URLs (bug reports and ideas land in DIFFERENT categories),
// the FAQ row on the SITE DIRECTORY of the running language, and the warning
// that stops a log full of email addresses being pasted into a public thread.

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const openInBrowser = vi.fn(() => Promise.resolve(true));
vi.mock('../../services/billingApi', () => ({ openInBrowser: (url) => openInBrowser(url) }));
// The dialog reads the language to pick the FAQ directory; `useT` reads
// localeEpoch off the same store, so the selector has to be honoured.
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: (sel) => (typeof sel === 'function'
    ? sel({ language: 'de', localeEpoch: 0 })
    : { language: 'de', localeEpoch: 0 }),
}));

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

  it('orders the channels as a deflection ladder — FAQ first, feature request last', () => {
    render(<BugReportDialog open onClose={() => {}} onEmail={() => {}} />);
    const order = [...screen.getByTestId('bug-report-dialog').querySelectorAll('[data-testid^="bug-option-"]')]
      .map(el => el.dataset.testid);
    expect(order).toEqual([
      'bug-option-faq', 'bug-option-discussions', 'bug-option-github',
      'bug-option-email', 'bug-option-idea',
    ]);
  });

  // `pt-BR`/`zh-Hans` are app codes; the site serves `pt-br`/`zh`. Passing the
  // app code straight through 404s, which is why this asserts the built URL
  // rather than that some FAQ link exists.
  it('opens the FAQ in the running language, not the English one', () => {
    const onClose = vi.fn();
    render(<BugReportDialog open onClose={onClose} onEmail={() => {}} />);
    click('bug-option-faq');
    expect(openInBrowser).toHaveBeenCalledWith('https://mailvaultapp.com/de/faq.html');
    expect(onClose).toHaveBeenCalled();
  });

  it('files a feature request in Ideas, not in the bug category', () => {
    const onClose = vi.fn();
    render(<BugReportDialog open onClose={onClose} onEmail={() => {}} />);
    click('bug-option-idea');
    expect(openInBrowser).toHaveBeenCalledWith(
      'https://github.com/GraphicMeat/mail-vault-app/discussions/new?category=ideas'
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('says in the header that a feature request belongs here too', () => {
    render(<BugReportDialog open onClose={() => {}} onEmail={() => {}} />);
    const text = screen.getByTestId('bug-report-dialog').textContent;
    expect(text).toContain('suggest a feature');
    expect(text).toContain('ask for something missing');
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
