import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { create } from 'zustand';

vi.mock('../../settingsStore', () => ({
  useSettingsStore: { getState: () => ({ sendDelay: 0, undoSendEnabled: false, undoSendDelay: 0 }) },
}));

const { createComposeSlice } = await import('../composeSlice');

// Two sends inside one undo window: each goes exactly once, on its own timer,
// and Undo takes back only the one it names.
describe('composeSlice pending sends', () => {
  let store;
  const state = (subject) => ({ mode: 'new', initialData: { subject } });

  beforeEach(() => {
    vi.useFakeTimers();
    store = create((set, get) => createComposeSlice(set, get));
  });
  afterEach(() => vi.useRealTimers());

  it('a second delayed send never replaces the first', async () => {
    const sendA = vi.fn().mockResolvedValue(undefined);
    const sendB = vi.fn().mockResolvedValue(undefined);
    store.getState().queueSend(state('A'), sendA, 30);
    vi.advanceTimersByTime(10_000);
    store.getState().queueSend(state('B'), sendB, 30);
    expect(store.getState().pendingSends.map(p => p.composeState.initialData.subject)).toEqual(['A', 'B']);
    expect(store.getState().pendingSend.composeState.initialData.subject).toBe('B');

    vi.advanceTimersByTime(20_000); // A's 30s are up, B has 10s left
    expect(sendA).toHaveBeenCalledTimes(1);
    expect(sendB).not.toHaveBeenCalled();
    expect(store.getState().pendingSend.composeState.initialData.subject).toBe('B');

    vi.advanceTimersByTime(10_000);
    await vi.runAllTimersAsync();
    expect(sendA).toHaveBeenCalledTimes(1);
    expect(sendB).toHaveBeenCalledTimes(1);
    expect(store.getState().pendingSends).toEqual([]);
    expect(store.getState().pendingSend).toBeNull();
  });

  it('undoing B hands B back and leaves A to send', async () => {
    const sendA = vi.fn().mockResolvedValue(undefined);
    const sendB = vi.fn().mockResolvedValue(undefined);
    store.getState().queueSend(state('A'), sendA, 30);
    store.getState().queueSend(state('B'), sendB, 30);

    const restored = store.getState().cancelPendingSend(store.getState().pendingSend.id);
    expect(restored.initialData.subject).toBe('B');
    // The toast falls back to A, still counting down.
    expect(store.getState().pendingSend.composeState.initialData.subject).toBe('A');

    await vi.runAllTimersAsync();
    expect(sendA).toHaveBeenCalledTimes(1);
    expect(sendB).not.toHaveBeenCalled();
    expect(store.getState().pendingSend).toBeNull();
  });

  it('one pending send behaves as before: Undo with no id takes it back', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    store.getState().queueSend(state('Only'), send, 15);
    expect(store.getState().cancelPendingSend().initialData.subject).toBe('Only');
    expect(store.getState().cancelPendingSend()).toBeNull();
    await vi.runAllTimersAsync();
    expect(send).not.toHaveBeenCalled();
  });

  it('a zero delay skips the undo window', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    store.getState().queueSend(state('Now'), send, 0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.getState().pendingSend).toBeNull();
  });
});
