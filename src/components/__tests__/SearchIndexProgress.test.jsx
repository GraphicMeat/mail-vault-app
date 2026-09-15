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
  it('opens only after the rule holds for the open delay', async () => {
    await mount();
    act(() => progress(building()));
    expect(modal()).toBeNull();
    await act(async () => { vi.advanceTimersByTime(1600); });
    expect(modal()).not.toBeNull();
    expect(modal().textContent).toContain('500 of 3,000');
  });

  it('a pass that ends within the delay never opens', async () => {
    await mount();
    act(() => progress(building({ indexed: 10, total: 12 })));
    await act(async () => { vi.advanceTimersByTime(500); });
    act(() => progress(building({ state: 'idle', indexed: 12, total: 12, complete: true, firstPassDone: true })));
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(modal()).toBeNull();
    expect(chip()).toBeNull();
  });

  it('Hide minimizes to a chip with the percent, and the chip reopens it', async () => {
    await mount();
    act(() => progress(building()));
    await act(async () => { vi.advanceTimersByTime(1600); });
    fireEvent.click(screen.getByTestId('search-index-progress-hide'));
    expect(modal()).toBeNull();
    expect(chip().textContent).toContain('16%');
    fireEvent.click(chip());
    expect(modal()).not.toBeNull();
  });

  it('Escape minimizes too', async () => {
    await mount();
    act(() => progress(building()));
    await act(async () => { vi.advanceTimersByTime(1600); });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(modal()).toBeNull();
    expect(chip()).not.toBeNull();
  });

  it('stays minimized across an interrupted pass and closes when the build finishes', async () => {
    await mount();
    act(() => progress(building()));
    await act(async () => { vi.advanceTimersByTime(1600); });
    fireEvent.click(screen.getByTestId('search-index-progress-hide'));
    act(() => progress(building({ state: 'idle', indexed: 1000 })));
    expect(chip()).toBeNull();
    act(() => progress(building({ indexed: 1000 })));
    await act(async () => { vi.advanceTimersByTime(1600); });
    expect(modal()).toBeNull();
    expect(chip()).not.toBeNull();
    act(() => progress(building({ state: 'idle', indexed: 3000, complete: true, firstPassDone: true })));
    expect(chip()).toBeNull();
    expect(modal()).toBeNull();
  });

  it('refetches status when the daemon reconnects', async () => {
    await mount();
    expect(statusFn).toHaveBeenCalledTimes(1);
    statusReply = building();
    await act(async () => { reconnect(); await Promise.resolve(); });
    expect(statusFn).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(1600); });
    expect(modal()).not.toBeNull();
  });
});
