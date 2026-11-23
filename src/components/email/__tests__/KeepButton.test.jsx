// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../../../stores/safeStorage', () => ({ safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }));
const { KeepButton } = await import('../KeepButton');
const { useKeepStore } = await import('../../../stores/keepStore');
const { useMailStore } = await import('../../../stores/mailStore');
const { DEFAULT_DOCK } = await import('../../../shared/keep');

const email = (extra = {}) => ({
  uid: 7, subject: 'Quarterly plan v3', from: { name: 'Sam Rivera', address: 'sam@x' },
  _accountId: 'a1', _mailbox: 'INBOX', ...extra,
});
const before = useMailStore.getState();

beforeEach(() => {
  useKeepStore.setState({ items: [], dock: DEFAULT_DOCK });
  useMailStore.setState({ activeAccountId: 'a1', activeMailbox: 'INBOX' });
});
afterEach(() => { cleanup(); useMailStore.setState({ activeAccountId: before.activeAccountId, activeMailbox: before.activeMailbox }); });

describe('KeepButton', () => {
  it('keeps the open email and shows it pressed', () => {
    render(<KeepButton email={email()} />);
    const button = screen.getByTestId('keep-toggle');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(useKeepStore.getState().items[0]).toMatchObject({
      accountId: 'a1', mailbox: 'INBOX', uid: 7, subject: 'Quarterly plan v3',
      sender: { name: 'Sam Rivera', address: 'sam@x' },
    });
  });

  it('pressed again removes it from the bubble', () => {
    render(<KeepButton email={email()} />);
    fireEvent.click(screen.getByTestId('keep-toggle'));
    fireEvent.click(screen.getByTestId('keep-toggle'));
    expect(useKeepStore.getState().items).toEqual([]);
    expect(screen.getByTestId('keep-toggle').getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps a unified-inbox email in its own folder', () => {
    useMailStore.setState({ activeAccountId: 'a1', activeMailbox: 'UNIFIED' });
    render(<KeepButton email={email({ _accountId: 'a2', _mailbox: 'Work' })} />);
    fireEvent.click(screen.getByTestId('keep-toggle'));
    expect(useKeepStore.getState().items.map(i => `${i.accountId}|${i.mailbox}|${i.uid}`)).toEqual(['a2|Work|7']);
  });

  it('is disabled when the email has no folder', () => {
    useMailStore.setState({ activeAccountId: 'a1', activeMailbox: 'UNIFIED' });
    render(<KeepButton email={email({ _mailbox: undefined })} />);
    expect(screen.getByTestId('keep-toggle').disabled).toBe(true);
  });
});
