// What Compose's Send button does, given what the "Send later" panel armed.
//
// A plan is null (send now, the global send delay applies), `{ kind: 'in',
// minutes }` or `{ kind: 'at' }` (the picked `_scheduleDraft`). A delay that
// fits the undo window goes through the in-memory undo-send queue, free and
// undoable; anything longer is a scheduled send the daemon holds, so it
// survives a quit: an in-memory timer carrying hours would not. The routing
// itself is core's `compose_prep::route_send`, answered by `compose.check`.

export const FREE_DELAY_MINUTES = 5;
export const MAX_DELAY_MINUTES = 24 * 60;

/** Hours and minutes as a total, clamped to 0..max (never past 24h 0m). */
export function clampDelay(hours, minutes, max = MAX_DELAY_MINUTES) {
  const total = (Number(hours) || 0) * 60 + (Number(minutes) || 0);
  return Math.min(Math.max(0, Math.round(total)), max);
}
