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
// `settingsState` is mutable so tests can arm the cooldown before render, and
// `setLastBugReportAt` is a real spy that writes back into it — vi.hoisted
// because vi.mock's factory is hoisted above these consts otherwise.
const { settingsState, setLastBugReportAt } = vi.hoisted(() => {
  const state = { language: 'de', localeEpoch: 0, lastBugReportAt: null };
  return { settingsState: state, setLastBugReportAt: vi.fn((at) => { state.lastBugReportAt = at; }) };
});
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: (sel) => {
    const state = { ...settingsState, setLastBugReportAt };
    return typeof sel === 'function' ? sel(state) : state;
  },
}));

import { BugReportDialog } from '../BugReportDialog';

const click = (testid) => fireEvent.click(screen.getByTestId(testid).querySelector('button'));

afterEach(() => {
  cleanup();
  openInBrowser.mockClear();
  setLastBugReportAt.mockClear();
  settingsState.lastBugReportAt = null;
});

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

  it('stamps the cooldown when a report is filed on GitHub', () => {
    render(<BugReportDialog open onClose={() => {}} onEmail={() => {}} />);
    click('bug-option-github');
    expect(setLastBugReportAt).toHaveBeenCalledTimes(1);
    expect(Math.abs(setLastBugReportAt.mock.calls[0][0] - Date.now())).toBeLessThan(1000);
  });

  it('does not stamp the cooldown just from opening the email compose window', () => {
    const onEmail = vi.fn();
    render(<BugReportDialog open onClose={() => {}} onEmail={onEmail} />);
    click('bug-option-email');
    expect(onEmail).toHaveBeenCalled();
    expect(setLastBugReportAt).not.toHaveBeenCalled();
  });

  it('disables GitHub and email with a countdown once a report was just filed, but leaves FAQ, Discussions and the idea row open', () => {
    settingsState.lastBugReportAt = Date.now() - 175_000; // 125s of the 300s left
    render(<BugReportDialog open onClose={() => {}} onEmail={() => {}} />);

    const githubButton = screen.getByTestId('bug-option-github').querySelector('button');
    const emailButton = screen.getByTestId('bug-option-email').querySelector('button');
    const ideaButton = screen.getByTestId('bug-option-idea').querySelector('button');
    expect(githubButton.disabled).toBe(true);
    expect(emailButton.disabled).toBe(true);
    expect(screen.getByTestId('bug-option-github').textContent).toContain('Available again in 2:05');
    expect(screen.getByTestId('bug-option-email').textContent).toContain('Available again in 2:05');

    // A feature idea is not a bug report: it is never gated by the cooldown.
    expect(ideaButton.disabled).toBe(false);
    expect(screen.getByTestId('bug-option-idea').textContent).not.toContain('Available again in');
    expect(screen.getByTestId('bug-option-idea').textContent).toContain('The thing you wish MailVault did');

    click('bug-option-faq');
    expect(openInBrowser).toHaveBeenCalledWith('https://mailvaultapp.com/de/faq.html');
    expect(screen.getByTestId('bug-option-discussions').querySelector('button').disabled).toBe(false);
  });

  it('lets a suggestion through GitHub while the cooldown is armed', () => {
    settingsState.lastBugReportAt = Date.now() - 10_000; // just filed, 290s left
    render(<BugReportDialog open onClose={() => {}} onEmail={() => {}} />);
    click('bug-option-idea');
    expect(openInBrowser).toHaveBeenCalledWith(
      'https://github.com/GraphicMeat/mail-vault-app/discussions/new?category=ideas'
    );
    expect(setLastBugReportAt).not.toHaveBeenCalled();
  });

  it('clamps the countdown to 5:00 even if the clock moved backwards after the stamp', () => {
    // lastBugReportAt in the future models a system clock moved back after the
    // stamp: Date.now() - lastBugReportAt is negative, so the naive
    // COOLDOWN_MS - elapsed subtraction would overshoot past 300s.
    settingsState.lastBugReportAt = Date.now() + 3_600_000;
    render(<BugReportDialog open onClose={() => {}} onEmail={() => {}} />);
    expect(screen.getByTestId('bug-option-github').textContent).toContain('Available again in 5:00');
    expect(screen.getByTestId('bug-option-github').querySelector('button').disabled).toBe(true);
  });

  it('ignores clicks on the disabled GitHub button while the cooldown is armed', () => {
    settingsState.lastBugReportAt = Date.now() - 10_000; // just filed, 290s left
    render(<BugReportDialog open onClose={() => {}} onEmail={() => {}} />);
    click('bug-option-github');
    expect(openInBrowser).not.toHaveBeenCalled();
    expect(setLastBugReportAt).not.toHaveBeenCalled();
  });

  it('re-enables report actions once the cooldown has fully elapsed', () => {
    settingsState.lastBugReportAt = Date.now() - 300_000;
    render(<BugReportDialog open onClose={() => {}} onEmail={() => {}} />);
    expect(screen.getByTestId('bug-option-github').querySelector('button').disabled).toBe(false);
    expect(screen.getByTestId('bug-option-email').querySelector('button').disabled).toBe(false);
  });
});
