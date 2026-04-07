// ── loadUnifiedInbox workflow — unified inbox loading and folder switching ──

import * as db from '../db';
import * as api from '../api';
import { useSettingsStore } from '../../stores/settingsStore';
import { _buildRestoreDescriptor, _resolveMailboxPath } from '../../stores/slices/unifiedHelpers';
import { getRestoreDescriptor as _getRestore, getAccountCacheMailboxes as _getAccountMailboxes } from '../cacheManager';
import {
  getLoadAbortController, setLoadAbortController,
} from '../../stores/slices/messageListSlice';
import { _unifiedFolderCache } from './activateAccount';


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
    });
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
      serverUidSet: allServerUids,
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
    loading: true,
    selectedEmailId: null,
    selectedEmail: null,
    selectedEmailSource: null,
    selectedThread: null,
    selectedEmailIds: new Set(),
  });
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

  const CHUNK_SIZE = 50;

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
  const diskFetchPromises = [];
  const resolvedPathsByAccount = new Map();

  for (const account of accounts) {
    if (hiddenAccounts[account.id]) continue;

    const resolvedPath = _resolveMailboxPath(mailboxesByAccount.get(account.id) || [], targetFolder);
    resolvedPathsByAccount.set(account.id, resolvedPath);

    const restored = _getRestore(account.id, resolvedPath, get().viewMode || 'all');
    if (restored?.firstWindow?.length) {
      for (const email of restored.firstWindow) {
        allEmails.push({ ...email, _accountEmail: account.email, _accountId: account.id, _mailbox: resolvedPath });
      }
    }
    diskFetchPromises.push(
      db.getEmailHeadersPartial(account.id, resolvedPath, 500).then(diskData => {
        if (!diskData || !diskData.emails) return [];
        return diskData.emails.map(email => ({ ...email, _accountEmail: account.email, _accountId: account.id, _mailbox: resolvedPath }));
      }).catch(() => [])
    );
  }

  if (diskFetchPromises.length > 0) {
    const diskResults = await Promise.all(diskFetchPromises);
    for (const emails of diskResults) {
      allEmails.push(...emails);
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
      const existingUids = new Set(allEmails.map(e => `${e._accountId}:${e.uid}`));
      for (const email of preUnifiedSnapshot.emails) {
        const key = `${preUnifiedSnapshot.activeAccountId}:${email.uid}`;
        if (!existingUids.has(key)) {
          allEmails.push({
            ...email,
            _accountEmail: activeAccount.email,
            _accountId: activeAccount.id,
            _mailbox: email._mailbox || snapshotMailbox,
          });
        }
      }
    }
  }

  allEmails.sort((a, b) => {
    const dateA = a.date ? new Date(a.date).getTime() : 0;
    const dateB = b.date ? new Date(b.date).getTime() : 0;
    return dateB - dateA;
  });

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

  useMailStore.setState({
    emails: firstBatch,
    serverUidSet: allServerUids,
    _sortedEmailsFingerprint: '',
    activeMailbox: 'UNIFIED',
    totalEmails: total,
    selectedEmailId: null,
    selectedEmail: null,
    selectedEmailSource: null,
    selectedThread: null,
    selectedEmailIds: new Set(),
    hasMoreEmails: false,
    currentPage: 1,
    loading: false,
    loadingProgress: total > CHUNK_SIZE ? { loaded: Math.min(CHUNK_SIZE, total), total } : null,
  });
  get().updateSortedEmails();

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
        serverUidSet: chunkServerUids,
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
  const allArchivedIds = new Set();
  const localPromises = accounts
    .filter(a => !hiddenAccounts[a.id])
    .map(async (account) => {
      try {
        const localFolder = resolvedPathsByAccount.get(account.id) || targetFolder;
        const [saved, archived] = await Promise.all([
          db.getSavedEmailIds(account.id, localFolder),
          db.getArchivedEmailIds(account.id, localFolder),
        ]);
        let locals = await db.readLocalEmailIndex(account.id, localFolder);
        if (!locals) locals = await db.getLocalEmails(account.id, localFolder);
        for (const uid of saved) allSavedIds.add(uid);
        for (const uid of archived) allArchivedIds.add(uid);
        for (const e of locals) {
          allLocalEmails.push({ ...e, _accountEmail: account.email, _accountId: account.id, _mailbox: localFolder });
        }
      } catch {}
    });
  await Promise.all(localPromises);

  if (signal.aborted) return;
  useMailStore.setState({
    localEmails: allLocalEmails,
    savedEmailIds: allSavedIds,
    archivedEmailIds: allArchivedIds,
  });
  get().updateSortedEmails();
}
