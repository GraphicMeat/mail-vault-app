import { useEffect, useState } from 'react';

/**
 * Whether this build has to find its own spelling dictionaries, and whether it
 * found any.
 *
 * macOS and Windows check spelling themselves, so they answer
 * `needsDictionary: false` and nothing in the UI changes. Linux answers true,
 * and an empty `dictionaries` there is the case where the toolbar's toggle
 * would switch nothing on — the button offers the install instructions
 * instead of pretending.
 */

const NATIVE = { needsDictionary: false, dictionaries: [], confined: false };

// One answer per app run, shared by every compose window: dictionaries do not
// get installed while the app is open. The promise is cached as well as the
// value, so two windows opening at once still make one call, and a later
// window renders the answer on its first paint instead of flickering.
let pending = null;
let answer = null;

const invoker = () => (typeof window !== 'undefined' && window.__TAURI__?.core?.invoke) || null;

export function loadSpellcheckStatus() {
  if (pending) return pending;
  const invoke = invoker();
  if (!invoke) {
    // Dev server, web preview, jsdom: the browser is doing the checking.
    answer = NATIVE;
    pending = Promise.resolve(NATIVE);
    return pending;
  }
  // A build older than the command must not start nagging about dictionaries.
  pending = invoke('spellcheck_status')
    .catch(() => NATIVE)
    .then((s) => { answer = s; return s; });
  return pending;
}

export function useSpellcheckStatus() {
  // Outside Tauri the answer is known before the first render, which keeps the
  // toolbar out of a state update no test asked for.
  const [status, setStatus] = useState(() => answer ?? (invoker() ? null : NATIVE));
  useEffect(() => {
    if (status) return;
    let alive = true;
    loadSpellcheckStatus().then((s) => { if (alive) setStatus(s); });
    return () => { alive = false; };
  }, [status]);
  return status;   // null until the first answer arrives
}

/** Tests only: the cache is process-wide on purpose. */
export function resetSpellcheckStatusCache() {
  pending = null;
  answer = null;
}
