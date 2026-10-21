import { send } from './transport';
import { scanBody } from './bodyScan';
import { useSettingsStore } from '../stores/settingsStore';
import { patchEverywhere } from '../stores/messageRows';
import { emailScopeKey, bodyMatchesHeader, resolveEmailLocation } from '../stores/slices/unifiedHelpers';

/**
 * The safety verdicts a list row wears, decided by the daemon
 * (`body.verdicts`, src-core/src/body_scan): the persisted link and tracker
 * verdicts (read from the settings document, by `accountId-mailbox-uid`), an
 * impersonating display name and a Reply-To that leads elsewhere (when link
 * safety is on). One pass for every list that shows rows, the folder list and
 * a search's results alike.
 *
 * The list never waits for it. `annotateRowAlerts` paints what is already
 * known onto the rows it is given and queues the rest; one call answers the
 * batch, and its verdicts reach the rows through `patchEverywhere`. An answer
 * is kept per row (key and sender fields) until a verdict under that key or
 * the link-safety toggle changes. A row's own verdict is never replaced.
 *
 * The app's settings store stays the writer of the persisted verdicts
 * (`recordTrackerSummary`, `recordLinkAlert`): it writes that store whole
 * through the daemon's settings API, so a second writer of the same key
 * would lose to it.
 */

// Answers by scoped key, then by the row's sender fields: forgetting a key is
// one delete. Capped: the oldest keys go first and are simply asked again.
const answers = new Map();
const KEPT_KEYS = 20000;
const queued = new Map();
// What this window recorded, until the settings document it is written to
// (half a second later) is what the daemon reads.
const recorded = new Map();
let flushing = null;
const BATCH = 2000;

export function _resetRowVerdicts() {
  answers.clear();
  queued.clear();
  recorded.clear();
  flushing = null;
  asked.clear();
}

const addressOf = (a) => (a && typeof a === 'object' ? { name: typeof a.name === 'string' ? a.name : null, address: typeof a.address === 'string' ? a.address : null } : null);
const replyToOf = (r) => (Array.isArray(r) ? r.slice(0, 1).map(addressOf) : typeof r === 'string' ? r : addressOf(r));

/** What the daemon reads of a row. */
function fields(row, key) {
  return { key, from: addressOf(row.from), replyTo: replyToOf(row.replyTo) };
}

const answerId = (f) => JSON.stringify([f.key, f.from, f.replyTo]);
const keyOf = (f) => f.key || '';

function answerFor(f, id) {
  return answers.get(keyOf(f))?.get(id);
}

function keepAnswer(f, id, verdict) {
  const k = keyOf(f);
  let byRow = answers.get(k);
  if (!byRow) {
    byRow = new Map();
    answers.set(k, byRow);
    if (answers.size > KEPT_KEYS) answers.delete(answers.keys().next().value);
  }
  byRow.set(id, verdict);
}

function apply(row, found) {
  if (found._linkAlert && !row._linkAlert) row._linkAlert = found._linkAlert;
  if (found._trackerInfo && !row._trackerInfo) row._trackerInfo = found._trackerInfo;
  if (found._senderAlert && row._senderAlert === undefined) row._senderAlert = found._senderAlert;
  if (found._replyToMismatch && row._replyToMismatch === undefined) row._replyToMismatch = found._replyToMismatch;
}

function flushSoon() {
  if (flushing) return;
  flushing = Promise.resolve().then(flush);
}

async function flush() {
  try {
    await drain();
  } catch (e) {
    console.warn('[rowVerdicts] painting the verdicts failed:', e?.message || e);
  } finally {
    flushing = null;
  }
}

async function drain() {
  while (queued.size) {
    const batch = [...queued.entries()].slice(0, BATCH);
    for (const [id] of batch) queued.delete(id);
    let reply;
    try {
      // The toggle as this window holds it: the settings document can be half a second behind.
      reply = await send('body.verdicts', { rows: batch.map(([id, f]) => ({ id, ...f })), linkSafetyEnabled: !!useSettingsStore.getState().linkSafetyEnabled });
    } catch (e) {
      // Not kept: the next derivation asks again.
      console.warn('[rowVerdicts] body.verdicts failed:', e?.message || e);
      break;
    }
    const found = reply?.rows || {};
    const byKey = {};
    for (const [id, f] of batch) {
      const verdict = found[id] || {};
      keepAnswer(f, id, verdict);
      if (f.key && Object.keys(verdict).length) byKey[f.key] = verdict;
    }
    const keys = Object.keys(byKey);
    if (keys.length) {
      patchEverywhere(keys, (row, key) => {
        const next = { ...row };
        apply(next, byKey[key]);
        return Object.keys(next).some(k => next[k] !== row[k]) ? next : row;
      });
    }
  }
}

/**
 * Paint the verdicts already known onto `rows` (freshly derived by the
 * caller, so written in place) and ask for the others. `mailState` places
 * each row (`emailScopeKey`).
 */
export function annotateRowAlerts(rows, mailState) {
  for (const row of rows) {
    if (!row) continue;
    const f = fields(row, emailScopeKey(row, mailState));
    if (f.key && recorded.has(f.key)) apply(row, recorded.get(f.key));
    const id = answerId(f);
    const known = answerFor(f, id);
    if (known) apply(row, known);
    else queued.set(id, f);
  }
  if (queued.size) flushSoon();
  return rows;
}

// A verdict changed under a key: every answer for that key is stale.
function forgetKeys(keys) {
  for (const key of keys) answers.delete(key);
}

function changedKeys(before = {}, after = {}) {
  const out = new Set();
  for (const k of Object.keys(after)) if (before[k] !== after[k]) out.add(k);
  for (const k of Object.keys(before)) if (!(k in after)) out.add(k);
  return out;
}

// (`subscribe` is absent only from tests that stub the store with `getState`.)
useSettingsStore.subscribe?.((state, prev) => {
  if (!prev) return;
  if (state.linkSafetyEnabled !== prev.linkSafetyEnabled) {
    answers.clear();
    return;
  }
  if (state.linkAlerts !== prev.linkAlerts) forgetKeys(changedKeys(prev.linkAlerts, state.linkAlerts));
  if (state.trackerAlerts !== prev.trackerAlerts) forgetKeys(changedKeys(prev.trackerAlerts, state.trackerAlerts));
});

// ── recording ───────────────────────────────────────────────────────────────

/**
 * The one place a tracker verdict is written down: onto every row that IS
 * this message and into settings, so the glyph survives a restart without
 * re-reading the body. Four surfaces render a body (reading pane, thread,
 * chat, full view); whichever one a message was read in, its row says so.
 */
export function recordTrackerSummary(scopeKey, summary) {
  if (!scopeKey || !summary) return;
  applyTrackerVerdicts({ [scopeKey]: summary });
}

// One patch for a batch, through the registry: `emails` runs to five figures
// and a per-message patch inside a scroll would rebuild it forty times.
function applyTrackerVerdicts(verdicts) {
  const keys = Object.keys(verdicts);
  if (keys.length === 0) return;
  for (const key of keys) recorded.set(key, { ...recorded.get(key), _trackerInfo: verdicts[key] });
  patchEverywhere(keys, (row, key) => (row._trackerInfo === verdicts[key] ? row : { ...row, _trackerInfo: verdicts[key] }));
  const { setTrackerAlert } = useSettingsStore.getState();
  for (const key of keys) setTrackerAlert(key, verdicts[key]);
}

/** A link verdict found in a body: onto every row that IS this message, and into settings. */
export function recordLinkAlert(scopeKey, level) {
  if (!scopeKey || !level) return;
  recorded.set(scopeKey, { ...recorded.get(scopeKey), _linkAlert: level });
  patchEverywhere([scopeKey], row => (row._linkAlert === level ? row : { ...row, _linkAlert: level }));
  useSettingsStore.getState().setLinkAlert(scopeKey, level);
}

// ── backfill ────────────────────────────────────────────────────────────────

// Asked-and-answered, including the clean answers: a mailbox is mostly clean,
// and without this every scroll would re-read the same bodies to learn nothing.
// Session-scoped on purpose: the verdicts that matter are persisted.
const asked = new Set();

/**
 * Fill in tracker verdicts for rows nobody has opened, from bodies already on
 * this machine: a prefetched body in memory, else the vault's copy (the daemon
 * reads it, proven by its Message-ID). Never the network: a list that fetched
 * to decide whether to warn about privacy would be its own privacy problem.
 * `mailState` is the mail store's state.
 */
export async function backfillTrackerVerdicts(headers, mailState, { limit = 40 } = {}) {
  if (!headers || headers.length === 0 || !mailState) return;
  const fromMemory = [];
  const fromVault = [];
  let budget = limit;
  for (const header of headers) {
    if (budget <= 0) break;
    if (!header || header._trackerInfo) continue;
    const key = emailScopeKey(header, mailState);
    if (!key || asked.has(key)) continue;
    if (useSettingsStore.getState().trackerAlerts?.[key]) continue;
    // A unified-inbox row may carry no mailbox of its own: ask the resolver
    // the reading pane asks.
    const loc = resolveEmailLocation(header, mailState);
    if (!loc) continue;
    asked.add(key);
    budget -= 1;
    // Read the Map directly, NOT through `getFromCache`: that promotes the
    // entry out of `prefetchOnly` and would pin a scrolled-past body for good.
    const local = mailState.emailCache?.get(key)?.email || null;
    if (local) {
      // Same guard the reading pane uses: a uid reissued under a newer
      // UIDVALIDITY can hand back a different message's body.
      if (local.html && bodyMatchesHeader(header, local)) fromMemory.push({ key, html: local.html });
      continue;
    }
    fromVault.push({ key, accountId: loc.accountId, mailbox: loc.mailbox, uid: Number(header.uid), messageId: header.messageId || header.message_id || null });
  }

  const verdicts = {};
  await Promise.all(fromMemory.map(async ({ key, html }) => {
    const scan = await scanBody(html, { key });
    if (scan.summary) verdicts[key] = scan.summary;
  }));
  if (fromVault.length) {
    try {
      const reply = await send('body.verdicts', { backfill: fromVault, limit: fromVault.length });
      Object.assign(verdicts, reply?.trackers || {});
    } catch (e) {
      console.warn('[rowVerdicts] backfill failed:', e?.message || e);
      for (const { key } of fromVault) asked.delete(key);
    }
  }
  applyTrackerVerdicts(verdicts);
}
