// The phone's preferences (engine `mobile.prefs.*`, `settings.rs` PREFS) and the pure helpers
// that read them. The defaults are the phone's behaviour before there were preferences, and the
// engine's own defaults: a page that has not read them yet behaves as before. A desktop import
// sets them once (W1a); the user changes them in Settings.

export const PREF_DEFAULTS = Object.freeze({
  theme: 'system',
  palette: 'indigo',
  markAsReadMode: 'auto',
  markAsReadDelay: 3,
  confirmBeforeDelete: false,
  afterDeleteSelect: 'next',
  swipeLeftAction: 'delete',
  swipeRightAction: 'toggleRead',
  sendDelay: 0,
  defaultSignatureEnabled: true,
  holdExternalContent: true,
  trackerBlockingEnabled: true,
  dateFormat: 'auto',
  customDateFormat: '',
  timeFormat: 'auto',
  emailViewerTheme: 'system',
  // Link safety (Viewer.jsx): the engine scans links; a flagged one asks before it opens.
  linkSafetyEnabled: true,
  linkSafetyClickConfirm: true,
  // Conversations (desktop's default): the list shows one row per conversation; flat lists every
  // message. The phone opens a conversation on a screen of its own in either threaded mode.
  threadMode: 'expandable',
  threadSortOrder: 'oldest-first',
  // Compose asks before sending a message that mentions an attachment and carries none.
  attachmentReminder: true,
  // Compose's "Templates": `[{name, body}]` (Settings > Mail preferences).
  templates: Object.freeze([]),
});

export const THREAD_MODES = ['grouped', 'expandable', 'flat'];
export const THREAD_ORDERS = ['oldest-first', 'newest-first'];

/** Whether the list shows conversations (`threadMode` grouped or expandable). */
export const threadedList = (prefs) => (prefs || PREF_DEFAULTS).threadMode !== 'flat';

/** The messages a list row stands for: a conversation's every message, else its own. */
export const rowUids = (row) => (Array.isArray(row?.threadUids) && row.threadUids.length ? row.threadUids : [row.uid]);

/** What a swipe may do on the phone (the engine's SWIPES). */
export const SWIPE_ACTIONS = ['toggleRead', 'delete', 'flag', 'move', 'none'];
export const THEMES = ['system', 'light', 'dark'];
export const PALETTES = ['indigo', 'graphite', 'teal'];
export const SEND_DELAYS = [0, 5, 10, 20, 30];
export const MARK_READ_DELAYS = [1, 3, 5, 10];

/**
 * The theme a message is shown in, as desktop decides it: the email viewer's own choice, else the
 * app's theme, else the system's (`systemLight`).
 */
export function viewerTheme(systemLight, prefs) {
  const own = prefs?.emailViewerTheme;
  if (own === 'light' || own === 'dark') return own;
  const app = prefs?.theme;
  if (app === 'light' || app === 'dark') return app;
  return systemLight ? 'light' : 'dark';
}

/** The engine's answer over the defaults; a value of the wrong type keeps the default. */
export function readPrefs(reply) {
  const out = { ...PREF_DEFAULTS };
  if (!reply || typeof reply !== 'object') return out;
  for (const key of Object.keys(PREF_DEFAULTS)) {
    const list = Array.isArray(PREF_DEFAULTS[key]);
    if (list ? Array.isArray(reply[key]) : typeof reply[key] === typeof PREF_DEFAULTS[key]) out[key] = reply[key];
  }
  return out;
}

/** The accounts the switcher, the drawer and All Inboxes list: every one not hidden. */
export function visibleAccounts(accounts) {
  return (accounts || []).filter((a) => !a?.hidden);
}

/**
 * When opening a message marks it read: `{ now: true }` (auto), `{ afterMs }` (delay) or
 * `{ never: true }` (manual, the toolbar's read button only).
 */
export function markReadPlan(prefs) {
  const p = prefs || PREF_DEFAULTS;
  if (p.markAsReadMode === 'manual') return { never: true };
  if (p.markAsReadMode === 'delay' && p.markAsReadDelay > 0) return { afterMs: p.markAsReadDelay * 1000 };
  return { now: true };
}

/**
 * The row the viewer shows after a delete, by `afterDeleteSelect`: `next` the one below, `previous`
 * the one above (each falling back to the other side, as the desktop does), `none` back to the list.
 * `rowAt(i)` reads the list; `same(row)` is true for the deleted row itself.
 */
export function afterDeleteRow(mode, index, rowAt, same) {
  if (mode === 'none' || index < 0) return undefined;
  const ok = (r) => (r && !same(r) ? r : undefined);
  const below = ok(rowAt(index + 1));
  const above = index > 0 ? ok(rowAt(index - 1)) : undefined;
  return mode === 'previous' ? above || below : below || above;
}

/** A swipe action as the row runs it: `{ kind }` for the store's act, `move`, or null for none. */
export function swipeKind(action, row) {
  switch (action) {
    case 'toggleRead': return row.seen ? 'unseen' : 'seen';
    case 'delete': return 'delete';
    case 'flag': return row.flagged ? 'unflag' : 'flag';
    case 'move': return 'move';
    default: return null;
  }
}

/** HTML to plain text, for a signature in the plain-text compose. */
export function htmlToText(html) {
  if (!html) return '';
  const withBreaks = String(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n');
  let text;
  if (typeof DOMParser === 'function') {
    text = new DOMParser().parseFromString(withBreaks, 'text/html').body.textContent || '';
  } else {
    text = withBreaks.replace(/<[^>]*>/g, '');
  }
  return text.replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The signature compose appends for `account` (`mobile.accountSettings.get`), or '' when it has
 * none or it is off (its own `enabled`, and signatures overall: `defaultSignatureEnabled`).
 * Plain text: its `text`, else its html as text.
 */
export function signatureFor(accountSettings, prefs) {
  const sig = accountSettings?.signature;
  if (!sig || sig.enabled === false) return '';
  if ((prefs || PREF_DEFAULTS).defaultSignatureEnabled === false) return '';
  return (sig.text && sig.text.trim()) || htmlToText(sig.html);
}

/** `body` with `signature` under it, after the "-- " separator. Unchanged without one. */
export function withSignature(body, signature) {
  if (!signature) return body;
  const sep = signature.startsWith('--') ? '' : '-- \n';
  return `${body || ''}\n\n${sep}${signature}`;
}

/** Puts the theme and palette on the root element; `system` leaves the light/dark to the OS. */
export function applyLook(prefs, root = typeof document !== 'undefined' ? document.documentElement : null) {
  if (!root) return;
  const p = prefs || PREF_DEFAULTS;
  if (p.theme === 'light' || p.theme === 'dark') root.setAttribute('data-theme', p.theme);
  else root.removeAttribute('data-theme');
  root.setAttribute('data-palette', PALETTES.includes(p.palette) ? p.palette : 'indigo');
}
