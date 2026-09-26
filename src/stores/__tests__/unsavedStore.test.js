import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUnsavedStore } from '../unsavedStore';

const guard = over => ({ changes: ['Name'], save: vi.fn(async () => true), discard: vi.fn(async () => {}), ...over });

beforeEach(() => useUnsavedStore.setState({ guard: null, pending: null, busy: false }));

describe('unsavedStore', () => {
  it('leaves at once with nothing unsaved', () => {
    const action = vi.fn();
    useUnsavedStore.getState().setGuard(guard({ changes: [] }));
    useUnsavedStore.getState().leave(action);
    expect(action).toHaveBeenCalledOnce();
    expect(useUnsavedStore.getState().pending).toBeNull();
  });

  it('holds the way out while there are changes, and keep editing drops it', async () => {
    const action = vi.fn();
    useUnsavedStore.getState().setGuard(guard());
    useUnsavedStore.getState().leave(action);
    expect(action).not.toHaveBeenCalled();
    await useUnsavedStore.getState().answer('keep');
    expect(action).not.toHaveBeenCalled();
    expect(useUnsavedStore.getState().pending).toBeNull();
    expect(useUnsavedStore.getState().guard).not.toBeNull();
  });

  it('save then leave; a failed save stays', async () => {
    const action = vi.fn();
    const failing = guard({ save: vi.fn(async () => false) });
    useUnsavedStore.getState().setGuard(failing);
    useUnsavedStore.getState().leave(action);
    await useUnsavedStore.getState().answer('save');
    expect(action).not.toHaveBeenCalled();
    expect(useUnsavedStore.getState().guard).toBe(failing);

    const ok = guard();
    useUnsavedStore.getState().setGuard(ok);
    useUnsavedStore.getState().leave(action);
    await useUnsavedStore.getState().answer('save');
    expect(ok.save).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledOnce();
    expect(useUnsavedStore.getState().guard).toBeNull();
  });

  it('discard then leave', async () => {
    const action = vi.fn();
    const g = guard();
    useUnsavedStore.getState().setGuard(g);
    useUnsavedStore.getState().leave(action);
    await useUnsavedStore.getState().answer('discard');
    expect(g.discard).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledOnce();
  });
});
