// One slot, not a stack. The rule the slice owes its callers: `runUndo` empties
// the slot BEFORE it awaits the work, so a second Cmd+Z (or a second click on a
// toast that has not repainted yet) cannot undo the undo.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { create } from 'zustand';
import { createUndoSlice } from '../undoSlice';

const store = create((set, get) => ({ error: null, ...createUndoSlice(set, get) }));

beforeEach(() => {
  store.setState({ error: null, undo: null });
});

describe('undoSlice', () => {
  it('stamps id, at and a default canUndo on setUndo', () => {
    const run = vi.fn();
    store.getState().setUndo({ labelKey: 'undo.moved', labelParams: { count: 2 }, run });

    const { undo } = store.getState();
    expect(undo).toMatchObject({ labelKey: 'undo.moved', labelParams: { count: 2 }, canUndo: true, run });
    expect(typeof undo.id).toBe('number');
    expect(typeof undo.at).toBe('number');
  });

  it('keeps an explicit canUndo:false', () => {
    store.getState().setUndo({ labelKey: 'undo.deletedPermanently', canUndo: false });
    expect(store.getState().undo.canUndo).toBe(false);
  });

  it('replaces the slot — the second action wins and gets a new id', () => {
    store.getState().setUndo({ labelKey: 'undo.starred', run: vi.fn() });
    const first = store.getState().undo;
    store.getState().setUndo({ labelKey: 'undo.deleted', run: vi.fn() });
    const second = store.getState().undo;

    expect(second.labelKey).toBe('undo.deleted');
    expect(second.id).not.toBe(first.id);
  });

  it('setUndo(null) empties the slot', () => {
    store.getState().setUndo({ labelKey: 'undo.starred', run: vi.fn() });
    store.getState().setUndo(null);
    expect(store.getState().undo).toBeNull();
  });

  it('clears the slot BEFORE awaiting run, and resolves true', async () => {
    let slotDuringRun = 'unset';
    store.getState().setUndo({
      labelKey: 'undo.moved',
      run: async () => { slotDuringRun = store.getState().undo; },
    });

    await expect(store.getState().runUndo()).resolves.toBe(true);
    // One shot: the work sees an empty slot, so a second Cmd+Z fires nothing.
    expect(slotDuringRun).toBeNull();
    expect(store.getState().undo).toBeNull();
  });

  it('reports a failing run through the store error and resolves false', async () => {
    store.getState().setUndo({
      labelKey: 'undo.moved',
      run: async () => { throw new Error('COPYUID gone'); },
    });

    await expect(store.getState().runUndo()).resolves.toBe(false);
    expect(store.getState().error).toContain('COPYUID gone');
    expect(store.getState().undo).toBeNull();
  });

  it('does nothing for a slot that cannot be undone', async () => {
    const run = vi.fn();
    store.getState().setUndo({ labelKey: 'undo.deletedPermanently', canUndo: false, run });

    await expect(store.getState().runUndo()).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
    // The label stays on screen — only a run that happened empties the slot.
    expect(store.getState().undo).not.toBeNull();
  });

  it('does nothing on an empty slot', async () => {
    await expect(store.getState().runUndo()).resolves.toBe(false);
  });

  it('clearUndo empties the slot', () => {
    store.getState().setUndo({ labelKey: 'undo.starred', run: vi.fn() });
    store.getState().clearUndo();
    expect(store.getState().undo).toBeNull();
  });
});
