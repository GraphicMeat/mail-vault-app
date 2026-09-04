// ── mailboxTree — folder-list shape checks, recovery helpers, and the
// render-time tree.
// Pure, so the rules that decide "is this folder list real or a placeholder?"
// are testable without the activateAccount dependency graph.
//
// The STORED list stays flat — isMailboxTreeComplete treats a nested one as a
// pre-flattening cache to evict, and backup, vault-dir mapping and the unified
// inbox all walk it flat. buildMailboxTree derives the hierarchy at render
// time from `path` + `delimiter`, which every mailbox already carries.
import { compareNames } from '../../utils/collation.js';

/** What the store shows before a folder list has ever been fetched. */
export const INBOX_PLACEHOLDER = [{ name: 'INBOX', path: 'INBOX', specialUse: null, children: [] }];

export function countMailboxes(mailboxes = []) {
  let count = 0;
  const visit = (nodes) => {
    for (const node of nodes || []) {
      count += 1;
      if (node.children?.length) visit(node.children);
    }
  };
  visit(mailboxes);
  return count;
}

/**
 * A list worth trusting: non-empty, flat (the old nested format forces a
 * refresh), and more than a lone INBOX — which is what the placeholder is.
 */
export function isMailboxTreeComplete(mailboxes = []) {
  const total = countMailboxes(mailboxes);
  if (total === 0) return false;
  if (mailboxes.some(m => m.children?.length > 0)) return false;
  if (total > 1) return true;
  const only = mailboxes[0];
  return !!only && only.path !== 'INBOX';
}

/**
 * Best of several folder lists, in preference order.
 *
 * A restore descriptor snapshots whatever the store held, so it can carry the
 * INBOX placeholder from a session whose first fetch failed. Trusting it over a
 * cache that has since been filled is what left accounts showing one folder for
 * the rest of the session.
 */
export function pickMailboxList(...candidates) {
  for (const c of candidates) if (isMailboxTreeComplete(c)) return c;
  for (const c of candidates) if (c?.length) return c;
  return INBOX_PLACEHOLDER;
}

/**
 * Run `fetchFn`, and on failure run it once more.
 *
 * The first folder fetch of a session races credential loading and fails with
 * "Password missing"; the IMAP pool recovers within milliseconds but nothing
 * re-ran the fetch. Returns null instead of retrying if the activation was
 * aborted while we waited.
 */
export async function retryOnce(fetchFn, { delayMs = 1500, isAborted = () => false } = {}) {
  try {
    return await fetchFn();
  } catch (error) {
    if (isAborted()) return null;
    await new Promise(resolve => setTimeout(resolve, delayMs));
    if (isAborted()) return null;
    return await fetchFn();
  }
}

// Folders a reader expects at the top level whatever the server calls their
// parent. Gmail hides Sent inside [Gmail]; burying it one collapsed click deep
// is not an improvement on the flat list.
const HOISTED = new Set(['\\Sent', '\\Drafts', '\\Trash', '\\Junk', '\\Archive']);

// Placement keys are joined on NUL so a folder named with the delimiter cannot
// forge one.
const SEP = '\u0000';

const splitPath = (m) => (m.delimiter ? String(m.path).split(m.delimiter) : [String(m.path)]);

// "INBOX is case-insensitive" — RFC 3501 5.1. Servers LIST it as INBOX, Inbox
// and inbox, and all three name the same mailbox.
const isInbox = (name) => String(name).toUpperCase() === 'INBOX';

// A Dovecot-style namespace: every mailbox filed under INBOX, so INBOX is a
// sibling of the reader's folders rather than their parent. bson73's server
// (discussion #1) prefixes all 59 paths — INBOX.Sent, INBOX.Kunden…
// All-or-nothing on purpose: this decides where rows are DRAWN, and lifting a
// prefix that only some folders share would strand the rest.
const isInboxPrefixed = (flat) => flat.length > 0 && flat.every(m => isInbox(splitPath(m)[0]));

function sortLevel(nodes) {
  nodes.sort((a, b) => {
    if (a.path === 'INBOX') return -1;
    if (b.path === 'INBOX') return 1;
    return compareNames(a.name, b.name);
  });
  for (const n of nodes) sortLevel(n.children);
}

/**
 * Flat mailbox list → the tree the sidebar draws. Never mutates the input.
 *
 * Each node is the mailbox plus `depth` and real `children`. `path` stays the
 * server's own, because it is simultaneously the SELECT argument and the
 * on-disk vault directory name — only where a row is *drawn* changes here.
 */
export function buildMailboxTree(mailboxes) {
  const flat = mailboxes || [];
  if (!flat.length) return [];

  // Dovecot-style servers put every mailbox under INBOX. Drawing the reader's
  // own folders one click inside a collapsed INBOX is what made those accounts
  // look like they had a single mailbox. Lift the prefix — but only when it is
  // genuinely the namespace, i.e. nothing at all lives outside it.
  const prefixed = isInboxPrefixed(flat);

  const roots = [];
  const byKey = new Map();

  const placementOf = (m) => {
    const parts = splitPath(m);
    if (HOISTED.has(m.specialUse)) return [parts[parts.length - 1]];
    if (prefixed && parts.length > 1) return parts.slice(1);
    return parts;
  };

  const put = (key, node, parentKey) => {
    byKey.set(key, node);
    if (parentKey === null) roots.push(node);
    else byKey.get(parentKey).children.push(node);
  };

  for (const m of flat) {
    const place = placementOf(m);
    const parts = splitPath(m);
    const delim = m.delimiter || '.';

    // Draw every ancestor first. A server can LIST a leaf whose parents it
    // never mentions, and an undrawn parent is an unreachable subtree.
    for (let d = 0; d < place.length - 1; d++) {
      const key = place.slice(0, d + 1).join(SEP);
      if (byKey.has(key)) continue;
      put(key, {
        name: place[d],
        path: parts.slice(0, parts.length - (place.length - 1 - d)).join(delim),
        specialUse: null,
        delimiter: m.delimiter,
        noselect: true,
        synthetic: true,
        depth: d,
        children: [],
      }, d === 0 ? null : place.slice(0, d).join(SEP));
    }

    const key = place.join(SEP);
    const existing = byKey.get(key);
    if (existing) {
      // The server got round to listing a folder already drawn as a stand-in.
      if (existing.synthetic) {
        Object.assign(existing, m, {
          depth: existing.depth,
          children: existing.children,
          synthetic: false,
        });
      }
      continue;
    }
    put(key, { ...m, depth: place.length - 1, children: [] },
      place.length > 1 ? place.slice(0, place.length - 1).join(SEP) : null);
  }

  sortLevel(roots);
  return roots;
}

/** A folder filter naming a branch — `sub:Kunden` — rather than one folder. */
export const SUBTREE_PREFIX = 'sub:';

/**
 * `path` and every mailbox filed beneath it, in list order.
 *
 * Matches on the delimiter boundary, not the bare prefix — otherwise asking for
 * Technik also answers with Technik-Alt.
 */
export function mailboxDescendants(path, mailboxes = []) {
  if (!path) return [];
  const flat = mailboxes || [];
  // INBOX is never a branch root. Apple Mail, the reference, does not recurse
  // it either: it is the folder you file OUT of, not a container. On bson73's
  // INBOX-prefixed server (discussion #1) the raw prefix answered "INBOX" with
  // the entire account — 26 000 messages instead of the 25 filed in it — and
  // gating this on the namespace being INBOX-prefixed throughout only moved
  // the bug: one folder outside it (a Public namespace, a stray Archive) and
  // the fan-out was back.
  if (isInbox(path)) return [path];
  const delim = flat.find(m => m.path === path)?.delimiter
    || flat.find(m => m.delimiter)?.delimiter
    || '.';
  const prefix = path + delim;
  const out = [path];
  for (const m of flat) {
    if (m.path !== path && String(m.path).startsWith(prefix)) out.push(m.path);
  }
  return out;
}

/**
 * Every folder that has to be open for `path` to be on screen, outermost first.
 *
 * Walks the built tree rather than splitting the path, because the tree is the
 * only thing that knows whether the INBOX prefix was lifted — on a Dovecot
 * server INBOX is not an ancestor of anything, it is a sibling.
 */
export function mailboxAncestors(path, tree) {
  if (!path) return [];
  const trail = [];
  const walk = (nodes, above) => {
    for (const n of nodes || []) {
      if (n.path === path) { trail.push(...above); return true; }
      if (walk(n.children, [...above, n.path])) return true;
    }
    return false;
  };
  walk(tree, []);
  return trail;
}
