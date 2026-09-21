// ── Compose from surfaces App's props never reach ────────────────────────────
//
// The list's row menus sit four components below App with no compose prop,
// and threading one through EmailList → row → menu for two items is more
// plumbing than the feature. Same seam services/localDrafts.js and
// utils/mailto.js use: App registers the opener, callers hand it a state.

let _open = null;
let _reply = null;

export function registerComposeOpener(fn) { _open = fn; }
export function registerActiveReply(fn) { _reply = fn; }
export function openActiveReply(mode) { return _reply ? _reply(mode) !== false : false; }

/**
 * Open a compose window. `state` is what App's compose state takes:
 * `{ mode: 'reply' | 'replyAll' | 'forward', replyTo }` or `{ initialData }`.
 * False when no compose surface is mounted.
 */
export function openCompose(state) {
  if (!_open) return false;
  _open(state);
  return true;
}
