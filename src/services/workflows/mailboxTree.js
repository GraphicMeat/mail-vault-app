// ── mailboxTree — folder-list shape checks and recovery helpers ──
// Pure, so the rules that decide "is this folder list real or a placeholder?"
// are testable without the activateAccount dependency graph.

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
