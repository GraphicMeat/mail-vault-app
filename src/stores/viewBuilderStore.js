import { create } from 'zustand';

/// Whether the reader's view builder is open. A mode the person turned on, so
/// it lives outside the reader: it survives the reader unmounting (the stacked
/// layout drops it while the next email loads), a change of email, and the
/// move between the single reader and a thread. Closed only by the builder's
/// own close button or its toggle. Not persisted: a restart starts closed.
///
/// Imports no other store.
export const useViewBuilderStore = create(set => ({
  open: false,
  setOpen: open => set({ open: !!open }),
  toggle: () => set(state => ({ open: !state.open })),
}));
