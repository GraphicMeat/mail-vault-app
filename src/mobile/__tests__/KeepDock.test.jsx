// @vitest-environment jsdom
// The phone's kept-email dock: one bubble per sender over this device's store, opening through the
// notification-tap path, Back folding an open group first.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';

const { default: KeepDock } = await import('../KeepDock.jsx');
const { useKeepStore } = await import('../keep.js');
const { useMobileStore } = await import('../store.js');
const { DEFAULT_DOCK } = await import('../../shared/keep.js');

const ADA = { name: 'Ada Lovelace', address: 'ada@x' };
const kept = (accountId, uid, keptAt, sender = ADA) => ({ accountId, mailbox: 'INBOX', uid, subject: `Mail ${uid}`, sender, keptAt });
const popstate = () => act(async () => { window.dispatchEvent(new PopStateEvent('popstate')); });
const adaBubble = () => screen.getByLabelText(/Ada Lovelace/);

beforeEach(() => {
  localStorage.clear();
  useMobileStore.setState({ accounts: [{ id: 'a1' }] });
  useKeepStore.setState({ items: [kept('a1', 1, 10), kept('a1', 2, 20), kept('a1', 3, 30)], dock: DEFAULT_DOCK });
});
// A layer taken down asks the history to go back (backStack.js); let that traversal land before the next test.
afterEach(async () => {
  cleanup();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
});

describe('phone KeepDock', () => {
  it('a kept row opens through the notification path', () => {
    const onOpen = vi.fn();
    render(<KeepDock onOpen={onOpen} />);
    fireEvent.pointerDown(adaBubble(), { pointerType: 'touch' });
    fireEvent.click(adaBubble());
    fireEvent.click(within(screen.getByTestId('keep-panel')).getAllByTestId('keep-row')[0]);
    expect(onOpen).toHaveBeenCalledWith({ accountId: 'a1', folder: 'INBOX', uid: 3 });
    expect(screen.queryByTestId('keep-panel')).toBeNull();
    expect(useKeepStore.getState().items).toHaveLength(3);
  });

  it('Back collapses the expanded group first', async () => {
    render(<KeepDock onOpen={vi.fn()} />);
    fireEvent.click(adaBubble());
    expect(screen.getByTestId('keep-panel')).toBeTruthy();
    await popstate();
    expect(screen.queryByTestId('keep-panel')).toBeNull();
    expect(useKeepStore.getState().items).toHaveLength(3);
  });

  it('drops kept email after account removal on the phone', () => {
    useKeepStore.setState({ items: [kept('gone', 1, 10)] });
    render(<KeepDock onOpen={vi.fn()} />);
    expect(screen.queryByTestId('keep-dock')).toBeNull();
  });

  it("a hidden account's kept emails stay out of the bubble", () => {
    useMobileStore.setState({ accounts: [{ id: 'a1' }, { id: 'a2', hidden: true }] });
    useKeepStore.setState({ items: [kept('a1', 1, 10), kept('a2', 2, 20)] });
    render(<KeepDock onOpen={vi.fn()} />);
    expect(screen.getByTestId('keep-bubble').getAttribute('aria-label')).toBe('Ada Lovelace, 1 kept email');
  });

  it('the phone group bubble shows its count in the centre', () => {
    render(<KeepDock onOpen={vi.fn()} />);
    const bubbles = screen.getAllByTestId('keep-bubble');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].children).toHaveLength(1);
    expect(within(bubbles[0]).getByTestId('keep-count').textContent).toBe('3');
  });

  it('Back skips a bubble that is gone and closes the next layer', async () => {
    const { pushLayer } = await import('../backStack.js');
    const below = vi.fn();
    const release = pushLayer(below);
    useKeepStore.setState({ items: [kept('a1', 1, 10)] });
    render(<KeepDock onOpen={vi.fn()} />);
    fireEvent.pointerDown(adaBubble(), { pointerType: 'touch' });
    fireEvent.click(adaBubble());
    fireEvent.click(screen.getByTestId('keep-row-remove'));
    expect(screen.queryByTestId('keep-dock')).toBeNull();
    await popstate();
    expect(below).toHaveBeenCalledTimes(1);
    release();
  });
});
