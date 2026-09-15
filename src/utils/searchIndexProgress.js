/** Spec 2026-09-14 §5.6, with the plan's rulings: a pass with nothing to parse shows nothing. */
export const BIG_BACKLOG = 500;
/** A pass must still be running after this long before the modal opens: short passes never flash. */
export const OPEN_DELAY_MS = 1500;

const backlog = (s) => (s?.total || 0) - (s?.indexed || 0);

export function wantsProgressUi(s) {
  if (!s || s.state !== 'indexing' || s.complete) return false;
  const left = backlog(s);
  return left > 0 && (!s.firstPassDone || left >= BIG_BACKLOG);
}

/** The build the user hid is over: the next big pass may open the modal again. */
export function buildFinished(s) {
  return !!s && (!!s.complete || (!!s.firstPassDone && backlog(s) < BIG_BACKLOG));
}

export function progressPercent(s) {
  return s?.total > 0 ? Math.min(100, Math.floor((100 * (s.indexed || 0)) / s.total)) : 0;
}
