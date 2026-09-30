// ── The search index's stored snippet, for a message with no body here yet ──
//
// A message kept off this computer (On Demand, or evicted by Keep Recent /
// Index Only) opens on this text while its body downloads. The row's own
// preview first; the rest in one header-cache read (`load_email_cache_by_uids`
// stamps the index's `previewText` on each row it returns).

import * as db from './db';

/**
 * Map of uid -> snippet for the `rows` of one (account, mailbox) that have
 * one. Never throws: a message with no snippet is simply missing from the map.
 */
export async function readIndexSnippets(accountId, mailbox, rows) {
  const snippets = new Map();
  const wanted = new Map();
  for (const row of rows || []) {
    if (row?.uid == null) continue;
    const own = row.previewText || row.snippet;
    if (own) snippets.set(row.uid, own);
    else wanted.set(String(row.uid), row.uid);
  }
  if (!wanted.size) return snippets;
  try {
    const found = await db.getEmailHeadersByUids(accountId, mailbox, [...wanted.values()]);
    for (const row of found || []) {
      const uid = wanted.get(String(row?.uid));
      if (uid !== undefined && row.previewText) snippets.set(uid, row.previewText);
    }
  } catch { /* no snippet: the caller keeps its spinner */ }
  return snippets;
}

/** The rows a list's first disk read (`getEmailHeadersPartial`) stamps a preview on. */
export const PREVIEW_WINDOW = 500;

/**
 * `rows` with the index's preview stamped on those that have none, for the
 * first window only: the header memo hands a folder back as it was left, before
 * the index read any body that arrived since, and a disk read would have
 * stamped it. Returns `rows` itself when nothing changes; never mutates.
 */
export async function stampIndexPreviews(accountId, mailbox, rows) {
  const snippets = await readIndexSnippets(accountId, mailbox, rows.slice(0, PREVIEW_WINDOW));
  let changed = false;
  const stamped = rows.map((row) => {
    if (row?.uid == null || row.previewText || row.snippet || !snippets.has(row.uid)) return row;
    changed = true;
    return { ...row, previewText: snippets.get(row.uid) };
  });
  return changed ? stamped : rows;
}
