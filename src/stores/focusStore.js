import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { safeStorage } from './safeStorage';
import { t } from '../i18n/index.js';
import { sendNotification } from '../services/api';
import { normalizeNotificationSound } from '../utils/notificationSounds';
import { decide } from '../utils/notificationPolicy.js';
import { useSettingsStore } from './settingsStore';

/**
 * A focus session: a countdown that covers the whole window while it runs.
 *
 * There is no unlocked mode. A running session IS the lock — `endsAt` is the
 * only flag — and quitting the app is not an escape hatch: the end stamp is
 * persisted, so a relaunch inside the window comes back covered. What is
 * deliberately NOT persisted is `held`: see the note on the field.
 *
 * There is exactly one interval in the app for this. Every subscriber derives
 * its own remaining time from `useFocusClock`, rather than running a timer of
 * its own — two components with their own `setInterval` drift apart within a
 * minute and disagree on screen.
 */

/**
 * The clock, epoch ms, written once a second by the ticker. Deliberately NOT
 * in the persisted store: every `set` there hits `safeStorage.setItem`, which
 * debounces a rewrite of the whole settings file, so a 25-minute session would
 * rewrite it ~1500 times. Same split as `backupStore.js` (see settingsStore).
 *
 * Declared before `useFocusStore` so `arm` can write it even when rehydration
 * runs synchronously inside `create()`. A clock reading is not worth
 * persisting anyway: a stale one is worse than none.
 */
export const useFocusClock = create(() => ({ now: 0 }));

let ticker = null;

function disarm() {
  useFocusClock.setState({ now: 0 });
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

/**
 * Idempotent: a second arm while one is running is a no-op, never a second
 * interval. Takes the persisted store's api rather than reaching for
 * `useFocusStore`, so rehydration — which runs synchronously inside `create()`
 * when storage reads synchronously — cannot touch the binding before it exists.
 */
function arm(get) {
  useFocusClock.setState({ now: Date.now() });
  if (ticker) return;
  ticker = setInterval(() => {
    const { endsAt, finish } = get();
    if (!endsAt) return disarm();
    const now = Date.now();
    if (now >= endsAt) finish();
    else useFocusClock.setState({ now });
  }, 1000);
}

/**
 * What the lock held back, delivered once it lifts.
 *
 * Past a handful, the burst IS the interruption — the point of the session was
 * to not be interrupted, and ending it with eight banners in a row undoes that.
 * // ponytail: 3 is a guess; tune when someone complains
 */
function flushHeld(held) {
  if (!held.length) return;
  if (held.length > 3) {
    notify(t('focus.heldTitle'), t('focus.heldBody', { count: held.length }), held.find(n => n.sound)?.sound);
    return;
  }
  // A released batch gets one chime, even when it has several banners.
  let playedSound = false;
  for (const n of held) {
    notify(n.title, n.body, playedSound ? undefined : n.sound, n.target);
    if (n.sound) playedSound = true;
  }
}

export const useFocusStore = create(
  persist(
    (set, get) => ({
      durationMin: 25,      // persisted — the last preset chosen
      endsAt: null,         // persisted — epoch ms while a session runs

      // { title, body, sound?, target? } held while a session runs.
      // ponytail: a relaunch drops held notifications; persist them if anyone misses one
      held: [],

      start: (minutes) => {
        set({
          durationMin: minutes,
          endsAt: Date.now() + minutes * 60_000,
          held: [],
        });
        arm(get);
      },

      /** The timer ran out. The native notification is the whole celebration. */
      finish: () => {
        disarm();
        const { held, durationMin } = get();
        set({ endsAt: null, held: [] });
        notify(t('focus.doneTitle'), t('focus.doneBody', { count: durationMin }));
        flushHeld(held);
      },

      /** Stopped early. Held work still arrives; no congratulations. */
      abandon: () => {
        disarm();
        const { held } = get();
        set({ endsAt: null, held: [] });
        flushHeld(held);
      },

      hold: (n) => set(s => ({ held: [...s.held, n] })),

      /**
       * Called after rehydration. A session that expired while the app was shut
       * clears without a word — there is nothing left to hold back, and a
       * "complete" banner for a session nobody sat through is a lie.
       */
      resume: () => {
        const { endsAt } = get();
        if (!endsAt) return;
        if (endsAt <= Date.now()) {
          set({ endsAt: null });
          return;
        }
        arm(get);
      },
    }),
    {
      name: 'mailvault-focus',
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => ({
        durationMin: s.durationMin,
        endsAt: s.endsAt,
      }),
      merge: (persisted, current) => ({ ...current, ...(persisted || {}) }),
      onRehydrateStorage: () => (state) => state?.resume(),
    }
  )
);

// The last 200 notification-policy decisions, newest last. In-memory only —
// // ponytail: lost on restart; persist to app.db if users need it to survive one.
const MAX_DECISIONS = 200;
let decisionLog = [];

function recordDecision(entry) {
  decisionLog.push(entry);
  if (decisionLog.length > MAX_DECISIONS) decisionLog.shift();
}

/** A copy, so a settings panel holding this snapshot never sees it grow underfoot. */
export function getNotificationDecisions() {
  return decisionLog.slice();
}

export function clearNotificationDecisions() {
  decisionLog = [];
}

/**
 * THE chokepoint for every native notification in the app.
 *
 * Anything that would interrupt the user goes through here, so a locked session
 * can hold it. A caller reaching past this into `services/api.sendNotification`
 * is a banner that fires through the lock — `notifyChokepoint.test.js` fails on
 * one. Never rejects: a notification that could not be shown is not worth
 * failing a backup or a sync over.
 *
 * `mailCtx` is optional and only ever set for mail-arrival banners
 * (`{ accountId, folder, from, domain, viewIds }`) — backup/billing/focus
 * notifications pass none of it and are always delivered as before. When
 * present, the notification policy (`utils/notificationPolicy.decide`)
 * decides whether this actually goes out, and the outcome is recorded in the
 * decision log either way — that's the only way a suppressed notification
 * ever shows up in "why didn't I get this".
 */
export function notify(title, body, sound, target, mailCtx) {
  const selectedSound = normalizeNotificationSound(sound);
  const audible = selectedSound !== 'none';
  const s = useFocusStore.getState();
  const focusHeld = !!s.endsAt;

  if (mailCtx) {
    const policy = useSettingsStore.getState().notificationSettings;
    const decision = decide({ ...mailCtx, focusHeld, now: Date.now() }, policy);
    recordDecision({ ts: Date.now(), subject: title, from: mailCtx.from || '', deliver: decision.deliver, reason: decision.reason });
    if (!decision.deliver && decision.reason !== 'focus-hold') return Promise.resolve();
  }

  if (focusHeld) {
    s.hold({ title, body, ...(audible ? { sound: selectedSound } : {}), ...(target ? { target } : {}) });
    return Promise.resolve();
  }
  const sent = target
    ? sendNotification(title, body, audible ? selectedSound : undefined, target)
    : audible ? sendNotification(title, body, selectedSound) : sendNotification(title, body);
  return sent
    .catch(err => console.error('[focus] notification failed:', err));
}

export const remainingMs = (state) =>
  state.endsAt ? Math.max(0, state.endsAt - state.now) : 0;

/**
 * mm:ss, seconds rounded UP — so a running session never shows 00:00 while it
 * still has time on it. Minutes may exceed 59: a custom session runs up to 480
 * minutes, so the field carries 480:00 rather than rolling over into hours.
 */
export function formatRemaining(ms) {
  const total = Math.ceil(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
