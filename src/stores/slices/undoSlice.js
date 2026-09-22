// ── undoSlice — one undoable action, replaced by the next ──
//
// Not a history: Thunderbird keeps a stack, MailVault keeps the last thing the
// user did to mail, until the next thing. The toast is the affordance for 8 s;
// Cmd+Z reaches the slot for as long as it holds.
import { t as tr } from '../../i18n/index.js';

let _seq = 0;

export const createUndoSlice = (set, get) => ({
  /** @type {null | { id: number, labelKey: string, labelParams?: object, canUndo: boolean, run?: () => Promise<void>, at: number }} */
  undo: null,

  setUndo: (entry) => set({
    undo: entry ? { canUndo: true, ...entry, id: ++_seq, at: Date.now() } : null,
  }),

  clearUndo: () => set({ undo: null }),

  runUndo: async () => {
    const u = get().undo;
    if (!u?.canUndo || typeof u.run !== 'function') return false;
    set({ undo: null });   // one shot — a second Cmd+Z must not redo the redo
    try {
      await u.run();
      // The delete evicted the row from the open result list (pruneSearchResults)
      // and parked its key in `excludedSearchCopies`, which no reload clears —
      // so an undone delete came back to the folder and stayed missing from the
      // search. Re-running the query is what puts it back: it drops the
      // exclusions and re-matches the message, which the restore gave a NEW uid
      // anyway, so re-inserting the old row would have been a dead one.
      //
      // Its own try: a query that fails to re-run is not a failed undo, and
      // saying "Undo failed" over a message that is back would be a lie.
      try {
        const { useSearchStore } = await import('../../stores/searchStore');
        const search = useSearchStore.getState();
        if (search.searchActive) await search.performSearch();
      } catch (e) {
        console.warn('[undo] Could not re-run the search:', e);
      }
      return true;
    } catch (e) {
      set({ error: tr('undo.failed', { err: e?.message || String(e) }) });
      return false;
    }
  },
});
