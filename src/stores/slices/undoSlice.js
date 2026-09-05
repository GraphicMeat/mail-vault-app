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
      return true;
    } catch (e) {
      set({ error: tr('undo.failed', { err: e?.message || String(e) }) });
      return false;
    }
  },
});
