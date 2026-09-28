// ── loadUnifiedInbox workflow — unified inbox loading and folder switching ──

import * as db from '../db';
import * as api from '../api';
import { useSettingsStore } from '../../stores/settingsStore';
import { _buildRestoreDescriptor, _resolveMailboxPath, readerClearOnNavigation } from '../../stores/slices/unifiedHelpers';
import { serverUids } from '../../stores/slices/serverUids';
import { getRestoreDescriptor as _getRestore, getAccountCacheMailboxes as _getAccountMailboxes } from '../cacheManager';
import {
  getLoadAbortController, setLoadAbortController, setArchivedGroup, deriveArchivedUnion,
} from '../../stores/slices/messageListSlice';
import { _unifiedFolderCache } from './activateAccount';


const CHUNK_SIZE = 50;
const byDateDesc = (a, b) => (b.date ? new Date(b.date).getTime() : 0) - (a.date ? new Date(a.date).getTime() : 0);

// What All Inboxes can draw before any disk read: each visible account's
// restore window (in memory since the prewarm) and, for the account being
// left, the rows already on screen. Newest first, the load's own dedupe key.
// Entering the view paints this at once; the disk reads widen it after.
export function unifiedSeed(state, folder, snapshot = null) {
  const { hiddenAccounts } = useSettingsStore.getState();
  const seen = new Set();
  const rows = [];
  const push = (e) => {
    const key = `${e._accountId}:${e.uid}`;
    if (!seen.has(key)) { seen.add(key); rows.push(e); }
  };
  for (const account of state.accounts || []) {
    if (hiddenAccounts[account.id]) continue;
    const path = _resolveMailboxPath(_getAccountMailboxes(account.id) || [], folder);
    const tag = (e, mailbox = path) => ({ ...e, _accountEmail: account.email, _accountId: account.id, _mailbox: mailbox });
    for (const e of _getRestore(account.id, path, state.viewMode || 'all')?.firstWindow || []) push(tag(e));
    if (snapshot?.activeAccountId === account.id) for (const e of snapshot.emails || []) push(tag(e, e._mailbox || path));
  }
  return rows.sort(byDateDesc).slice(0, CHUNK_SIZE);
}

// The seed's store write: rows up, the skeleton only when there are none.
// The account being left's local rows carry no account and would draw
// unscoped here; the load's last step puts every account's back.
function paintSeed(seed) {
  return {
    emails: seed,
    localEmails: [],
    serverUids: serverUids(new Set(seed.map(e => e.uid)), { complete: false }),
    totalEmails: seed.length,
    _sortedEmailsFingerprint: '',
    loading: seed.length === 0,
  };
}


// ── setUnifiedInbox workflow ──

export async function setUnifiedInbox(enabled) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  if (enabled) {
    const { activeAccountId, activeMailbox, emails: currentEmails } = get();
    const preUnifiedSnapshot = (activeMailbox === 'INBOX') ? { activeAccountId, emails: currentEmails } : null;

    if (activeAccountId && activeMailbox && activeMailbox !== 'UNIFIED') {
      const { saveRestoreDescriptor: _saveRestore } = await import('../cacheManager');
      _saveRestore(_buildRestoreDescriptor(get()));
    }

    useMailStore.setState({
      unifiedInbox: true,
      unifiedFolder: 'INBOX',
      activeMailbox: 'UNIFIED',
      selectedEmailId: null,
      selectedEmail: null,
      selectedEmailSource: null,
      selectedThread: null,
      selectedEmailIds: new Set(),
      ...paintSeed(unifiedSeed(get(), 'INBOX', preUnifiedSnapshot)),
    });
    get().updateSortedEmails();
    get().loadUnifiedInbox(preUnifiedSnapshot, 'INBOX');
  } else {
    const _loadAbortController = getLoadAbortController();
    if (_loadAbortController) _loadAbortController.abort();
    _unifiedFolderCache.clear();
    useMailStore.setState({ unifiedInbox: false, unifiedFolder: 'INBOX', loadingProgress: null });
  }
}


// ── switchUnifiedFolder workflow ──

export async function switchUnifiedFolder(mailbox) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const { unifiedInbox } = get();
  if (!unifiedInbox) return;

  const cached = _unifiedFolderCache.get(mailbox);
  if (cached && (Date.now() - cached.timestamp < 5 * 60 * 1000)) {
    const allServerUids = new Set(cached.emails.map(e => e.uid));
    useMailStore.setState({
      unifiedFolder: mailbox,
      emails: cached.emails,
      // Cross-account, cache-derived — never a live server enumeration. Must
      // not inherit a stale `true` from the single-account view left behind.
      serverUids: serverUids(allServerUids, { complete: false }),
      totalEmails: cached.emails.length,
      _sortedEmailsFingerprint: '',
      selectedEmailId: null,
      selectedEmail: null,
      selectedEmailSource: null,
      selectedThread: null,
      selectedEmailIds: new Set(),
      loading: false,
    });
    get().updateSortedEmails();
    get().loadUnifiedInbox(null, mailbox);
    return;
  }

  useMailStore.setState({
    unifiedFolder: mailbox,
    selectedEmailId: null,
    selectedEmail: null,
    selectedEmailSource: null,
    selectedThread: null,
    selectedEmailIds: new Set(),
    ...paintSeed(unifiedSeed(get(), mailbox)),
  });
  get().updateSortedEmails();
  get().loadUnifiedInbox(null, mailbox);
}


// ── loadUnifiedInbox workflow ──

export async function loadUnifiedInbox(preUnifiedSnapshot = null, mailbox = null) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const { accounts, unifiedFolder } = get();
  const targetFolder = mailbox || unifiedFolder || 'INBOX';
  const { hiddenAccounts } = useSettingsStore.getState();

  let _loadAbortController = getLoadAbortController();
  if (_loadAbortController) _loadAbortController.abort();
  _loadAbortController = new AbortController();
  setLoadAbortController(_loadAbortController);
  const signal = _loadAbortController.signal;

  const mailboxesByAccount = new Map();
  await Promise.all(
    accounts.filter(a => !hiddenAccounts[a.id]).map(async (account) => {
      const cachedMailboxes = _getAccountMailboxes(account.id);
      if (cachedMailboxes?.length) {
        mailboxesByAccount.set(account.id, cachedMailboxes);
      } else {
        const diskMailboxes = await db.getCachedMailboxes(account.id);
        mailboxesByAccount.set(account.id, diskMailboxes || []);
      }
    })
  );

  if (signal.aborted) return;

  const allEmails = [];
  // Three sources feed this list and they overlap: the restore descriptor's
  // 50-row window (the prewarm writes one per account from the same cache the
  // disk read below returns), those disk headers, and the pre-unified
  // snapshot. Only the snapshot used to dedupe, so every row the descriptor
  // held arrived twice — a doubled list, doubled counters, and two identical
  // copies of every message inside the threads built from it. UID alone is not
  // a key across accounts; account + uid is, within one folder.
  const seenKeys = new Set();
  const pushUnique = (email) => {
    const key = `${email._accountId}:${email.uid}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    allEmails.push(email);
  };
  const diskFetchPromises = [];
  const resolvedPathsByAccount = new Map();
  // Each account's disk read paints as it lands instead of the list waiting
  // for the slowest one. Only while the view still shows its opening window:
  // a refresh of a list already widened past it is left alone until the end.
  const diskSoFar = [];
  let paintQueued = false;
  let settled = false;
  const paintSoFar = () => {
    if (paintQueued) return;
    paintQueued = true;
    setTimeout(() => {
      paintQueued = false;
      const live = get();
      if (settled || signal.aborted || live.activeMailbox !== 'UNIFIED' || live.emails.length > CHUNK_SIZE) return;
      const seen = new Set();
      // The seed on screen stays (it holds the rows of the account just left).
      const rows = [...allEmails, ...diskSoFar.flat(), ...live.emails].filter(e => {
        const key = `${e._accountId}:${e.uid}`;
        return !seen.has(key) && seen.add(key);
      }).sort(byDateDesc).slice(0, CHUNK_SIZE);
      useMailStore.setState({
        emails: rows,
        serverUids: serverUids(new Set(rows.map(e => e.uid)), { complete: false }),
        totalEmails: Math.max(rows.length, live.totalEmails || 0),
        _sortedEmailsFingerprint: '',
        loading: false,
      });
      get().updateSortedEmails();
    }, 0);
  };

  for (const account of accounts) {
    if (hiddenAccounts[account.id]) continue;

    const resolvedPath = _resolveMailboxPath(mailboxesByAccount.get(account.id) || [], targetFolder);
    resolvedPathsByAccount.set(account.id, resolvedPath);

    const restored = _getRestore(account.id, resolvedPath, get().viewMode || 'all');
    if (restored?.firstWindow?.length) {
      for (const email of restored.firstWindow) {
        pushUnique({ ...email, _accountEmail: account.email, _accountId: account.id, _mailbox: resolvedPath });
      }
    }
    const slot = diskFetchPromises.length;
    diskFetchPromises.push(
      db.getEmailHeadersPartial(account.id, resolvedPath, 500).then(diskData => {
        if (!diskData || !diskData.emails) return [];
        return diskData.emails.map(email => ({ ...email, _accountEmail: account.email, _accountId: account.id, _mailbox: resolvedPath }));
      }).catch(() => []).then(rows => {
        diskSoFar[slot] = rows;
        if (rows.length) paintSoFar();
        return rows;
      })
    );
  }

  if (diskFetchPromises.length > 0) {
    const diskResults = await Promise.all(diskFetchPromises);
    settled = true;
    for (const emails of diskResults) {
      for (const email of emails) pushUnique(email);
    }
  }

  if (signal.aborted) return;

  if (preUnifiedSnapshot && !hiddenAccounts[preUnifiedSnapshot.activeAccountId]) {
    const activeAccount = accounts.find(a => a.id === preUnifiedSnapshot.activeAccountId);
    if (activeAccount) {
      const snapshotMailbox = _resolveMailboxPath(
        mailboxesByAccount.get(preUnifiedSnapshot.activeAccountId) || [],
        targetFolder
      );
      for (const email of preUnifiedSnapshot.emails) {
        pushUnique({
          ...email,
          _accountEmail: activeAccount.email,
          _accountId: activeAccount.id,
          _mailbox: email._mailbox || snapshotMailbox,
        });
      }
    }
  }

  allEmails.sort(byDateDesc);

  // Cap unified folder cache at 3 entries (LRU eviction)
  const UNIFIED_FOLDER_CACHE_MAX = 3;
  while (_unifiedFolderCache.size >= UNIFIED_FOLDER_CACHE_MAX) {
    let oldest = null, oldestTime = Infinity;
    for (const [k, v] of _unifiedFolderCache) {
      if (v.timestamp < oldestTime) { oldest = k; oldestTime = v.timestamp; }
    }
    if (oldest) _unifiedFolderCache.delete(oldest);
    else break;
  }
  _unifiedFolderCache.set(targetFolder, { emails: allEmails, timestamp: Date.now() });

  const total = allEmails.length;
  const firstBatch = allEmails.slice(0, CHUNK_SIZE);

  const allServerUids = new Set();
  for (const e of firstBatch) allServerUids.add(e.uid);

  // Refresh in All Inboxes lands here too, and closing the open message on a
  // plain reload of the view already on screen is not something the user
  // asked for. The paths that really move into (or across) this view —
  // setUnifiedInbox, switchUnifiedFolder — clear the reader themselves before
  // they call this, so nothing is lost by leaving it alone here.
  const reader = readerClearOnNavigation(useMailStore.getState(), useMailStore.getState().activeAccountId, 'UNIFIED');
  useMailStore.setState({
    emails: firstBatch,
    // firstBatch is a rendered chunk of a cross-account cache merge, never a
    // server enumeration — see the same note on the progressive chunk below.
    serverUids: serverUids(allServerUids, { complete: false }),
    _sortedEmailsFingerprint: '',
    activeMailbox: 'UNIFIED',
    totalEmails: total,
    ...reader,
    hasMoreEmails: false,
    currentPage: 1,
    loading: false,
    loadingProgress: total > CHUNK_SIZE ? { loaded: Math.min(CHUNK_SIZE, total), total } : null,
  });
  get().updateSortedEmails();

  // Each visible account's Sent, threaded into its INBOX conversations the way
  // one account's INBOX does. From the cache: the pipelines fetch from the
  // servers, and this runs on every refresh. Not for the unified Sent and
  // Drafts views, which are the outgoing mail themselves.
  if (targetFolder === 'INBOX') {
    for (const account of accounts) {
      if (hiddenAccounts[account.id]) continue;
      Promise.resolve(get().loadSentHeaders(account.id, { cacheOnly: true }))
        .catch(e => console.warn('[loadUnifiedInbox] Sent headers failed:', account.id, e?.message));
    }
  }

  if (total > CHUNK_SIZE) {
    let offset = CHUNK_SIZE;
    while (offset < total) {
      if (signal.aborted) break;
      await new Promise(r => setTimeout(r, 0));

      offset += CHUNK_SIZE;
      const chunk = allEmails.slice(0, Math.min(offset, total));
      const chunkServerUids = new Set();
      for (const e of chunk) chunkServerUids.add(e.uid);

      if (signal.aborted) break;

      useMailStore.setState({
        emails: chunk,
        // Still widening toward allEmails, but allEmails is itself a
        // cross-account cache/local merge, not a server enumeration — this
        // never earns `true`, not even on the final chunk.
        serverUids: serverUids(chunkServerUids, { complete: false }),
        totalEmails: total,
        _sortedEmailsFingerprint: '',
        loadingProgress: { loaded: Math.min(offset, total), total },
      });
      get().updateSortedEmails();
    }
    if (!signal.aborted) useMailStore.setState({ loadingProgress: null });
  }

  if (signal.aborted) return;

  const allLocalEmails = [];
  const allSavedIds = new Set();
  // Accounts whose vault read came back unknown keep what the store holds.
  let savedUnknown = false;
  const localsUnknown = [];
  // Every viewed account contributes one pair, resolved the same way
  // resolvedPathsByAccount already was above. A pair with no cached group
  // entry just contributes nothing to the derived union (see
  // messageListSlice's deriveArchivedUnion).
  const viewPairs = accounts.filter(a => !hiddenAccounts[a.id])
    .map(a => [a.id, resolvedPathsByAccount.get(a.id) || targetFolder]);
  const localPromises = accounts
    .filter(a => !hiddenAccounts[a.id])
    .map(async (account) => {
      try {
        const localFolder = resolvedPathsByAccount.get(account.id) || targetFolder;
        const vault = await db.getVaultUidSets(account.id, localFolder);
        let locals = await db.readLocalEmailIndex(account.id, localFolder);
        if (!locals) locals = await db.getLocalEmails(account.id, localFolder);
        if (vault) for (const uid of vault.saved) allSavedIds.add(uid);
        else savedUnknown = true;
        // I-5: a null (unknown) read keeps this group's own last-known ids
        // (setArchivedGroup skips a null write) instead of the whole unified
        // pass losing this one account.
        setArchivedGroup(account.id, localFolder, vault?.archived ?? null);
        // Unknown rows: skip this account's merge, keep its rows on screen.
        if (!locals) { localsUnknown.push([account.id, localFolder]); return; }
        for (const e of locals) {
          allLocalEmails.push({ ...e, _accountEmail: account.email, _accountId: account.id, _mailbox: localFolder });
        }
      } catch {}
    });
  await Promise.all(localPromises);

  if (signal.aborted) return;
  const live = get();
  const archivedEmailIds = deriveArchivedUnion(live.archivedEmailIds, viewPairs);
  const kept = (live.localEmails || []).filter(e => localsUnknown.some(([a, m]) => e._accountId === a && e._mailbox === m));
  useMailStore.setState({
    localEmails: [...allLocalEmails, ...kept],
    savedEmailIds: savedUnknown ? new Set([...(live.savedEmailIds || []), ...allSavedIds]) : allSavedIds,
    archivedEmailIds,
  });
  get().updateSortedEmails();
}
