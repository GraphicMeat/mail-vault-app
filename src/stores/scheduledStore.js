import { create } from 'zustand';
import { daemonCall } from '../services/daemonClient';
import { zonedTimeToEpoch, resolveSuggestedTz } from '../utils/scheduledTime';

// Rows from `scheduled.*` (src-daemon/src/handlers/scheduled.rs). Modeled on
// tagStore.js: one flat list, refetched on mount, patched in place from the
// `scheduled-send` daemon event and from this store's own RPC replies.
export const useScheduledStore = create((set, get) => ({
  rows: [],

  loadRows: async () => {
    const rows = await daemonCall('scheduled.list', {});
    set({ rows: Array.isArray(rows) ? rows : [] });
    return get().rows;
  },

  /// `{id, status}` off the `scheduled-send` event. The event carries no
  /// other field, so this only ever patches status — a row whose attempts/
  /// lastError changed too is caught up by the next `loadRows()`, not by this.
  applyEvent: (payload) => {
    if (!payload?.id) return;
    set(state => ({
      rows: state.rows.map(r => (r.id === payload.id ? { ...r, status: payload.status } : r)),
    }));
  },

  create: async ({ accountId, account, email, localTime, tz, fireAt, sentMailbox }) => {
    const row = await daemonCall('scheduled.create', { accountId, account, email, localTime, tz, fireAt, sentMailbox });
    set(state => ({ rows: [...state.rows.filter(r => r.id !== row.id), row] }));
    return row;
  },

  /// Date/tz only — never touches the frozen .eml. Editing the content goes
  /// through `replace` below.
  reschedule: async (id, { localTime, tz, fireAt }) => {
    const row = await daemonCall('scheduled.update', { id, localTime, tz, fireAt });
    set(state => ({ rows: state.rows.map(r => (r.id === id ? row : r)) }));
    return row;
  },

  /// Save an edited scheduled email over its row: same id, new frozen .eml,
  /// envelope and time (composeSend.js's scheduleCompose). The daemon refuses
  /// with `E_SCHEDULED_NOT_EDITABLE` once the row is being sent, was sent or
  /// was cancelled, and then nothing here changes.
  replace: async (id, { account, email, sentMailbox, localTime, tz, fireAt }) => {
    const row = await daemonCall('scheduled.update', { id, account, email, sentMailbox, localTime, tz, fireAt });
    set(state => ({ rows: state.rows.map(r => (r.id === id ? row : r)) }));
    return row;
  },

  /// The RPC answers `null` whether it cancelled the row or found nothing —
  /// so this trusts its own optimistic write, not the reply.
  cancel: async (id) => {
    await daemonCall('scheduled.cancel', { id });
    set(state => ({ rows: state.rows.map(r => (r.id === id ? { ...r, status: 'cancelled' } : r)) }));
  },

  /// Also what "Retry" on a failed row calls — `scheduled.send_now` accepts
  /// both `queued` and `failed`, and a retry is not a different operation.
  sendNow: async (id) => {
    const row = await daemonCall('scheduled.send_now', { id });
    set(state => ({ rows: state.rows.map(r => (r.id === id ? row : r)) }));
    return row;
  },

  /// The zone to preselect for `address` (resolveSuggestedTz's shape), or
  /// null. A suggestion is a nicety: any failure is just no suggestion, never
  /// an error in the user's way.
  suggestTz: async (address) => {
    try {
      const facts = await daemonCall('scheduled.suggest_tz', { address });
      return resolveSuggestedTz(facts || {}, { localTz: Intl.DateTimeFormat().resolvedOptions().timeZone });
    } catch {
      return null;
    }
  },

  /// Push a corrected `fireAt` for every `queued` row whose stored cache no
  /// longer matches what its own localTime+tz means (a DST rule moved between
  /// scheduling and now). One row failing to push must not stop the rest, and
  /// the whole pass must not be routine background noise the worker wakes for
  /// on an unrelated schedule change, hence the `=== ` skip below.
  recomputeFireAt: async () => {
    const queued = get().rows.filter(r => r.status === 'queued');
    for (const row of queued) {
      const correct = zonedTimeToEpoch(row.localTime, row.tz);
      if (correct === row.fireAt) continue;
      try {
        await get().reschedule(row.id, { localTime: row.localTime, tz: row.tz, fireAt: correct });
      } catch {
        // Retried on the next launch/focus recompute — see initScheduledSend.
      }
    }
  },
}));

async function listenTo(event, cb) {
  try {
    const { listen } = await import('@tauri-apps/api/event');
    return await listen(event, (e) => cb(e.payload));
  } catch {
    return () => {};
  }
}

let _initialized = false;

/// Called once at app launch (see App.jsx): loads the queue, recomputes every
/// queued row's fireAt, and subscribes to live status updates.
///
/// ponytail: there is no browser/OS event for "the host timezone changed" —
/// this instead recomputes whenever the tab regains focus, which covers the
/// case that actually matters (a laptop closed in one timezone and opened in
/// another) without polling a clock.
export function initScheduledSend() {
  if (_initialized) return;
  _initialized = true;

  useScheduledStore.getState().loadRows()
    .then(() => useScheduledStore.getState().recomputeFireAt())
    .catch(() => {});

  listenTo('scheduled-send', (payload) => useScheduledStore.getState().applyEvent(payload));

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        useScheduledStore.getState().recomputeFireAt().catch(() => {});
      }
    });
  }
}
