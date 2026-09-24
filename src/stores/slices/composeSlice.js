// ── composeSlice — undo-send + outbox (sending/error) tracking ──
//
// Two stages:
//  1. `pendingSends` — every send still inside its undo (delay) window, oldest
//     first, each with its own timer. `pendingSend` is the newest of them:
//     the one UndoSendToast shows and its Undo cancels.
//  2. `outboxItems` — list of sends that passed the undo window and are either
//     in-flight, succeeded (ephemeral), or errored (sticky until retry/dismiss).
//     Rendered as bubbles so the compose flow reuses the same UI surface the
//     minimized compose window uses.
//
// On send error the outbox entry is retained with status='error' and the
// message so the user can open the bubble, retry, or dismiss (which restores
// the compose window with the original draft).

import { useSettingsStore } from '../settingsStore';

let _outboxSeq = 0;
let _pendingSeq = 0;

export const createComposeSlice = (set, get) => ({
  // ── Undo-send stage ──
  pendingSends: [],   // [{ id, composeState, timeoutId, timestamp, delay, sendFn }]
  pendingSend: null,  // pendingSends.at(-1), or null

  // ── Outbox stage ──
  // [{ id, composeState, sendFn, status: 'sending'|'sent'|'error', error, startedAt }]
  outboxItems: [],

  queueSend: (composeState, sendFn, overrideDelay = null) => {
    const { sendDelay, undoSendEnabled, undoSendDelay } = useSettingsStore.getState();
    const delay = overrideDelay ?? sendDelay ?? (undoSendEnabled ? undoSendDelay : 0);
    if (delay === 0) {
      get()._startOutbox(composeState, sendFn);
      return;
    }
    // Each timer sends the entry it was made for. A second send queued inside
    // the first one's window used to replace a single slot, and the first
    // timer then sent the second email while the first never went.
    _pendingSeq += 1;
    const id = _pendingSeq;
    const timeoutId = setTimeout(() => {
      if (!get().pendingSends.some(p => p.id === id)) return;
      get()._dropPending(id);
      get()._startOutbox(composeState, sendFn);
    }, delay * 1000);
    const pendingSend = { id, composeState, timeoutId, timestamp: Date.now(), delay, sendFn };
    set(s => ({ pendingSends: [...s.pendingSends, pendingSend], pendingSend }));
  },

  _dropPending: (id) => set(s => {
    const pendingSends = s.pendingSends.filter(p => p.id !== id);
    return { pendingSends, pendingSend: pendingSends.at(-1) ?? null };
  }),

  // Cancels one pending send (the newest by default) and returns its compose
  // state for Undo to reopen; the others keep counting down.
  cancelPendingSend: (id = get().pendingSend?.id) => {
    const pending = get().pendingSends.find(p => p.id === id);
    if (!pending) return null;
    clearTimeout(pending.timeoutId);
    get()._dropPending(id);
    return pending.composeState;
  },

  // IDs of outbox items the user has cancelled; used to suppress sendFn resolution
  // (Tauri invoke is not abortable — the SMTP send may still complete server-side
  // if it was already in flight, but the UI bubble is removed immediately).
  _cancelledOutboxIds: new Set(),

  _startOutbox: (composeState, sendFn) => {
    _outboxSeq += 1;
    const id = _outboxSeq;
    const item = {
      id,
      composeState,
      sendFn,
      status: 'sending',
      error: null,
      startedAt: Date.now(),
    };
    set(s => ({ outboxItems: [...s.outboxItems, item] }));
    get()._runOutbox(id);
  },

  _runOutbox: async (id) => {
    const item = get().outboxItems.find(i => i.id === id);
    if (!item) return;
    try {
      await item.sendFn();
      if (get()._cancelledOutboxIds.has(id)) {
        get()._cancelledOutboxIds.delete(id);
        return;
      }
      // Flash 'sent' briefly, then remove.
      set(s => ({
        outboxItems: s.outboxItems.map(i => i.id === id ? { ...i, status: 'sent' } : i),
      }));
      setTimeout(() => {
        set(s => ({ outboxItems: s.outboxItems.filter(i => i.id !== id) }));
      }, 1800);
    } catch (err) {
      if (get()._cancelledOutboxIds.has(id)) {
        get()._cancelledOutboxIds.delete(id);
        return;
      }
      const msg = (err && (err.message || err.toString())) || 'Failed to send';
      set(s => ({
        outboxItems: s.outboxItems.map(i => i.id === id ? { ...i, status: 'error', error: msg } : i),
      }));
    }
  },

  retryOutbox: (id) => {
    const item = get().outboxItems.find(i => i.id === id);
    if (!item) return;
    set(s => ({
      outboxItems: s.outboxItems.map(i => i.id === id ? { ...i, status: 'sending', error: null, startedAt: Date.now() } : i),
    }));
    get()._runOutbox(id);
  },

  cancelOutbox: (id) => {
    const item = get().outboxItems.find(i => i.id === id);
    if (!item) return;
    if (item.status === 'sending') get()._cancelledOutboxIds.add(id);
    set(s => ({ outboxItems: s.outboxItems.filter(i => i.id !== id) }));
  },

  dismissOutbox: (id) => {
    set(s => ({ outboxItems: s.outboxItems.filter(i => i.id !== id) }));
  },
});
