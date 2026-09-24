// What Compose's Send button does, given what the "Send later" panel armed.
//
// A plan is null (send now, the global send delay applies), `{ kind: 'in',
// minutes }` or `{ kind: 'at' }` (the picked `_scheduleDraft`). A delay that
// fits the undo window goes through the in-memory undo-send queue, free and
// undoable; anything longer is a scheduled send the daemon holds, so it
// survives a quit: an in-memory timer carrying hours would not.

import { wallClockAt } from './scheduledTime';

export const FREE_DELAY_MINUTES = 5;
export const MAX_DELAY_MINUTES = 24 * 60;

/** Hours and minutes as a total, clamped to 0..max (never past 24h 0m). */
export function clampDelay(hours, minutes, max = MAX_DELAY_MINUTES) {
  const total = (Number(hours) || 0) * 60 + (Number(minutes) || 0);
  return Math.min(Math.max(0, Math.round(total)), max);
}

/**
 * `{ delay }` (seconds; null = the global delay) for the undo-send queue, or
 * `{ draft }` ({ localTime, tz }) for a scheduled send. A relative plan's
 * wall clock is taken at Send, in the machine's zone, not when it was armed.
 */
export function routeSend(plan, scheduleDraft, now = Date.now(), tz = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  if (plan?.kind === 'at') return { draft: scheduleDraft };
  if (plan?.kind !== 'in' || !(plan.minutes > 0)) return { delay: null };
  if (plan.minutes <= FREE_DELAY_MINUTES) return { delay: plan.minutes * 60 };
  // Rounded up to the next whole minute: a truncated wall clock could land
  // under the delay the user asked for.
  return { draft: { localTime: wallClockAt(now + plan.minutes * 60_000 + 59_999, tz), tz } };
}
