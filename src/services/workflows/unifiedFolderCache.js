// ── Unified folder cache — the merged rows of an All Inboxes folder, kept so
// switching back paints at once (five minutes, three folders) ──
//
// One entry per folder: the list `loadUnifiedInbox` committed, and an index
// from message key to its position, built where the entry is stored (a pass the
// load already makes, off the click path). Nothing here is written into a list
// the store may hold: the cache-hit paint puts `emails` into the store by
// reference.

import { emailScopeKey } from '../../stores/slices/unifiedHelpers';
import { registerRows } from '../../stores/messageRows';

const MAX_FOLDERS = 3;
const _entries = new Map(); // folderId -> { emails, index, overlay, timestamp }

/// Store `emails` as `folder`'s entry, evicting the oldest past three.
export function putUnifiedFolder(folder, emails, timestamp = Date.now()) {
  while (_entries.size >= MAX_FOLDERS && !_entries.has(folder)) {
    let oldest = null;
    let oldestTime = Infinity;
    for (const [key, entry] of _entries) {
      if (entry.timestamp < oldestTime) { oldest = key; oldestTime = entry.timestamp; }
    }
    if (oldest === null) break;
    _entries.delete(oldest);
  }
  const index = new Map();
  emails.forEach((row, i) => {
    // Rows of this list are stamped with their account and folder.
    const key = emailScopeKey(row, {});
    if (key !== null && !index.has(key)) index.set(key, i);
  });
  _entries.set(folder, { emails, index, overlay: null, timestamp });
}

/// `{ emails, timestamp }` for the folder, or undefined. A flag written since it
/// was stored is folded into a fresh list here, on the switch that reads it.
export function getUnifiedFolder(folder) {
  const entry = _entries.get(folder);
  if (entry?.overlay) {
    const emails = entry.emails.slice();
    for (const [i, row] of entry.overlay) emails[i] = row;
    entry.emails = emails;
    entry.overlay = null;
  }
  return entry;
}

export function clearUnifiedFolders() {
  _entries.clear();
}

// A write to a message lands on its row in every folder's entry, by key: the
// index finds the position, the changed row waits in `overlay` and is folded in
// when the entry is read. No list is scanned or copied on the click.
registerRows({
  name: 'unifiedFolderCache',
  invalidate: (ctx) => {
    for (const entry of _entries.values()) {
      for (const key of ctx.keys) {
        const i = entry.index.get(key);
        if (i === undefined) continue;
        const row = entry.overlay?.get(i) ?? entry.emails[i];
        const next = ctx.mapRow(row, key);
        if (next !== row) (entry.overlay ??= new Map()).set(i, next);
      }
    }
  },
});
