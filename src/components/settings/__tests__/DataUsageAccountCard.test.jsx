// @vitest-environment jsdom

/**
 * The daily limit governs BACKGROUND downloads (backups, Hoarder, download-
 * ahead) and never everyday mail, so the card says exactly that: the toggle is
 * "Pause background downloads at daily limit", its hint says new mail keeps
 * arriving, and on a Gmail account an empty field shows what applies (2,500 MB
 * down, 500 up with the cap off; the 2,000 MB default with it on) as its placeholder.
 *
 * "Gmail" is decided by the account's IMAP host, the way the daemon decides it
 * (`default_limits(host)`), not by the email domain.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

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
    renderCard(GMAIL);
    expect(downInput().getAttribute('placeholder')).toBe('2000');
    expect(upInput().getAttribute('placeholder')).toBe('500');
  });

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

  it('decides by IMAP host: Google Workspace is Gmail, a forwarded @gmail.com is not', () => {
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
    renderCard(GMAIL);
    expect(downInput().value).toBe('1500');
  });
});

describe('DataUsageAccountCard usage bar on a Gmail account', () => {
  const MB = 1024 * 1024;
  const bar = (account) => render(<DataUsageAccountCard account={account} stats={{ today: { down: 100 * MB, up: 10 * MB } }} />);

  it('measures today against Gmail\'s real 2,500 MB limit while the cap is off', () => {
    bar(GMAIL);
    const text = document.body.textContent;
    expect(text).toContain(`/ ${formatBytes(2500 * MB)}`);
    expect(text).not.toContain(`/ ${formatBytes(2000 * MB)}`);
  });

  it('measures against the 2,000 MB default once the cap is on', () => {
    useSettingsStore.setState({ transferLimits: { [GMAIL.id]: { capEnabled: true } } });
    bar(GMAIL);
    expect(document.body.textContent).toContain(`/ ${formatBytes(2000 * MB)}`);
  });
});
