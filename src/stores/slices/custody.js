/**
 * Which copy of a message you are looking at — one rule, one file.
 *
 * `'local-only'` is the loudest claim the app makes: the gold row, the
 * cloud-off glyph, "your only copy". It used to be derived from the active
 * mailbox's uid set — `!serverUids.uids.has(uid)` — which asks a MAILBOX
 * question and prints a SERVER verdict. Those are not the same question on any
 * provider: Gmail's archive moves a message out of INBOX into All Mail, a
 * filter moves it to a label, a delete moves it to Bin. Every one of those left
 * a gold "deleted from the server, nothing else has it" row over a message the
 * server still holds. `purgeEverywhere` had already reached this conclusion for
 * the destructive path (see its LOCALLY_CREATED block) — this is the same fix
 * for the display path.
 *
 * So gold now requires evidence, and there are exactly three kinds:
 *
 *   1. the message was created here and never had a server copy — a staged
 *      send or a local draft, recorded in local-index.json as `local_sent` /
 *      `local_draft` (`_origin`), or still in flight as `_localStaged`;
 *   2. this app deleted the server copy — `applyServerRemoval` stamps
 *      `serverDeleted` onto the vault's index entry, so the claim survives a
 *      reload instead of living in a uid set that the next full UID SEARCH
 *      rebuilds from scratch.
 *
 *   3. the server was ASKED and said no — `services/workflows/probeServerCopy`
 *      sweeps every selectable folder for the message's Message-ID and stamps
 *      `serverAbsent` only when all of them answered and none had it. This is
 *      the "someone else deleted your mail" case, and it is the one the gold
 *      colour was written for.
 *
 * Absence from one mailbox is not evidence and never becomes gold. Note what
 * separates (3) from the derivation it replaces: not a different heuristic, an
 * actual answer from the server about every folder, with the incomplete sweep
 * reported as unknown rather than rounded down to absent.
 */

export const LOCALLY_CREATED = new Set(['local_sent', 'local_draft']);

/**
 * Which of the three proofs this message carries — or null, meaning gold is
 * not sayable about it. The three read very differently to a person ("it never
 * existed there" / "you deleted it" / "someone else did"), so the row's tooltip
 * and the viewer's band both need to know which one, not merely that there is
 * one.
 *
 * @returns {'never-on-server'|'we-deleted'|'server-lost-it'|null}
 */
export function custodyProof(email) {
  if (!email) return null;
  if (email._localStaged === true || LOCALLY_CREATED.has(email._origin)) return 'never-on-server';
  if (email.serverDeleted === true) return 'we-deleted';
  if (email.serverAbsent === true) return 'server-lost-it';
  return null;
}

/**
 * @returns {'server'|'local'|'local-only'}
 */
export function custodySource(email) {
  if (!email?.isArchived) return 'server';
  return custodyProof(email) ? 'local-only' : 'local';
}

/**
 * The row the list is showing for this message, so the viewer's custody band
 * and the row's own glyph cannot disagree.
 *
 * The viewer holds a DIFFERENT object from the list: its copy comes from the
 * in-memory cache, the vault `.eml`, or a server fetch, and every vault read
 * stamps `source: 'local'` on the way out. Reading custody off that object
 * rendered "Saved in your vault — also still on the server" over a gold row,
 * twice, with two different fields (`selectedEmailSource`, then
 * `selectedEmail.source`). The fix is not a third field: it is to read the one
 * the list derived.
 */
export function custodyRowFor(email, { sortedEmails = [], localEmails = [] } = {}) {
  if (!email) return null;
  // A uid names a message only inside one (account, mailbox) — the unified list
  // holds rows from several of both at once, and Sent uid 6 is not INBOX uid 6.
  // Compare whichever of the two either side actually carries; a row that omits
  // one is from the active view by construction.
  const sameScope = (a, b) => a == null || b == null || a === b;
  const matches = (e) => e.uid === email.uid
    && sameScope(e._accountId, email._accountId)
    && sameScope(e._mailbox, email._mailbox);
  return sortedEmails.find(matches) || localEmails.find(matches) || null;
}
