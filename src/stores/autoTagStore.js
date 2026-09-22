import { create } from 'zustand';
import { daemonCall } from '../services/daemonClient';

// Auto Tags (Phase 4) — natural-language rules that assign an existing tag.
// Modeled on scheduledStore.js: one flat list, refetched on mount, patched
// from daemon events for the one thing that streams (backfill progress).
//
// `auto_tags.*` RPCs and their shapes: src-daemon/src/handlers/auto_tags.rs.
// A rule has no account_id — it runs against whichever account preview/
// backfill are pointed at, chosen in the UI each time.
export const useAutoTagStore = create((set, get) => ({
  rules: [],
  // ruleId -> { batchId, processed, total, matched, assigned, done }
  backfills: {},

  loadRules: async () => {
    const rules = await daemonCall('auto_tags.list', {});
    set({ rules: Array.isArray(rules) ? rules : [] });
    return get().rules;
  },

  /// Tag ids owned by an ENABLED hide rule — what messageListSlice.js's
  /// `deriveDisplayRows` filters out of the Inbox. A disabled rule's tag
  /// stays visible: disabling a rule must not silently keep hiding mail it
  /// no longer evaluates.
  hiddenTagIds: () => new Set(get().rules.filter(r => r.enabled && r.inboxAction === 'hide').map(r => r.tagId)),

  createRule: async (draft) => {
    const rule = await daemonCall('auto_tags.create', { rule: draft });
    set(state => ({ rules: [...state.rules.filter(r => r.id !== rule.id), rule] }));
    return rule;
  },

  updateRule: async (id, draft) => {
    const rule = await daemonCall('auto_tags.update', { id, rule: draft });
    set(state => ({ rules: state.rules.map(r => (r.id === id ? rule : r)) }));
    return rule;
  },

  deleteRule: async (id) => {
    await daemonCall('auto_tags.delete', { id });
    set(state => ({ rules: state.rules.filter(r => r.id !== id) }));
  },

  /// Writes nothing — `ruleId` (a saved rule) or `rule` (an unsaved draft,
  /// so a rule is previewable before it is ever created) picks which the
  /// daemon evaluates. See `rule_for_eval` in auto_tags.rs.
  preview: async ({ ruleId, rule, accountId, provider, limit }) => {
    const params = { accountId, provider: provider || { type: 'localGguf' }, limit: limit || 200 };
    if (ruleId) params.ruleId = ruleId; else params.rule = rule;
    const reply = await daemonCall('auto_tags.preview', params);
    return Array.isArray(reply?.candidates) ? reply.candidates : [];
  },

  /// Only a saved rule can be backfilled — undo has to point at a real row.
  backfill: async ({ ruleId, accountId, provider, limit }) => {
    set(state => ({ backfills: { ...state.backfills, [ruleId]: { processed: 0, total: 0, matched: 0, done: false } } }));
    const reply = await daemonCall('auto_tags.backfill', { ruleId, accountId, provider: provider || { type: 'localGguf' }, limit: limit || 200 });
    set(state => ({ backfills: { ...state.backfills, [ruleId]: { ...reply, done: true } } }));
    return reply;
  },

  /// `{batchId, ruleId, processed, total, matched}` off `auto-tag-backfill-progress`.
  applyProgress: (payload) => {
    if (!payload?.ruleId) return;
    set(state => ({ backfills: { ...state.backfills, [payload.ruleId]: { ...state.backfills[payload.ruleId], ...payload, done: false } } }));
  },

  /// `{batchId, ruleId, processed, total, matched, assigned}` off `auto-tag-backfill-complete`.
  applyComplete: (payload) => {
    if (!payload?.ruleId) return;
    set(state => ({ backfills: { ...state.backfills, [payload.ruleId]: { ...state.backfills[payload.ruleId], ...payload, done: true } } }));
  },

  /// Removes exactly what one backfill batch assigned. Idempotent on the
  /// daemon side (an already-undone or unknown batch unassigns nothing), so
  /// this always clears the local offer rather than leaving it stuck on a
  /// failed retry.
  undoBackfill: async (ruleId, batchId) => {
    const reply = await daemonCall('auto_tags.undo_backfill', { batchId });
    set(state => {
      const current = state.backfills[ruleId];
      if (!current || current.batchId !== batchId) return state;
      const backfills = { ...state.backfills };
      delete backfills[ruleId];
      return { backfills };
    });
    return reply;
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

/// Called once at app launch (see App.jsx): loads the rules and subscribes
/// to backfill progress/completion.
export function initAutoTags() {
  if (_initialized) return;
  _initialized = true;

  useAutoTagStore.getState().loadRules().catch(() => {});

  listenTo('auto-tag-backfill-progress', (payload) => useAutoTagStore.getState().applyProgress(payload));
  listenTo('auto-tag-backfill-complete', (payload) => useAutoTagStore.getState().applyComplete(payload));
}
