import { create } from 'zustand';
import { daemonCall } from '../services/daemonClient';
import { normalizeMessageId } from '../utils/emailParser.js';

// Rows from `snooze.*` (src-daemon/src/handlers/snooze.rs), modeled on
// scheduledStore.js: one flat list of snoozed/failed rows, refetched on
// launch, patched from the `snooze` daemon event.
export const useSnoozeStore = create((set, get) => ({
  rows: [],

  loadRows: async () => {
    const rows = await daemonCall('snooze.list', {});
    set({ rows: Array.isArray(rows) ? rows : [] });
    return get().rows;
  },

  upsert: (rows) => set(state => {
    const ids = new Set(rows.map(r => r.id));
    return { rows: [...state.rows.filter(r => !ids.has(r.id)), ...rows] };
  }),

  /// `{id, state}` off the `snooze` event. A woken row is history: drop it.
  applyEvent: (payload) => {
    if (!payload?.id) return;
    set(state => ({
      rows: payload.state === 'woken'
        ? state.rows.filter(r => r.id !== payload.id)
        : state.rows.map(r => (r.id === payload.id ? { ...r, state: payload.state } : r)),
    }));
  },
}));

/// When the message `messageId` on `accountId` wakes, or null. What a row in
/// the Snoozed folder shows instead of its date.
export function wakeAtFor(rows, accountId, messageId) {
  if (!accountId || !messageId) return null;
  const id = normalizeMessageId(messageId);
  return rows.find(r => r.accountId === accountId && normalizeMessageId(r.messageId) === id)?.wakeAt ?? null;
}

async function listenTo(event, cb) {
  try {
    const { listen } = await import('@tauri-apps/api/event');
    return await listen(event, (e) => cb(e.payload));
  } catch {
    return () => {};
  }
}

let _initialized = false;

/// Called once at app launch (App.jsx, beside initScheduledSend). A wake also
/// syncs the destination and reports it as new mail through the sync engine;
/// this only keeps the rows current and repaints a list that shows Snoozed.
export function initSnooze() {
  if (_initialized) return;
  _initialized = true;
  useSnoozeStore.getState().loadRows().catch(() => {});
  listenTo('snooze', async (payload) => {
    useSnoozeStore.getState().applyEvent(payload);
    if (payload?.state !== 'woken') return;
    const { reloadListInView } = await import('../services/workflows/messageMutations');
    reloadListInView().catch(() => {});
  });
}
