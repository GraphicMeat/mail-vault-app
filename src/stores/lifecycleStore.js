import { create } from 'zustand';
import { lifecycleSync, lifecycleMarkSeen, lifecycleDismiss } from '../services/api';
import { useSettingsStore } from './settingsStore';
import { showsFollowUps } from './followUpStore';
import { IS_APPSTORE_BUILD } from '../utils/buildFlags';

/**
 * In-app lifecycle messages: short notes from MailVault about Premium, shown
 * pinned above the inbox and opened in the reader. The daemon decides what is
 * due and keeps what was delivered (`lifecycle.sync`,
 * src-core/src/lifecycle_mail.rs); this store holds the rows it answers and
 * which one is open. Nothing here is mail: a row is never in a list, so no
 * list action can reach it (see FollowUpPinnedRows for the same reason).
 */

// Every kind the daemon delivers, as catalog keys. An unknown kind (a newer
// daemon) has no entry and is not shown, never rendered as a raw key.
const KEYS = {
  'trial-ending': { subjectKey: 'lifecycle.trialEnding.subject', bodyKey: 'lifecycle.trialEnding.body' },
  'checkout-left': { subjectKey: 'lifecycle.checkoutLeft.subject', bodyKey: 'lifecycle.checkoutLeft.body' },
  'plan-ended': { subjectKey: 'lifecycle.planEnded.subject', bodyKey: 'lifecycle.planEnded.body' },
  'free-nudge': { subjectKey: 'lifecycle.freeNudge.subject', bodyKey: 'lifecycle.freeNudge.body' },
};

export function lifecycleKeys(kind) {
  return KEYS[kind] || null;
}

/** The four facts the daemon decides on, and nothing else of the settings. */
export function lifecycleState(settings) {
  const p = settings.billingProfile;
  return {
    lifecycleMessages: settings.lifecycleMessages !== false,
    onboardingComplete: !!settings.onboardingComplete,
    lifecycleCheckoutAt: settings.lifecycleCheckoutAt ?? null,
    billingProfile: p
      ? { premiumAccess: p.premiumAccess, hasSubscription: p.hasSubscription, status: p.status, currentPeriodEnd: p.currentPeriodEnd }
      : null,
  };
}

/** The rows pinned in a view: an account's INBOX or All inboxes, nothing else. */
export function lifecycleInView(view, rows) {
  return showsFollowUps(view) ? rows : [];
}

let inflight = null;
let inflightKey = null;
let queued = false;

export const useLifecycleStore = create((set, get) => ({
  rows: [],
  openId: null,
  lastSyncAt: 0,

  /**
   * Ask the daemon what is due and show what it answers. One request at a
   * time; a call whose settings differ from the request in flight runs once
   * more after it, so a billing change never goes unasked.
   */
  sync() {
    if (IS_APPSTORE_BUILD) return Promise.resolve();
    const settings = useSettingsStore.getState();
    if (settings.lifecycleMessages === false) {
      set({ rows: [], openId: null });
      return Promise.resolve();
    }
    if (inflight) {
      if (JSON.stringify(lifecycleState(settings)) !== inflightKey) queued = true;
      return inflight;
    }
    const run = async () => {
      for (;;) {
        const state = lifecycleState(useSettingsStore.getState());
        inflightKey = JSON.stringify(state);
        queued = false;
        set({ lastSyncAt: Date.now() });
        try {
          const res = await lifecycleSync(state);
          const rows = Array.isArray(res?.rows) ? res.rows : [];
          set({ rows, openId: rows.some((r) => r.id === get().openId) ? get().openId : null });
        } catch { /* no daemon: keep what is shown */ }
        if (!queued) return;
      }
    };
    inflight = run().finally(() => { inflight = null; inflightKey = null; });
    return inflight;
  },

  /** Show a message in the reader. Reading it is recorded, once. */
  open(id) {
    const row = get().rows.find((r) => r.id === id);
    if (!row) return;
    set({ openId: id, rows: row.seen ? get().rows : get().rows.map((r) => (r.id === id ? { ...r, seen: true } : r)) });
    if (!row.seen) lifecycleMarkSeen(id).catch(() => {});
  },

  close() {
    if (get().openId) set({ openId: null });
  },

  dismiss(id) {
    set({ rows: get().rows.filter((r) => r.id !== id), openId: get().openId === id ? null : get().openId });
    lifecycleDismiss(id).catch(() => {});
  },
}));
