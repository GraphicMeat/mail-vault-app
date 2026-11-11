import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { send } from './transport';
import { t, getLocale } from '../i18n/index.js';
import { stripGoogleFontImports } from '../utils/mailFonts';
import { noteFramedBody } from '../stores/netActivityStore';
import { emailScopeKey } from '../stores/slices/unifiedHelpers';
import { useSettingsStore } from '../stores/settingsStore';

/**
 * The reader's scan of a mail body, asked of the daemon (`body.scan`,
 * src-core/src/body_scan): tracking pixels found (and, when blocking, the
 * body with each replaced by a visible marker), and, when link safety is on,
 * the body with every link titled with where it goes and the suspicious ones
 * marked `data-link-alert`. Every renderer of a body (reading pane, thread,
 * chat, full view, the pop-out windows, previews) frames what comes back.
 *
 * Google Font imports leave the body here, before the scan: the webview would
 * fetch them itself, unseen (the families come through fontService).
 *
 * One answer per (message key, body, language, blocking, links), kept for the
 * session, so a re-render or a theme toggle never asks again. A failed call is
 * not kept, and answers `scanned: false` with the body as given: the renderer
 * then frames it with remote images refused (UNSCANNED_HEAD), never as "clean".
 *
 * "Ask before loading external content" (`holdExternalContent`) is a decision
 * about the frame, not about the scan: the body is never rewritten, so "Load
 * external content" asks the daemon nothing. A scan framed under it says
 * `holding`, and the frame refuses what the body would fetch: the CSP below in
 * an iframe, `allowRemote` off on Blitz, which fetches images itself. `remote`,
 * the daemon's count, only decides whether a load is worth offering, so what it
 * misses stays out too.
 */

/** The catalog keys whose templates the daemon writes reasons and markers with. */
export const BODY_TEXT_KEYS = [
  'util.trackerDetect.blockedExplain',
  'util.trackerDetect.blockedLabel',
  'util.trackerDetect.vendorBeacon',
  'util.trackerDetect.beaconPath',
  'util.trackerDetect.imageHiddenCssSoNever',
  'util.trackerDetect.imageHiddenInsideCollapsedContainer',
  'util.trackerDetect.invisibleImageReadReceiptPicture',
  'linkSafety.reason.dangerousScheme',
  'linkSafety.reason.textMismatch',
  'linkSafety.reason.redirect',
  'linkSafety.reason.ipAddress',
];

/** The UI language's templates (`t(key)` with no values leaves the `{{slots}}` in). */
export const bodyTexts = () => Object.fromEntries(BODY_TEXT_KEYS.map(k => [k, t(k)]));

/**
 * For a body the daemon could not scan: no remote image loads, so no beacon
 * fires. A second CSP <meta>: policies intersect, so it only narrows.
 */
export const UNSCANNED_HEAD = '<meta http-equiv="Content-Security-Policy" content="img-src data: blob: cid:">';

/**
 * While a body's external content is held back: everything a frame can fetch,
 * because a pop-out window loads from file:// and inherits no app CSP. Not
 * default-src, which would reach script-src and stop our own nonced scripts.
 */
export const EXTERNAL_HELD_HEAD = `<meta http-equiv="Content-Security-Policy" content="img-src data: blob: cid:; media-src data: blob:; font-src data: blob:; style-src 'unsafe-inline'; frame-src 'none'; object-src 'none'; connect-src data: blob:">`;

/** The marks on a flagged link, placed in the frame's <head> when any link is flagged. */
export const LINK_ALERT_STYLE = `
  a[data-link-alert]::before {
    display: inline !important;
    margin-right: 3px !important;
    font-size: 0.9em !important;
    cursor: help !important;
  }
  a[data-link-alert="red"]::before {
    content: "\\26A0" !important;
    color: #ef4444 !important;
  }
  a[data-link-alert="yellow"]::before {
    content: "\\26A0" !important;
    color: #f59e0b !important;
  }
  a[data-link-alert="red"] {
    outline: 2px solid rgba(239, 68, 68, 0.3) !important;
    outline-offset: 2px !important;
    border-radius: 2px !important;
  }
  a[data-link-alert="yellow"] {
    outline: 2px solid rgba(245, 158, 11, 0.3) !important;
    outline-offset: 2px !important;
    border-radius: 2px !important;
  }
`;

/**
 * Whether a renderer that fetches images itself (Blitz) may load remote content
 * for this scan. An unscanned body is still drawn, with remote content off: the
 * same refusal UNSCANNED_HEAD gives the iframe. Drawing nothing left the reader
 * empty whenever a scan failed or ran out of time.
 */
export const remoteAllowed = (scan) => !!scan?.scanned && !scan.holding;

/** What this scan's frame must refuse, or nothing. Every frame carries this, however it builds its head. */
export const refusalHead = (scan) => (scan?.holding ? EXTERNAL_HELD_HEAD : scan && !scan.scanned ? UNSCANNED_HEAD : '');

/** What a renderer puts in the frame's <head> for this scan: the refusal, and the link marks. */
export function scanHead(scan) {
  if (!scan) return '';
  return `${refusalHead(scan)}${scan.alerts.length > 0 ? `<style>${LINK_ALERT_STYLE}</style>` : ''}`;
}

/**
 * FNV-1a over the body HTML, plus its length: proof that an answer belongs to
 * the body in hand, kept small instead of a second copy of every body.
 */
export function bodyStamp(html) {
  let h = 0x811c9dc5;
  for (let i = 0; i < html.length; i++) {
    h = Math.imul(h ^ html.charCodeAt(i), 0x01000193);
  }
  return `${html.length}:${(h >>> 0).toString(36)}`;
}

const KEPT = 500;
const answers = new Map();
/**
 * How long a scan may take before the body is framed as unscanned (remote
 * images refused). The shell bounds `body.scan` at 30 s (`reply_timeout`);
 * this holds even when the reply never comes back to the window at all.
 */
export const SCAN_BUDGET_MS = 30000;
// The last answer per message key, for the row and header tooltips.
const trackersByKey = new Map();
const alertsByKey = new Map();
// The messages the user said "load" for this session, by holdKey. Not kept
// across launches: the next open of a message asks again, as Apple Mail does.
const useExternalAllowed = create(() => ({ keys: new Set() }));

export function _resetBodyScans() {
  answers.clear();
  trackersByKey.clear();
  alertsByKey.clear();
  useExternalAllowed.setState({ keys: new Set() });
}

/** "Load external content" for the message a held scan names (`scan.holdKey`). */
export function allowExternalContent(holdKey) {
  if (!holdKey) return;
  useExternalAllowed.setState(s => ({ keys: new Set(s.keys).add(holdKey) }));
}

// The message, or for a surface with no scoped key (a preview, a quoted
// original), its body.
const holdKeyOf = (html, key) => key || bodyStamp(html || '');

/** How long a frame waits for its window's settings before drawing without them. */
export const SETTINGS_WAIT_MS = 5000;

/**
 * Has this window read its settings? A detached window gets its body by event
 * and its settings over an async RPC: framed first, a body loads under the
 * default and its images have fired by the time "on" arrives. Bounded, because
 * a failed read never fires the listener (adoptGraphFolderKeys HYDRATION_WAIT_MS).
 */
function useSettingsRead() {
  const persist = useSettingsStore.persist;
  const known = () => !persist?.hasHydrated || persist.hasHydrated();
  const [read, setRead] = useState(known);
  useEffect(() => {
    if (read) return undefined;
    if (known()) {
      setRead(true);
      return undefined;
    }
    const timer = setTimeout(() => setRead(true), SETTINGS_WAIT_MS);
    const stop = persist.onFinishHydration(() => setRead(true));
    return () => { clearTimeout(timer); stop(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return read;
}

/** A scan as its frame draws it. The setting off hands back the scan itself. */
function scanAsFramed(scan, html, key) {
  if (!scan || !useSettingsStore.getState().holdExternalContent) return scan;
  const holdKey = holdKeyOf(html, key);
  return { ...scan, holdKey, holding: !useExternalAllowed.getState().keys.has(holdKey) };
}

const idOf = (html, { key, blocking, links } = {}) =>
  `${key || ''}\u0000${bodyStamp(html)}\u0000${getLocale()}\u0000${blocking ? 1 : 0}${links ? 1 : 0}`;

const emptyScan = (html) => ({ trackers: [], count: 0, https: 0, remote: 0, summary: null, html: html || '', alerts: [], maxAlertLevel: null, scanned: true });

/** The body as given, not scanned: framed with remote images refused. */
export const unscanned = (html) => ({ ...emptyScan(html), scanned: false });

function framed(body, ans) {
  return {
    trackers: Array.isArray(ans?.trackers) ? ans.trackers : [],
    count: ans?.count || 0,
    https: ans?.https || 0,
    remote: ans?.remote || 0,
    summary: ans?.summary || null,
    html: typeof ans?.html === 'string' ? ans.html : body,
    alerts: Array.isArray(ans?.alerts) ? ans.alerts : [],
    maxAlertLevel: ans?.maxAlertLevel || null,
    scanned: true,
  };
}

/** The answer already in hand for this body, or undefined. */
export function peekBodyScan(html, opts = {}) {
  if (!html) return emptyScan(html);
  return answers.get(idOf(html, opts))?.value;
}

/**
 * Scan a body: `{ trackers, count, https, remote, summary, html, alerts, maxAlertLevel, scanned }`.
 * `opts.key` is the scoped message key (`emailScopeKey`), null when the
 * message cannot be located: never a bare uid. `blocking` swaps in the cleaned
 * body (premium, `isTrackerBlockingActive`); `links` runs the link scan.
 */
export function scanBody(html, opts = {}) {
  if (!html) return Promise.resolve(emptyScan(html));
  const id = idOf(html, opts);
  let entry = answers.get(id);
  if (entry) return entry.promise;
  const body = stripGoogleFontImports(html);
  entry = {};
  let timer;
  const budget = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('body.scan did not answer in time')), SCAN_BUDGET_MS);
  });
  const asked = send('body.scan', { html: body, blocking: !!opts.blocking, links: !!opts.links, texts: bodyTexts() });
  entry.promise = Promise.race([asked, budget]).finally(() => clearTimeout(timer)).then(
    (ans) => {
      entry.value = framed(body, ans);
      if (opts.key) {
        trackersByKey.set(opts.key, entry.value.trackers);
        if (opts.links) alertsByKey.set(opts.key, entry.value.alerts);
      }
      return entry.value;
    },
    (e) => {
      console.warn('[bodyScan] body.scan failed:', e?.message || e);
      answers.delete(id);
      return unscanned(body);
    },
  );
  answers.set(id, entry);
  evict();
  return entry.promise;
}

// The oldest answered scans go first. One still being asked is never dropped:
// its answer would land in an entry nobody can find.
function evict() {
  if (answers.size <= KEPT) return;
  for (const [id, entry] of answers) {
    if (answers.size <= KEPT) return;
    if (entry.value) answers.delete(id);
  }
}

/** What a frame draws, counted for Network Activity once per message (and only then). */
function noteFramed(scan, html, opts = {}) {
  if (scan?.scanned && html) noteFramedBody(scan, opts.key || bodyStamp(html), !!opts.blocking);
}

/**
 * `scanBody` for a renderer outside React (the pop-out windows): the answer is
 * framed, so it counts for Network Activity. A scan nobody frames (the list's
 * tracker backfill) counts nothing.
 */
export async function scanForFrame(html, opts = {}) {
  const scan = scanAsFramed(await scanBody(html, opts), html, opts.key);
  noteFramed(scan, html, opts);
  return scan;
}

/**
 * The scan of `html` for a renderer: the answer, or undefined while it is
 * asked. A renderer frames nothing until it has one: framing the raw body
 * first would fire the beacons blocking is about to strip. Re-renders with the
 * same object until the answer or the user's decision on this message changes:
 * a frame memoizes on it, and another message's load must not reload this one.
 */
export function useBodyScan(html, opts = {}) {
  const { key = null, blocking = false, links = false } = opts;
  const id = html ? idOf(html, { key, blocking, links }) : '';
  // The last answer this renderer got, kept here too: the shared cache may
  // drop it (500 other bodies scanned meanwhile) while the frame still shows it.
  const [held, setHeld] = useState(null);
  const answer = peekBodyScan(html, { key, blocking, links }) ?? (held?.id === id ? held.scan : undefined);
  const settingsRead = useSettingsRead();
  const holdOn = useSettingsStore(s => !!s.holdExternalContent);
  const holdKey = useMemo(() => (holdOn ? holdKeyOf(html, key) : null), [holdOn, html, key]);
  const allowed = useExternalAllowed(s => s.keys.has(holdKey));
  const value = useMemo(() => {
    if (!settingsRead) return undefined;
    return answer && holdOn ? { ...answer, holdKey, holding: !allowed } : answer;
  }, [settingsRead, answer, holdOn, holdKey, allowed]);
  useEffect(() => {
    if (!html) return undefined;
    const known = peekBodyScan(html, { key, blocking, links });
    if (known) {
      setHeld({ id, scan: known });
      return undefined;
    }
    let live = true;
    scanBody(html, { key, blocking, links }).then((scan) => {
      if (live) setHeld({ id, scan });
    });
    return () => { live = false; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  // What this frame draws is what Network Activity counts (once per message).
  useEffect(() => { noteFramed(value, html, { key, blocking }); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return value;
}

/** The trackers last found for a scoped key, or null. */
export function getCachedTrackers(key) {
  if (!key) return null;
  return trackersByKey.get(key) ?? null;
}

/**
 * The flagged links last found for a scoped key, or null. A null key means
 * "not locatable": never a fallback to the uid, that is how one message's
 * links end up listed under another's tooltip.
 */
export function getCachedAlerts(key) {
  if (!key) return null;
  return alertsByKey.get(key) ?? null;
}

/** Every cached flagged link of a set of rows (`state`: the mail store's, to place each row). */
export function getAlertsForEmails(emails, state) {
  if (!emails) return null;
  const all = [];
  for (const e of emails) {
    const cached = getCachedAlerts(emailScopeKey(e, state));
    if (cached) all.push(...cached);
  }
  return all.length > 0 ? all : null;
}

/** The worst link alert a group of rows wears: red > yellow > null. */
export function getLinkAlertLevel(emails) {
  if (!emails || emails.length === 0) return null;
  let max = null;
  for (const e of emails) {
    if (e._linkAlert === 'red') return 'red';
    if (e._linkAlert === 'yellow') max = 'yellow';
  }
  return max;
}

/** A clicked link's alert, as the scan marked it in the frame, or null. */
export function checkLinkAlert(linkElement) {
  const level = linkElement.getAttribute('data-link-alert');
  if (!level) return null;
  return {
    level,
    textContent: linkElement.textContent?.trim() || '',
    actualUrl: linkElement.href,
    reason: linkElement.getAttribute('title') || '',
  };
}

/**
 * One verdict per link (`[{href, text}]`), the social card's list:
 * `[{ level, reason, actualDomain, textDomain }]`. Null when the daemon could
 * not be asked: the caller shows the links unjudged.
 */
export async function classifyLinks(links) {
  if (!links?.length) return [];
  try {
    const out = await send('body.classify_links', { links, texts: bodyTexts() });
    return Array.isArray(out) ? out : null;
  } catch (e) {
    console.warn('[bodyScan] body.classify_links failed:', e?.message || e);
    return null;
  }
}

/** How many endpoint rules the daemon's bundled tracker table holds, or null. */
export async function trackerPatternCount() {
  try {
    const info = await send('body.info', {});
    return Number.isInteger(info?.trackerPatterns) ? info.trackerPatterns : null;
  } catch {
    return null;
  }
}
