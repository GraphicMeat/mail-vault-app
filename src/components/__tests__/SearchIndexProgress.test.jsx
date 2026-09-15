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
    expect(modal().textContent).toContain('500');
    expect(modal().textContent).toContain('16%');
  });

  it('a pass that ends within the delay never opens', async () => {
    await mount();
    act(() => progress(building({ indexed: 10, total: 12 })));
    await act(async () => { vi.advanceTimersByTime(500); });
    act(() => progress(building({ state: 'idle', indexed: 12, total: 12, complete: true, firstPassDone: true })));
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(modal()).toBeNull();
    expect(chip()).toBeNull();
    // M1(a): the cleared timer must really be cleared, not just shadowed by
    // the render guard — a fresh big pass right after must wait its own delay.
    act(() => progress(building()));
    expect(modal()).toBeNull();
  });

  it('a folder boundary (complete without firstPassDone) does not reopen a hidden modal', async () => {
    await mount();
    act(() => progress(building({ indexed: 500, total: 1000 })));
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(modal()).toBeNull();
    // A folder finishing mid-build reports indexed === total for a moment;
    // firstPassDone stays false because the pass as a whole is not done.
    act(() => progress(building({ indexed: 1000, total: 1000, complete: true, firstPassDone: false })));
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(modal()).toBeNull();
    act(() => progress(building({ indexed: 1500, total: 4000, firstPassDone: false })));
    await act(async () => { vi.advanceTimersByTime(1600); });
    expect(modal()).not.toBeNull();
    fireEvent.click(screen.getByTestId('search-index-progress-hide'));
    expect(modal()).toBeNull();
    expect(chip()).not.toBeNull();
    // Another folder boundary while hidden: buildFinished requires
    // firstPassDone, so this must not pop the modal back over the user.
    act(() => progress(building({ indexed: 2000, total: 2000, complete: true, firstPassDone: false })));
    expect(chip()).not.toBeNull();
    expect(modal()).toBeNull();
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
    // M1(b): `hidden` really reset — a fresh big backlog now opens the modal
    // (not just the chip, which is where a stuck `hidden: true` would show).
    act(() => progress(building({ firstPassDone: true, indexed: 3000, total: 4000 })));
    await act(async () => { vi.advanceTimersByTime(1600); });
    expect(modal()).not.toBeNull();
    expect(chip()).toBeNull();
  });

  it('refetches status when the daemon reconnects', async () => {
    await mount();
    expect(statusFn).toHaveBeenCalledTimes(1);
    statusReply = building();
    await act(async () => { reconnect(); await Promise.resolve(); });
    expect(statusFn).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(1600); });
    expect(modal()).not.toBeNull();
    cleanup();
    expect(progress).toBeNull();
    expect(reconnect).toBeNull();
  });

  it('a progress event that arrives while a reconnect refresh is in flight wins', async () => {
    await mount();
    let resolveRefresh;
    statusFn.mockImplementationOnce(() => new Promise((r) => { resolveRefresh = r; }));
    act(() => reconnect()); // consumes the pending-promise mock via refresh()'s status() call
    act(() => progress(building({ indexed: 900 }))); // a newer event lands before that reply arrives
    await act(async () => { resolveRefresh({ available: false, state: 'unavailable' }); await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(1600); });
    // The stale "unavailable" reply must not clobber the newer progress event.
    expect(modal()).not.toBeNull();
  });

  it('never steals focus from a native input the user is typing into: opens minimized', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    try {
      await mount();
      act(() => progress(building()));
      await act(async () => { vi.advanceTimersByTime(1600); });
      expect(modal()).toBeNull();
      expect(chip()).not.toBeNull();
    } finally {
      input.remove();
    }
  });

  it('never steals focus from a rich-text (contenteditable) editor: opens minimized', async () => {
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    document.body.appendChild(editor);
    editor.focus();
    try {
      await mount();
      act(() => progress(building()));
      await act(async () => { vi.advanceTimersByTime(1600); });
      expect(modal()).toBeNull();
      expect(chip()).not.toBeNull();
    } finally {
      editor.remove();
    }
  });
});
