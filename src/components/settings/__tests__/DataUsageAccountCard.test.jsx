// @vitest-environment jsdom

/**
 * The daily limit governs BACKGROUND downloads (backups, Hoarder, download-
 * ahead) and never everyday mail, so the card says exactly that: the toggle is
 * "Pause background downloads at daily limit", its hint says new mail keeps
 * arriving, and on a Gmail account an empty field shows what applies (2,500 MB
 * down, 500 up with the cap off; the 2,000 MB default with it on) as its placeholder.
 *
 * The figures are the daemon's (`policy.accounts`, `transfer`; "Gmail" by the
 * IMAP host, the limits and defaults pinned by
 * src-core/tests/fixtures/transfer-limits-cases.json). These specs hand the
 * card the daemon's answers and check what it shows of them.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const MB = 1024 * 1024;
// accountId -> the daemon's `transfer` answer.
const answers = vi.hoisted(() => ({}));
vi.mock('../../../services/accountPolicy', () => ({
  useAccountPolicy: (account) => (account?.id in answers ? { fetch: null, transfer: answers[account.id] } : undefined),
}));
/** What the daemon answers for a Gmail host (or not), cap on or off, typed limits. */
function transfer({ gmail, cap = false, down = null, up = null }) {
  const side = (typed, capOn, capOff) => {
    const fallback = gmail ? (cap ? capOn : capOff) : null;
    return {
      limitBytes: typed ?? fallback, isProviderDefault: typed == null && fallback != null,
      defaultCapOn: gmail ? capOn : null, defaultCapOff: gmail ? capOff : null,
    };
  };
  return { gmail, capEnabled: cap, warnEnabled: true, down: side(down, 2000 * MB, 2500 * MB), up: side(up, 500 * MB, 500 * MB), today: { down: 0, up: 0 }, warning: null };
}

const { default: DataUsageAccountCard } = await import('../DataUsageAccountCard');
const { useSettingsStore } = await import('../../../stores/settingsStore');
const { formatBytes } = await import('../../../utils/formatBytes');

const PLAIN = { id: 'acc-plain', email: 'han@example.com', imapHost: 'imap.example.com' };
const GMAIL = { id: 'acc-gmail', email: 'leia@gmail.com', imapHost: 'imap.gmail.com' };
// A Workspace address on Google's servers: Gmail's limits apply to it.
const WORKSPACE = { id: 'acc-work', email: 'lando@cloudcity.example', imapHost: 'imap.gmail.com' };
// An @gmail.com address read through some other server: they do not.
const FORWARDED = { id: 'acc-fwd', email: 'chewie@gmail.com', imapHost: 'mail.kashyyyk.example' };

const renderCard = (account) => render(<DataUsageAccountCard account={account} stats={{ today: { down: 0, up: 0 } }} />);
const downInput = () => screen.getByLabelText('Daily download limit (MB)');
const upInput = () => screen.getByLabelText('Daily upload limit (MB)');

let snapshot;
beforeEach(() => {
  snapshot = useSettingsStore.getState();
  useSettingsStore.setState({ transferLimits: {}, accountColors: {} });
  for (const id of Object.keys(answers)) delete answers[id];
  answers[PLAIN.id] = transfer({ gmail: false });
  answers[GMAIL.id] = transfer({ gmail: true });
  answers[WORKSPACE.id] = transfer({ gmail: true });
  answers[FORWARDED.id] = transfer({ gmail: false });
});
afterEach(() => {
  cleanup();
  useSettingsStore.setState({ transferLimits: snapshot.transferLimits, accountColors: snapshot.accountColors });
});

describe('DataUsageAccountCard daily limit copy', () => {
  it('names the toggle for background downloads, and says new mail keeps arriving', () => {
    renderCard(PLAIN);

    expect(screen.getByRole('switch', { name: 'Pause background downloads at daily limit' })).toBeTruthy();
    expect(screen.queryByText('Pause sync at daily limit')).toBeNull();
    const hint = screen.getByTestId('pause-background-hint').textContent;
    expect(hint).toContain('Backups, Hoarder and download-ahead stop here for the day');
    expect(hint).toContain('new mail keeps arriving');
    expect(hint).not.toContain('Gmail');
  });

  it('adds why 2,000 MB on a Gmail account', () => {
    renderCard(GMAIL);

    const hint = screen.getByTestId('pause-background-hint').textContent;
    expect(hint).toContain('Gmail allows about 2,500 MB a day');
    expect(hint).toContain('2,000 MB leaves room for everyday mail');
  });

  it('switches the cap on and off through the store', () => {
    renderCard(PLAIN);
    const toggle = screen.getByRole('switch', { name: 'Pause background downloads at daily limit' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(toggle);

    expect(useSettingsStore.getState().transferLimits[PLAIN.id].capEnabled).toBe(true);
  });
});

describe('DataUsageAccountCard placeholders', () => {
  // With the cap OFF nothing of ours stops a download, so the figure shown is
  // Gmail's own limit (2,500 MB down, 500 up). Only with the cap ON does an
  // empty field mean the 2,000 MB default, the one the daemon enforces.
  it('shows Gmail\'s real limits with the cap off, 2500 down and 500 up', () => {
    renderCard(GMAIL);
    expect(downInput().getAttribute('placeholder')).toBe('2500');
    expect(upInput().getAttribute('placeholder')).toBe('500');
  });

  it('shows the 2000 MB default once the cap is on and the field is empty', () => {
    useSettingsStore.setState({ transferLimits: { [GMAIL.id]: { capEnabled: true } } });
    answers[GMAIL.id] = transfer({ gmail: true, cap: true });
    renderCard(GMAIL);
    expect(downInput().getAttribute('placeholder')).toBe('2000');
    expect(upInput().getAttribute('placeholder')).toBe('500');
  });

  // Before the change reaches the daemon: the placeholder follows the toggle.
  it('follows the toggle: switching the cap on moves the placeholder from 2500 to 2000', () => {
    renderCard(GMAIL);
    expect(downInput().getAttribute('placeholder')).toBe('2500');

    fireEvent.click(screen.getByRole('switch', { name: 'Pause background downloads at daily limit' }));

    expect(downInput().getAttribute('placeholder')).toBe('2000');
  });

  it('says Unlimited everywhere else, with the cap on or off', () => {
    renderCard(PLAIN);
    expect(downInput().getAttribute('placeholder')).toBe('Unlimited');
    expect(upInput().getAttribute('placeholder')).toBe('Unlimited');
    cleanup();

    useSettingsStore.setState({ transferLimits: { [PLAIN.id]: { capEnabled: true } } });
    renderCard(PLAIN);
    expect(downInput().getAttribute('placeholder')).toBe('Unlimited');
  });

  it('shows the daemon\'s Gmail answer: Google Workspace is Gmail, a forwarded @gmail.com is not', () => {
    renderCard(WORKSPACE);
    expect(downInput().getAttribute('placeholder')).toBe('2500');
    cleanup();

    renderCard(FORWARDED);
    expect(downInput().getAttribute('placeholder')).toBe('Unlimited');
    expect(screen.getByTestId('pause-background-hint').textContent).not.toContain('Gmail');
  });

  it('shows what the user typed, not the default', () => {
    useSettingsStore.setState({
      transferLimits: { [GMAIL.id]: { capEnabled: true, dailyDownLimitBytes: 1500 * 1024 * 1024 } },
    });
    answers[GMAIL.id] = transfer({ gmail: true, cap: true, down: 1500 * MB });
    renderCard(GMAIL);
    expect(downInput().value).toBe('1500');
  });
});

describe('DataUsageAccountCard usage bar on a Gmail account', () => {
  const bar = (account) => render(<DataUsageAccountCard account={account} stats={{ today: { down: 100 * MB, up: 10 * MB } }} />);

  it('measures today against Gmail\'s real 2,500 MB limit while the cap is off', () => {
    bar(GMAIL);
    const text = document.body.textContent;
    expect(text).toContain(`/ ${formatBytes(2500 * MB)}`);
    expect(text).not.toContain(`/ ${formatBytes(2000 * MB)}`);
  });

  it('measures against the 2,000 MB default once the cap is on', () => {
    useSettingsStore.setState({ transferLimits: { [GMAIL.id]: { capEnabled: true } } });
    answers[GMAIL.id] = transfer({ gmail: true, cap: true });
    bar(GMAIL);
    expect(document.body.textContent).toContain(`/ ${formatBytes(2000 * MB)}`);
  });
});

describe('DataUsageAccountCard before the daemon answers', () => {
  it('shows no limit and Unlimited placeholders, never a guessed figure', () => {
    delete answers[GMAIL.id];
    render(<DataUsageAccountCard account={GMAIL} stats={{ today: { down: 100 * MB, up: 0 } }} />);
    expect(document.body.textContent).not.toContain(`/ ${formatBytes(2500 * MB)}`);
    expect(downInput().getAttribute('placeholder')).toBe('Unlimited');
  });
});
