// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../../stores/safeStorage', () => ({ safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }));
const { KeepDock } = await import('../KeepDock');
const { useKeepStore } = await import('../../stores/keepStore');
const { useMailStore } = await import('../../stores/mailStore');
const { DEFAULT_DOCK } = await import('../../shared/keep');

const SAM = { name: 'Sam Rivera', address: 'sam@x' };
const kept = (accountId, uid, keptAt, sender = SAM) => ({ accountId, mailbox: 'INBOX', uid, subject: `Mail ${uid}`, sender, keptAt });
const before = useMailStore.getState().accounts;

beforeEach(() => {
  useMailStore.setState({ accounts: [{ id: 'a1' }] });
  useKeepStore.setState({ items: [kept('a1', 1, 10), kept('a1', 2, 20), kept('a1', 3, 30, { name: 'Lena', address: 'lena@x' })], dock: DEFAULT_DOCK });
});
afterEach(() => { cleanup(); useMailStore.setState({ accounts: before }); });

const samBubble = () => screen.getAllByTestId('keep-bubble')[0];

describe('desktop KeepDock', () => {
  it('clicking a kept subject opens it in its own folder', () => {
    const onOpen = vi.fn();
    render(<KeepDock onOpen={onOpen} />);
    fireEvent.pointerDown(samBubble(), { pointerType: 'mouse' });
    fireEvent.click(samBubble());
    fireEvent.click(within(screen.getByTestId('keep-panel')).getAllByTestId('keep-row')[0]);
    expect(onOpen).toHaveBeenCalledWith({ accountId: 'a1', mailbox: 'INBOX', uid: 2 });
    expect(useKeepStore.getState().items).toHaveLength(3);
  });

  it('the close button removes the stack from the store', () => {
    render(<KeepDock onOpen={vi.fn()} />);
    fireEvent.click(samBubble());
    fireEvent.click(screen.getByTestId('keep-panel-close'));
    expect(useKeepStore.getState().items.map(i => i.uid)).toEqual([3]);
    expect(screen.getAllByTestId('keep-bubble')).toHaveLength(1);
  });

  it('drops kept email after account removal on desktop', () => {
    useKeepStore.setState({ items: [kept('gone', 5, 50, { name: 'Zed', address: 'zed@x' })] });
    render(<KeepDock onOpen={vi.fn()} />);
    expect(screen.queryByTestId('keep-dock')).toBeNull();
  });

  it("a group's count leaves out a removed account's emails", () => {
    useKeepStore.setState({ items: [kept('a1', 1, 10), kept('a1', 2, 20), kept('gone', 9, 90)] });
    render(<KeepDock onOpen={vi.fn()} />);
    expect(screen.getByTestId('keep-count').textContent).toBe('2');
  });
});
