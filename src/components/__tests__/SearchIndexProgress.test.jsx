// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

let statusReply;
let progress = null;
let reconnect = null;
const statusFn = vi.fn();
vi.mock('../../services/searchIndex', () => ({
  status: () => statusFn(),
  onProgress: async (cb) => { progress = cb; return () => { progress = null; }; },
  onDaemonReconnected: async (cb) => { reconnect = cb; return () => { reconnect = null; }; },
}));

import { SearchIndexProgress } from '../SearchIndexProgress';

const building = (o = {}) => ({ available: true, state: 'indexing', indexed: 500, total: 3000, sizeBytes: 4096, complete: false, firstPassDone: false, ...o });
const modal = () => screen.queryByTestId('search-index-progress-modal');
const chip = () => screen.queryByTestId('search-index-chip');

async function mount() {
  render(<SearchIndexProgress />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  statusReply = { available: true, state: 'idle', indexed: 0, total: 0, complete: false, firstPassDone: true };
  statusFn.mockReset().mockImplementation(() => Promise.resolve(statusReply));
});
afterEach(() => { cleanup(); vi.useRealTimers(); progress = null; reconnect = null; });

describe('SearchIndexProgress', () => {
  it('shows a corner chip after the open delay and never a blocking modal', async () => {
    await mount();
    act(() => progress(building()));
    expect(chip()).toBeNull();
    await act(async () => { vi.advanceTimersByTime(1600); });
    expect(modal()).toBeNull();
    expect(chip()).not.toBeNull();
    expect(chip().textContent).toContain('16%');
  });

  it('a pass that ends within the delay shows nothing', async () => {
    await mount();
    act(() => progress(building({ indexed: 10, total: 12 })));
    await act(async () => { vi.advanceTimersByTime(500); });
    act(() => progress(building({ state: 'idle', indexed: 12, total: 12, complete: true, firstPassDone: true })));
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(modal()).toBeNull();
    expect(chip()).toBeNull();
    // The cleared timer must really be cleared: a fresh big pass waits its own delay.
    act(() => progress(building()));
    expect(chip()).toBeNull();
  });

  it('never takes focus, whatever the user is typing into', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    try {
      await mount();
      act(() => progress(building()));
      await act(async () => { vi.advanceTimersByTime(1600); });
      expect(modal()).toBeNull();
      expect(chip()).not.toBeNull();
      expect(document.activeElement).toBe(input);
    } finally {
      input.remove();
    }
  });

  it('only a click on the chip opens the details modal; Hide and Escape go back to the chip', async () => {
    await mount();
    act(() => progress(building()));
    await act(async () => { vi.advanceTimersByTime(1600); });
    fireEvent.click(chip());
    expect(modal()).not.toBeNull();
    expect(modal().textContent).toContain('500');
    fireEvent.click(screen.getByTestId('search-index-progress-hide'));
    expect(modal()).toBeNull();
    expect(chip()).not.toBeNull();
    fireEvent.click(chip());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(modal()).toBeNull();
    expect(chip()).not.toBeNull();
  });

  it('a folder boundary (complete without firstPassDone) keeps the chip and pops nothing', async () => {
    await mount();
    act(() => progress(building({ indexed: 500, total: 1000 })));
    await act(async () => { vi.advanceTimersByTime(1600); });
    act(() => progress(building({ indexed: 1000, total: 1000, complete: true, firstPassDone: false })));
    expect(chip()).not.toBeNull();
    expect(modal()).toBeNull();
  });

  it('the chip survives an interrupted pass, goes when the build finishes, and a new big pass shows a chip again', async () => {
    await mount();
    act(() => progress(building()));
    await act(async () => { vi.advanceTimersByTime(1600); });
    fireEvent.click(chip());
    expect(modal()).not.toBeNull();
    act(() => progress(building({ state: 'idle', indexed: 1000 })));
    expect(chip()).toBeNull();
    act(() => progress(building({ state: 'idle', indexed: 3000, complete: true, firstPassDone: true })));
    expect(modal()).toBeNull();
    act(() => progress(building({ firstPassDone: true, indexed: 3000, total: 4000 })));
    await act(async () => { vi.advanceTimersByTime(1600); });
    expect(modal()).toBeNull();
    expect(chip()).not.toBeNull();
  });

  it('refetches status when the daemon reconnects', async () => {
    await mount();
    expect(statusFn).toHaveBeenCalledTimes(1);
    statusReply = building();
    await act(async () => { reconnect(); await Promise.resolve(); });
    expect(statusFn).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(1600); });
    expect(chip()).not.toBeNull();
    cleanup();
    expect(progress).toBeNull();
    expect(reconnect).toBeNull();
  });

  it('a progress event that arrives while a reconnect refresh is in flight wins', async () => {
    await mount();
    let resolveRefresh;
    statusFn.mockImplementationOnce(() => new Promise((r) => { resolveRefresh = r; }));
    act(() => reconnect());
    act(() => progress(building({ indexed: 900 })));
    await act(async () => { resolveRefresh({ available: false, state: 'unavailable' }); await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(1600); });
    expect(chip()).not.toBeNull();
  });
});
