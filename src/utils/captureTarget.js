import { resolveEmailLocation } from '../stores/slices/unifiedHelpers';

/**
 * Which message a social capture is about, named the way the reader places it:
 * account, folder and uid (a bare uid is a different message in every other
 * folder). `state` is the mail store state.
 */
export function captureTargetOf(email, state) {
  const location = resolveEmailLocation(email, state);
  return location ? { uid: email.uid, accountId: location.accountId, mailbox: location.mailbox } : null;
}

/**
 * Whether `email` is the target. A target is compared on the fields it names
 * (the app always names all three; the e2e probe, which has no way to read the
 * account id, names the uid and folder).
 */
export function isCaptureTarget(email, target, state) {
  const own = target && email ? captureTargetOf(email, state) : null;
  if (!own || own.uid !== target.uid) return false;
  return ['accountId', 'mailbox'].every(field => target[field] == null || own[field] === target[field]);
}
