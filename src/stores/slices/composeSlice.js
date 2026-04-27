// ── composeSlice — undo-send + outbox (sending/error) tracking ──
//
// Two stages:
//  1. `pendingSend` — single slot while the user can still Undo (delay window).
//     Consumed by UndoSendToast.
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

export const createComposeSlice = (set, get) => ({
  // ── Undo-send stage ──
  pendingSend: null,  // { composeState, timeoutId, timestamp, delay, sendFn }

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
    const timeoutId = setTimeout(() => {
      const pending = get().pendingSend;
      set({ pendingSend: null });
      if (pending) get()._startOutbox(pending.composeState, pending.sendFn);
    }, delay * 1000);
    set({ pendingSend: { composeState, timeoutId, timestamp: Date.now(), delay, sendFn } });
  },

  cancelPendingSend: () => {
    const { pendingSend } = get();
    if (pendingSend) {
      clearTimeout(pendingSend.timeoutId);
      const saved = pendingSend.composeState;
      set({ pendingSend: null });
      return saved;
    }
    return null;
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
