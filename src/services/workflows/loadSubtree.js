// ── loadSubtree workflow — a folder and everything filed under it ──
//
// There is no server primitive for "everything under here". `UID SEARCH ALL`
// is unusable (src-core/src/imap/mod.rs: the whole uid list arrives as one
// untagged line, and ESEARCH mis-parses on some servers), and loadEmails is
// single-mailbox by construction — SELECT, CONDSTORE, uid pagination.
//
// So this fans the existing per-mailbox lister across the branch and merges,
// the way the "all folders" search fan-out already does. activeMailbox stays
// the branch root, a real path; `mailboxScope` is what tells the rest of the
// app that a row's location has to be read off the row (spansMailboxes).

import * as api from '../api';
import { hasValidCredentials, ensureFreshToken } from '../authUtils';
import { mailboxDescendants } from './mailboxTree';

const HEADERS_PER_FOLDER = 200;

// A branch load outlives the click that started it: 23 folders is 23 round
// trips, and the reader can switch account in the middle of them.
let _generation = 0;

const newestFirst = (rows) =>
  [...rows].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

export async function loadSubtree(accountId, rootPath, { limitPerFolder = HEADERS_PER_FOLDER } = {}) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();
  const set = (patch) => useMailStore.setState(patch);

  const account = get().accounts.find(a => a.id === accountId);
  if (!account || !hasValidCredentials(account)) return;

  // The branch, minus the containers the server refuses to SELECT — their
  // children are still perfectly listable.
  const selectable = new Set((get().mailboxes || []).filter(m => !m.noselect).map(m => m.path));
  const paths = mailboxDescendants(rootPath, get().mailboxes).filter(p => selectable.has(p));

  // A leaf is an ordinary folder, and leaving a stale scope behind would tell
  // every row action to resolve per-row in a list where activeMailbox is the
  // whole truth.
  if (paths.length <= 1) {
    set({ activeMailbox: rootPath, mailboxScope: null });
    return;
  }

  const generation = ++_generation;
  const isStale = () => get().activeAccountId !== accountId || _generation !== generation;

  set({
    activeMailbox: rootPath,
    mailboxScope: { root: rootPath, paths },
    emails: [],
    // The folder before left its vault rows here, and deriveDisplayRows pushes
    // them into the list. A branch load is server-backed, so they would appear
    // under a heading that has nothing to do with them.
    localEmails: [],
    selectedEmailIds: new Set(),
    selectedEmailId: null,
    selectedEmail: null,
    selectedThread: null,
    totalEmails: 0,
    loading: true,
    subtreeProgress: { done: 0, total: paths.length },
  });

  const fresh = await ensureFreshToken(account);
  if (isStale()) return;

  // The true size of the branch, before a single header is fetched: STATUS is
  // one cheap round trip per folder, and the count a reader wants is the
  // server's, not however many headers this run happened to pull.
  const counts = await Promise.all(paths.map(p =>
    api.checkMailboxStatus(fresh, p).then(s => s?.exists || 0).catch(() => 0)));
  if (isStale()) return;
  set({ totalEmails: counts.reduce((a, b) => a + b, 0) });

  const merged = [];
  const seen = new Set();
  for (const [i, path] of paths.entries()) {
    if (isStale()) return;
    try {
      const result = await api.fetchEmails(fresh, path, 1, limitPerFolder);
      const savedEmailIds = get().savedEmailIds;
      for (const email of result.emails || []) {
        // A uid names a message only inside its own folder, so the folder is
        // part of the identity here and not a decoration.
        const key = `${path}|${email.uid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push({
          ...email,
          _accountId: accountId,
          _mailbox: path,
          source: 'server',
          isLocal: savedEmailIds.has(email.uid),
        });
      }
    } catch (error) {
      // 22 readable folders must not be lost to one that is not.
      console.warn(`[loadSubtree] ${path}: ${error.message}`);
    }

    if (isStale()) return;
    // Publish as we go: a 23-folder branch is long enough that a list which
    // fills only at the end reads as a folder that found nothing.
    set({ emails: newestFirst(merged), subtreeProgress: { done: i + 1, total: paths.length } });
    // sortedEmails is recomputed by an explicit call, not derived: writing
    // `emails` and stopping leaves the list painting the folder before.
    get().updateSortedEmails();
  }

  if (isStale()) return;
  set({ loading: false, subtreeProgress: null });
}

/**
 * Open a folder the way the sidebar does: a branch if it has folders under it,
 * an ordinary folder otherwise.
 *
 * One decision in one place. It used to live inline in Sidebar.selectFolder,
 * so every other way of opening a folder — chiefly the remembered folder an
 * account restores to — took the plain path and came back as the branch root
 * alone, listing a fraction of what the same click had shown.
 */
export async function openFolder(accountId, path) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  // The store holds ONE folder list: the active account's. At a cold start
  // there is none yet, and mid-switch it still belongs to the account being
  // left — same folder names, different server. Neither can decide this, and
  // neither is worth a fetch to find out: the plain open is the honest answer.
  const mailboxes = (get().activeAccountId === accountId && get().mailboxes) || [];
  // Only folders the server LISTed and will SELECT count. The path clicked may
  // be neither: a parent the tree synthesized because the server named only
  // its leaf (luke's "Project B"), or a \Noselect container. Counting it as
  // one of the branch made a lone real child look like a two-folder branch,
  // loadSubtree then filtered the root away, found one path, and opened
  // nothing — a blank list under a folder that does not exist.
  const real = new Set(mailboxes.filter(m => !m.noselect).map(m => m.path));
  const branch = mailboxDescendants(path, mailboxes).filter(p => real.has(p));

  if (branch.length > 1) return get().loadSubtree(accountId, path);
  // One real folder under it (or the folder itself): open that one.
  return get().activateAccount(accountId, branch[0] ?? path);
}
