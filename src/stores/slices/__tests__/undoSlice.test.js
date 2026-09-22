// One slot, not a stack. The rule the slice owes its callers: `runUndo` empties
// the slot BEFORE it awaits the work, so a second Cmd+Z (or a second click on a
// toast that has not repainted yet) cannot undo the undo.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { create } from 'zustand';

// The slice reaches for the search store after a successful undo. Mocked so the
// real one (and its api/daemon graph) never loads here.
const search = { searchActive: false, performSearch: vi.fn() };
vi.mock('../../searchStore', () => ({ useSearchStore: { getState: () => search } }));

import { createUndoSlice } from '../undoSlice';

const store = create((set, get) => ({ error: null, ...createUndoSlice(set, get) }));

beforeEach(() => {
  store.setState({ error: null, undo: null });
  search.searchActive = false;
  search.performSearch.mockReset().mockResolvedValue(undefined);
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

  // A delete evicts the row from an open result list and parks its key in
  // `excludedSearchCopies`, which no list reload clears. Undo has to re-run the
  // query or the restored message stays missing from the search.
  it('re-runs an active search after a successful undo', async () => {
    search.searchActive = true;
    store.getState().setUndo({ labelKey: 'undo.deleted', run: vi.fn().mockResolvedValue(undefined) });

    await store.getState().runUndo();

    expect(search.performSearch).toHaveBeenCalledTimes(1);
  });

  it('leaves the search alone when none is open', async () => {
    store.getState().setUndo({ labelKey: 'undo.deleted', run: vi.fn().mockResolvedValue(undefined) });

    await store.getState().runUndo();

    expect(search.performSearch).not.toHaveBeenCalled();
  });

  it('still reports the undo as done when the re-run throws', async () => {
    search.searchActive = true;
    search.performSearch.mockRejectedValue(new Error('offline'));
    store.getState().setUndo({ labelKey: 'undo.deleted', run: vi.fn().mockResolvedValue(undefined) });

    await expect(store.getState().runUndo()).resolves.toBe(true);
    expect(store.getState().error).toBeNull();
  });
});
