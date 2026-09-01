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
