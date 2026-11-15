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
  // Mail view: the message list, or chat (people, then their conversations: ChatView.jsx).
  viewStyle: 'list',
  // The home screen icon (appIcon.js; the shell switches the OS icon).
  appIcon: 'purple',
  // Compose asks before sending a message that mentions an attachment and carries none.
  attachmentReminder: true,
  // Settings > Search index (SearchIndexSettings.jsx): body words, and attachment text (Premium).
  searchIndexBodies: true,
  searchIndexAttachments: true,
  // Compose's "Templates": `[{name, body}]` (Settings > Mail preferences).
  templates: Object.freeze([]),
  // Appearance: the page's text size and font (applyLook), list rows (rowHeight, MessageRow.jsx),
  // signatures in a message (mailFrame.js `foldSignatures`), the viewer toolbar (Viewer.jsx).
  textScale: 1,
  appFont: 'instrument-sans',
  listDensity: 'comfortable',
  listPreviewLines: 1,
  signatureDisplay: 'always-show',
  actionButtonDisplay: 'icon-only',
  // Mail: rows swipe (MessageRow.jsx); a sync on launch and on coming back to the front (store.js
  // `init`, App.jsx); attachments fetched as a message opens (AttachmentChip.jsx); the row after a
  // delete in All Inboxes (afterDeletePick).
  trackpadSwipeEnabled: true,
  refreshOnLaunch: true,
  autoDownloadAttachments: false,
  afterDeleteSameAccount: false,
  // Notifications (engine: the background run's `sound` and `badge`, posted by the shell).
  notificationSound: true,
  badgeEnabled: false,
  badgeMode: 'unread',
  // The viewer's bar, in order (quickActions.js; Settings > Appearance > Quick actions).
  quickActionsReader: Object.freeze(['toggleRead', 'flag', 'move', 'delete']),
  // Settings > Logs: Standard masks addresses in the engine's log file, Verbose keeps them.
  logVerbosity: 'standard',
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
/** Desktop's `TEXT_SCALES` (src/utils/appFont.js; a test keeps them equal). */
export const TEXT_SCALES = [0.9, 1, 1.1, 1.25, 1.5];
/**
 * Desktop's bundled `APP_FONTS` (src/utils/appFont.js, copied: that module loads Google fonts
 * through the desktop daemon). Every family ships in styles/fonts.css; the phone fetches none.
 */
export const APP_FONTS = Object.freeze([
  { id: 'system' },
  { id: 'instrument-sans', family: 'Instrument Sans' },
  { id: 'inter', family: 'Inter' },
  { id: 'atkinson', family: 'Atkinson Hyperlegible Next' },
  { id: 'ibm-plex-sans', family: 'IBM Plex Sans' },
  { id: 'source-sans', family: 'Source Sans 3' },
  { id: 'jetbrains-mono', family: 'JetBrains Mono', mono: true },
  { id: 'fira-code', family: 'Fira Code', mono: true },
  { id: 'ibm-plex-mono', family: 'IBM Plex Mono', mono: true },
]);
export const LIST_DENSITIES = ['comfortable', 'compact'];
export const PREVIEW_LINES = [0, 1, 2, 3];
export const SIGNATURE_DISPLAYS = ['smart', 'collapsed', 'always-show', 'always-hide'];
export const ACTION_BUTTON_DISPLAYS = ['icon-only', 'icon-label', 'text-only'];
export const BADGE_MODES = ['unread', 'total'];

const SYSTEM_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, Ubuntu, sans-serif";

/** The CSS font stack of an `APP_FONTS` id, as desktop's `fontStack` builds it. */
export function fontStack(id) {
  const font = APP_FONTS.find((f) => f.id === id) || APP_FONTS.find((f) => f.id === PREF_DEFAULTS.appFont);
  if (!font.family) return SYSTEM_STACK;
  return `'${font.family}', ${font.mono ? 'ui-monospace, monospace' : 'system-ui, sans-serif'}`;
}

/**
 * A list row's height in px (every row the same, so the virtualizer never measures): the sender
 * and subject lines, `listPreviewLines` lines of the message's text, all scaled by `textScale`,
 * and the padding `listDensity` gives. The defaults are the phone's row as it was (76).
 */
export function rowHeight(prefs) {
  const p = prefs || PREF_DEFAULTS;
  const lines = PREVIEW_LINES.includes(p.listPreviewLines) ? p.listPreviewLines : 1;
  const text = (40 + 18 * lines) * (TEXT_SCALES.includes(p.textScale) ? p.textScale : 1);
  return Math.ceil(text) + (p.listDensity === 'compact' ? 10 : 18);
}

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
  return afterDeletePick(mode, index, rowAt, same)?.row;
}

/** How far a same-account pick looks past the deleted row, each way. */
const SAME_ACCOUNT_REACH = 200;

/**
 * `afterDeleteRow` with where the row is: `{ row, index }` (`index` in the list as it was, the
 * deleted row still in it), or undefined. With `accountId` (`afterDeleteSameAccount` in a list
 * that spans accounts) the nearest row of that account on the preferred side, else on the other,
 * as desktop prefers it; the list's other rows only when that account has no other row loaded.
 */
export function afterDeletePick(mode, index, rowAt, same, accountId = null) {
  if (mode === 'none' || index < 0) return undefined;
  const ok = (r) => (r && !same(r) ? r : undefined);
  const near = (step, match) => {
    for (let i = index + step, n = 0; i >= 0 && n < SAME_ACCOUNT_REACH; i += step, n++) {
      const r = rowAt(i);
      if (!r) return undefined; // the end of the list, or of what is loaded
      if (ok(r) && match(r)) return { row: r, index: i };
    }
    return undefined;
  };
  const order = mode === 'previous' ? [-1, 1] : [1, -1];
  if (accountId) {
    const mine = (r) => r.accountId === accountId;
    const hit = near(order[0], mine) || near(order[1], mine);
    if (hit) return hit;
  }
  const adjacent = (step) => {
    const i = index + step;
    const r = i >= 0 ? ok(rowAt(i)) : undefined;
    return r ? { row: r, index: i } : undefined;
  };
  return adjacent(order[0]) || adjacent(order[1]);
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
  // Text size: the CSS sizes text in rem, so the root's font size scales it all (rows grow with
  // it, rowHeight). Font: the stack mobile.css's --mv-font reads.
  const scale = TEXT_SCALES.includes(p.textScale) ? p.textScale : 1;
  if (root.style) {
    if (scale === 1) root.style.removeProperty('font-size');
    else root.style.setProperty('font-size', `${16 * scale}px`);
    root.style.setProperty('--app-font', fontStack(p.appFont));
  }
}
