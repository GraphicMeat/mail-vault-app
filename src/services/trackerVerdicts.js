import * as db from './db';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';
import { emailScopeKey, bodyMatchesHeader, resolveEmailLocation } from '../stores/slices/unifiedHelpers';
import { scanTrackers, summarizeTrackers } from '../utils/trackerDetect';

/**
 * The one place a tracker verdict is written down.
 *
 * Four surfaces render a body and scan it (reading pane, thread, chat, full
 * view) but only the reading pane used to persist what it found, so a message
 * read in the thread left its row bare. The scan is cheap and cached; the
 * writing is what has to happen in exactly one place, or the row's glyph means
 * "you opened this in the right view" instead of "this message tracks you".
 */
export function recordTrackerVerdict(scopeKey, trackers) {
  recordTrackerSummary(scopeKey, summarizeTrackers(trackers));
}

// Same writer, for a caller that already summarised.
export function recordTrackerSummary(scopeKey, summary) {
  if (!scopeKey || !summary) return;
  applyVerdicts({ [scopeKey]: summary });
}

// One setState for a batch: `emails` runs to five figures in a big mailbox and
// the map rebuilds it, so a per-message patch inside a scroll would rebuild it
// forty times.
function applyVerdicts(verdicts) {
  const keys = Object.keys(verdicts);
  if (keys.length === 0) return;

  useMailStore.setState(state => {
    const patch = e => {
      if (e._trackerInfo) return e;
      const info = verdicts[emailScopeKey(e, state)];
      return info ? { ...e, _trackerInfo: info } : e;
    };
    const selectedKey = state.selectedEmail && emailScopeKey(state.selectedEmail, state);
    return {
      emails: state.emails.map(patch),
      sortedEmails: state.sortedEmails.map(patch),
      ...(selectedKey && verdicts[selectedKey]
        ? { selectedEmail: { ...state.selectedEmail, _trackerInfo: verdicts[selectedKey] } }
        : {}),
    };
  });

  const { setTrackerAlert } = useSettingsStore.getState();
  for (const key of keys) setTrackerAlert(key, verdicts[key]);
}

// Asked-and-answered, including the clean answers: a mailbox is mostly clean,
// and without this every scroll would re-read the same bodies to learn nothing.
// Session-scoped on purpose — the verdicts that matter are persisted.
const _asked = new Set();

export function _resetTrackerBackfill() { _asked.clear(); }

/**
 * Fill in verdicts for rows nobody has opened, from bodies already in the
 * vault. Local reads only: a list that reached for the network to decide
 * whether to show a privacy warning would be its own privacy problem, and a
 * scroll would become a fetch storm.
 */
export async function backfillTrackerVerdicts(headers, { limit = 40 } = {}) {
  if (!headers || headers.length === 0) return;

  const state = useMailStore.getState();
  const verdicts = {};
  let budget = limit;

  for (const header of headers) {
    if (budget <= 0) break;
    if (!header || header._trackerInfo) continue;

    const key = emailScopeKey(header, state);
    if (!key || _asked.has(key)) continue;
    if (useSettingsStore.getState().trackerAlerts[key]) continue;

    // The row may be a unified-inbox entry carrying no mailbox of its own, so
    // ask the same resolver the reading pane asks rather than trusting the
    // fields on the header.
    const loc = resolveEmailLocation(header, state);
    if (!loc) continue;

    _asked.add(key);
    budget -= 1;

    // A prefetched body is already in memory and costs nothing to read. Read
    // the Map directly, NOT through `getFromCache` — that promotes the entry
    // out of `prefetchOnly` and would exempt it from the eviction pass, so a
    // scroll past a row would pin its body in the cache for good.
    let local = state.emailCache?.get(key)?.email || null;
    if (!local) {
      try {
        local = await db.getLocalEmailLight(loc.accountId, loc.mailbox, header.uid);
      } catch { local = null; }
    }

    // Same guard the reading pane uses: the vault is keyed (account, mailbox,
    // uid) with no generation proof, so a uid reissued under a newer
    // UIDVALIDITY can hand back a different message's body.
    if (!local || !local.html || !bodyMatchesHeader(header, local)) continue;

    const summary = summarizeTrackers(scanTrackers(local.html, key).trackers);
    if (summary) verdicts[key] = summary;
  }

  applyVerdicts(verdicts);
}
