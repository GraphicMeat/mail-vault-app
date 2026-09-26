import { create } from 'zustand';

/// An editor holding unsaved work registers what leaving would lose; every way
/// out of the page asks through `leave` first. One guard at a time: Settings
/// shows one editor.
///
/// guard: `{ changes: string[], save: () => Promise<boolean>, discard: () => Promise<void> }`
export const useUnsavedStore = create((set, get) => ({
  guard: null,
  /// The way out waiting on an answer.
  pending: null,
  busy: false,

  /// A way out held for changes that are gone by now (a save that was already
  /// on its way landed, the editor closed) has nothing left to ask: it goes.
  setGuard: guard => {
    const { pending, busy } = get();
    if (pending && !busy && !guard?.changes.length) {
      set({ guard, pending: null });
      pending();
      return;
    }
    set({ guard });
  },

  /// Runs `action` now, or once the unsaved changes are saved or discarded.
  leave: action => {
    if (!get().guard?.changes.length) { action(); return; }
    set({ pending: action });
  },

  /// 'save' | 'discard' | 'keep'. A save that fails keeps the editor open.
  answer: async choice => {
    const { guard, pending } = get();
    if (choice === 'keep' || !guard || !pending) { set({ pending: null }); return; }
    set({ busy: true });
    try {
      const done = choice === 'save' ? await guard.save() : (await guard.discard(), true);
      set({ pending: null, ...(done ? { guard: null } : {}) });
      if (done) pending();
    } finally {
      set({ busy: false });
    }
  },
}));
