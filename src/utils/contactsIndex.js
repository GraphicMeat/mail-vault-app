// ── contactsIndex — derive top contacts from loaded emails ──
//
// Builds a ranked address book from the user's cached inbox + sent headers
// across every account. Each address gets a lastSeen date, an occurrence
// count, and the set of accountIds that sourced it, so the compose contacts
// popover can filter by account and the autocomplete can boost matches that
// belong to the currently-active account.

import { findSentMailboxPath } from './sentFolder';
import { daemonCall } from '../services/daemonClient';

let _cache = null;
let _fingerprint = '';
let _daemonUnavailable = false;

// Module-level cache of disk-hydrated header arrays, keyed by accountId.
// Each entry is `{ folders: [{ path, emails }] }`.
const _hydrated = new Map();
let _hydrationPromise = null;
let _hydrationKey = '';
const _subscribers = new Set();

function _notify() {
  for (const fn of _subscribers) fn();
}

export function subscribeContactsIndex(fn) {
  _subscribers.add(fn);
  return () => _subscribers.delete(fn);
}

// System folders to exclude from contact-sender harvesting. Name heuristics
// catch servers that don't advertise SPECIAL-USE (Hostinger, Fastmail, etc.).
const EXCLUDE_SPECIAL_USE = new Set([
  '\\Trash', '\\Junk', '\\Drafts', '\\Archive',
  '\\All', '\\Flagged', '\\Important', '\\Noselect',
]);
const EXCLUDE_NAME_RE = /^(trash|deleted items?|junk|junk ?e?-?mail|spam|drafts?|archive|all ?mail|outbox|templates?)$/i;
const GMAIL_SYSTEM_PREFIX_RE = /^\[gmail\]\/(trash|spam|drafts|important|starred|all mail)$/i;
const MAX_FOLDERS_PER_ACCOUNT = 12;

function _flattenMailboxes(mailboxes, out = []) {
  for (const box of mailboxes || []) {
    if (box?.path) out.push(box);
    if (box?.children?.length) _flattenMailboxes(box.children, out);
  }
  return out;
}

// Walk the cached mailbox tree and return the ordered list of paths to
// harvest senders from: INBOX + Sent + untagged user folders, minus system
// folders. Capped at MAX_FOLDERS_PER_ACCOUNT to bound disk reads.
export function _collectContactFolderPaths(mailboxes) {
  const flat = _flattenMailboxes(mailboxes);
  const seen = new Set();
  const paths = [];
  const add = (path) => {
    if (!path) return;
    const key = path.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    paths.push(path);
  };

  // Prioritize INBOX and Sent so they always make the cap.
  for (const box of flat) {
    if (box.specialUse === '\\Inbox' || /^inbox$/i.test(box.name || '') || /^inbox$/i.test(box.path || '')) {
      add(box.path);
    }
  }
  const sentPath = findSentMailboxPath(mailboxes);
  if (sentPath) add(sentPath);

  // Then remaining user folders.
  for (const box of flat) {
    if (paths.length >= MAX_FOLDERS_PER_ACCOUNT) break;
    const specialUse = box.specialUse || null;
    if (specialUse && EXCLUDE_SPECIAL_USE.has(specialUse)) continue;
    const name = (box.name || '').trim();
    const path = box.path || '';
    if (EXCLUDE_NAME_RE.test(name)) continue;
    if (GMAIL_SYSTEM_PREFIX_RE.test(path)) continue;
    if (Array.isArray(box.flags) && box.flags.includes('\\Noselect')) continue;
    add(path);
  }

  return paths.slice(0, MAX_FOLDERS_PER_ACCOUNT);
}

// Convert a daemon ContactEntry list into the `{ folders: [{path, emails}] }`
// shape used by `getHydratedAccountSources`. We synthesize one "folder" per
// entry's folder tag so account attribution and per-folder counts still round-trip.
function _hydrateFromDaemonEntries(accountId, entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    _hydrated.set(accountId, { folders: [] });
    return;
  }
  // Collapse all entries into a single synthetic "folder" source — the
  // downstream `buildContactsIndex` only needs `email.from/to/cc/bcc/date`, so
  // we emit minimal pseudo-emails, one per contact, using lastSeen as date.
  const emails = entries.map(e => ({
    uid: e.address,
    from: { address: e.address, name: e.name || '' },
    to: [], cc: [], bcc: [],
    date: e.lastSeen ? new Date(e.lastSeen).toISOString() : null,
  }));
  // Duplicate per count so `popular` ranking reflects daemon-observed counts.
  // Cheap: entries are small objects, and we slice to top by count first.
  const expanded = [];
  for (const e of entries) {
    const base = {
      uid: e.address,
      from: { address: e.address, name: e.name || '' },
      to: [], cc: [], bcc: [],
      date: e.lastSeen ? new Date(e.lastSeen).toISOString() : null,
    };
    const reps = Math.max(1, Math.min(e.count || 1, 50));
    for (let i = 0; i < reps; i++) expanded.push(base);
  }
  _hydrated.set(accountId, { folders: [{ path: '_daemon', emails: expanded }] });
  // `emails` reference kept for future single-source path if needed.
  void emails;
}

async function _hydrateFromDaemon(accountIds) {
  if (_daemonUnavailable) return false;
  try {
    const snapshot = await daemonCall('contacts_index.get', { accountIds });
    if (!snapshot || typeof snapshot !== 'object') return false;
    for (const id of accountIds) {
      _hydrateFromDaemonEntries(id, snapshot[id] || []);
    }
    return true;
  } catch (err) {
    // Daemon offline, method not registered, or transport error — fall back
    // and don't retry this session to avoid per-compose churn.
    console.warn('[contactsIndex] daemon call failed, using disk fallback:', err?.message || err);
    _daemonUnavailable = true;
    return false;
  }
}

async function _hydrateOneFromDisk(db, account) {
  const accountId = account.id;
  try {
    const mailboxes = await db.getCachedMailboxes(accountId).catch(() => null);
    let paths = _collectContactFolderPaths(mailboxes);
    if (paths.length === 0) paths = ['INBOX'];
    const results = await Promise.all(
      paths.map(p => db.getEmailHeadersPartial(accountId, p, 300).catch(() => null))
    );
    const folders = results
      .map((r, i) => (r?.emails?.length ? { path: paths[i], emails: r.emails } : null))
      .filter(Boolean);
    _hydrated.set(accountId, { folders });
  } catch {
    _hydrated.set(accountId, { folders: [] });
  }
}

// Load cached sender addresses for every account. Prefers the daemon-owned
// contacts index; falls back to walking disk header caches if the daemon is
// unavailable. De-duped by account-id set.
export async function hydrateContactsIndex(accounts) {
  const key = (accounts || []).map(a => a.id).sort().join(',');
  if (!key) return;
  if (_hydrationKey === key && _hydrationPromise) return _hydrationPromise;
  _hydrationKey = key;
  const accountIds = accounts.map(a => a.id);
  _hydrationPromise = (async () => {
    const daemonOk = await _hydrateFromDaemon(accountIds);
    if (!daemonOk) {
      const db = await import('../services/db');
      await Promise.all(accounts.map(a => _hydrateOneFromDisk(db, a)));
    }
    _notify();
  })();
  return _hydrationPromise;
}

// Reset cached hydration so the next `hydrateContactsIndex(accounts)` call
// re-reads from disk. Call after a mailbox-tree refresh reveals new folders.
export function rehydrateContactsIndex() {
  _hydrated.clear();
  _hydrationKey = '';
  _hydrationPromise = null;
  _cache = null;
  _fingerprint = '';
}

// Returns per-account hydrated sources: `[{ accountId, emails }, ...]` — one
// entry per hydrated folder, so account attribution is preserved for each
// contact entry.
export function getHydratedAccountSources() {
  const out = [];
  for (const [accountId, { folders }] of _hydrated.entries()) {
    if (!folders) continue;
    for (const f of folders) {
      if (f.emails?.length) out.push({ accountId, emails: f.emails });
    }
  }
  return out;
}

function _addAddress(map, addr, dateMs, accountId, ownAddresses) {
  if (!addr) return;
  const address = (addr.address || addr.email || '').toLowerCase().trim();
  if (!address || !address.includes('@')) return;
  if (ownAddresses.has(address)) return;
  const name = (addr.name || '').trim();
  let entry = map.get(address);
  if (!entry) {
    entry = { address, name, count: 0, lastSeen: 0, accountIds: new Set() };
    map.set(address, entry);
  }
  entry.count += 1;
  if (dateMs && dateMs > entry.lastSeen) entry.lastSeen = dateMs;
  // Prefer a real display name over an empty one; keep the most recent non-empty.
  if (name && (!entry.name || dateMs > entry.lastSeen - 1)) entry.name = name;
  if (accountId) entry.accountIds.add(accountId);
}

function _parseDate(email) {
  const d = email.date || email.internalDate || email.receivedAt;
  if (!d) return 0;
  if (typeof d === 'number') return d;
  const t = Date.parse(d);
  return isNaN(t) ? 0 : t;
}

function _collectAddresses(email, map, accountId, ownAddresses) {
  const dateMs = _parseDate(email);
  _addAddress(map, email.from, dateMs, accountId, ownAddresses);
  const lists = [email.to, email.cc, email.bcc, email.replyTo];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const a of list) _addAddress(map, a, dateMs, accountId, ownAddresses);
  }
}

// accountSources: `[{ accountId, emails }, ...]` — per-account scoped sources
//   so each contact retains the set of accounts it appeared in.
// extraSources: `[{ accountId, emails }, ...]` — ephemeral (active mailbox)
//   emails that aren't yet in the per-account hydration (live Zustand state).
// accounts: full accounts list; their own addresses are filtered out.
export function buildContactsIndex(accountSources, accounts = []) {
  const fp = accountSources
    .map(s => `${s.accountId || '*'}:${s.emails.length}:${s.emails[0]?.uid || 0}:${s.emails[s.emails.length - 1]?.uid || 0}`)
    .join('|')
    + '#' + accounts.map(a => a.email).join(',');
  if (fp === _fingerprint && _cache) return _cache;

  const ownAddresses = new Set(accounts.map(a => (a.email || '').toLowerCase()).filter(Boolean));
  const map = new Map();
  for (const src of accountSources) {
    if (!Array.isArray(src?.emails)) continue;
    for (const e of src.emails) _collectAddresses(e, map, src.accountId, ownAddresses);
  }

  const all = Array.from(map.values());
  const latest = [...all].sort((a, b) => b.lastSeen - a.lastSeen);
  const popular = [...all].sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen);

  _cache = { latest, popular, all };
  _fingerprint = fp;
  return _cache;
}

// Returns `{ latest, popular }` filtered to a specific account (null = all).
// Slices to 50 after filtering so each account gets its own top-N list.
export function getContactsForAccount(index, accountId) {
  if (!index) return { latest: [], popular: [] };
  if (!accountId) {
    return {
      latest: index.latest.slice(0, 50),
      popular: index.popular.slice(0, 50),
    };
  }
  const match = (c) => c.accountIds && c.accountIds.has(accountId);
  return {
    latest: index.latest.filter(match).slice(0, 50),
    popular: index.popular.filter(match).slice(0, 50),
  };
}

// Prefix search across the full contact list. When `activeAccountId` is
// provided, contacts belonging to that account rank above contacts that don't
// — within each tier, order is preserved (which is already lastSeen-first
// since `index.all` is built from the lastSeen-sorted list).
export function searchContacts(index, query, limit = 8, activeAccountId = null) {
  if (!query || !index) return [];
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const boosted = [];
  const others = [];
  for (const c of index.all) {
    if (c.address.startsWith(q) || (c.name && c.name.toLowerCase().includes(q))) {
      if (activeAccountId && c.accountIds && c.accountIds.has(activeAccountId)) {
        boosted.push(c);
      } else {
        others.push(c);
      }
      if (boosted.length + others.length >= limit * 3) break;
    }
  }
  // Within each tier the order mirrors `index.all`, which we want to sort by
  // lastSeen descending so recent contacts float up.
  boosted.sort((a, b) => b.lastSeen - a.lastSeen);
  others.sort((a, b) => b.lastSeen - a.lastSeen);
  return [...boosted, ...others].slice(0, limit);
}

export function formatContact(c) {
  return c.name ? `${c.name} <${c.address}>` : c.address;
}
