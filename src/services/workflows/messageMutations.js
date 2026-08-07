// ── messageMutations workflow — archive, delete, mark, move, export ──

import * as db from '../db';
import * as api from '../api';
import { useSettingsStore } from '../../stores/settingsStore';
import { ensureFreshToken } from '../authUtils';
import { isGraphAccount, graphMessageToEmail } from '../graphConfig';
import { getGraphMessageId } from '../cacheManager';
import { _resolveUnifiedContext, _selKey, _parseSelKey } from '../../stores/slices/unifiedHelpers';
import { bumpFlagChangeCounter } from '../../stores/slices/messageListSlice';


// ── saveEmailLocally workflow ──

export async function saveEmailLocally(uid) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const state = get();
  const isUnified = state.activeMailbox === 'UNIFIED';
  const unified = isUnified ? _resolveUnifiedContext(uid, state) : null;
  const accountId = unified?.accountId || state.activeAccountId;
  const mailbox = (unified?.mailbox || state.activeMailbox) === 'UNIFIED' ? 'INBOX' : (unified?.mailbox || state.activeMailbox);
  const account = unified?.account || state.accounts.find(a => a.id === accountId);
  if (!account) return;

  const cacheKey = `${accountId}-${mailbox}-${uid}`;
  const cacheLimitMB = useSettingsStore.getState().cacheLimitMB;

  try {
    const alreadyCached = await db.isEmailSaved(accountId, mailbox, uid);
    if (alreadyCached) {
      await db.archiveEmail(accountId, mailbox, uid);
    } else {
      const email = await api.fetchEmail(account, uid, mailbox);

      if (!email.rawSource) {
        throw new Error('Email has no raw source data');
      }

      const invoke = window.__TAURI__?.core?.invoke;
      await invoke('maildir_store', {
        accountId: accountId,
        mailbox: mailbox,
        uid: email.uid,
        rawSourceBase64: email.rawSource,
        flags: ['archived', 'seen'],
      });
    }

    try {
      const emailData = get().emails?.find(e => e.uid === uid) || get().sortedEmails?.find(e => e.uid === uid);
      if (emailData) {
        const indexEntry = {
          uid: emailData.uid,
          from: emailData.from,
          to: emailData.to,
          subject: emailData.subject,
          date: emailData.date,
          flags: emailData.flags || [],
          has_attachments: emailData.hasAttachments || emailData.has_attachments || false,
          message_id: emailData.messageId || emailData.message_id || null,
          in_reply_to: emailData.inReplyTo || emailData.in_reply_to || null,
          references: emailData.references || null,
          snippet: emailData.snippet || '',
          source: 'local',
        };
        await api.appendLocalIndex(accountId, mailbox, [indexEntry]);
      }
    } catch (e) {
      console.warn('[mailStore] Failed to update local-index.json:', e);
    }

    if (!isUnified) {
      const savedEmailIds = await db.getSavedEmailIds(accountId, mailbox);
      const archivedEmailIds = await db.getArchivedEmailIds(accountId, mailbox);
      const localEmails = await db.getLocalEmails(accountId, mailbox);
      useMailStore.setState({ savedEmailIds, archivedEmailIds, localEmails });
    }
    get().updateSortedEmails();
  } catch (error) {
    useMailStore.setState({ error: `Failed to archive email: ${error.message}` });
    throw error;
  }
}


// ── saveEmailsLocally workflow ──

export async function saveEmailsLocally(uids) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const { activeAccountId, accounts, activeMailbox } = get();
  let account = accounts.find(a => a.id === activeAccountId);
  if (!account) return;
  account = await ensureFreshToken(account);

  const invoke = window.__TAURI__?.core?.invoke;

  if (invoke) {
    console.log('[saveEmailsLocally] Starting Tauri archive for', uids.length, 'UIDs');
    useMailStore.setState({ bulkSaveProgress: { total: uids.length, completed: 0, errors: 0, active: true } });

    let unlisten;
    try {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen('archive-progress', (event) => {
        const p = event.payload;
        const current = get().bulkSaveProgress;
        if (current && !current.active) return;

        useMailStore.setState({ bulkSaveProgress: { total: p.total, completed: p.completed, errors: p.errors, active: p.active } });

        if (p.lastUid) {
          const { archivedEmailIds } = get();
          if (!archivedEmailIds.has(p.lastUid)) {
            const updated = new Set(archivedEmailIds);
            updated.add(p.lastUid);
            useMailStore.setState({ archivedEmailIds: updated });
            get().updateSortedEmails();
          }
        }
      });
    } catch (e) {
      console.warn('[saveEmailsLocally] Failed to register event listener:', e);
    }

    try {
      const result = await invoke('archive_emails', {
        accountId: activeAccountId,
        accountJson: JSON.stringify(account),
        mailbox: activeMailbox,
        uids,
      });

      if (unlisten) { unlisten(); unlisten = null; }

      console.log('[saveEmailsLocally] invoke result:', JSON.stringify(result));
      const finalProgress = { total: result?.total ?? uids.length, completed: result?.completed ?? uids.length, errors: result?.errors ?? 0, active: false };
      console.log('[saveEmailsLocally] Setting final progress:', JSON.stringify(finalProgress));
      useMailStore.setState({ bulkSaveProgress: finalProgress });

      const savedEmailIds = await db.getSavedEmailIds(activeAccountId, activeMailbox);
      const archivedEmailIds = await db.getArchivedEmailIds(activeAccountId, activeMailbox);
      let localEmails = await db.readLocalEmailIndex(activeAccountId, activeMailbox);
      if (!localEmails) localEmails = await db.getLocalEmails(activeAccountId, activeMailbox);
      useMailStore.setState({ savedEmailIds, archivedEmailIds, localEmails });
      get().updateSortedEmails();
    } catch (err) {
      console.error('[saveEmailsLocally] archive_emails failed:', err);
      useMailStore.setState({ bulkSaveProgress: { total: uids.length, completed: 0, errors: uids.length, active: false } });
    } finally {
      if (unlisten) unlisten();
    }
    return;
  }

  const cacheLimitMB = useSettingsStore.getState().cacheLimitMB;
  useMailStore.setState({ bulkSaveProgress: { total: uids.length, completed: 0, errors: 0, active: true } });

  const emails = [];
  let completed = 0;
  let errors = 0;

  for (const uid of uids) {
    if (!get().bulkSaveProgress) break;

    const cacheKey = `${activeAccountId}-${activeMailbox}-${uid}`;
    try {
      let email;
      email = await api.fetchEmail(account, uid, activeMailbox);
      get().addToCache(cacheKey, email, cacheLimitMB);
      emails.push(email);
      completed++;
    } catch (error) {
      console.error(`Failed to fetch email ${uid}:`, error);
      errors++;
    }
    useMailStore.setState({ bulkSaveProgress: { total: uids.length, completed, errors, active: true } });
  }

  if (!get().bulkSaveProgress) return;

  if (emails.length > 0) {
    await db.saveEmails(emails, activeAccountId, activeMailbox);
    const savedEmailIds = await db.getSavedEmailIds(activeAccountId, activeMailbox);
    const archivedEmailIds = await db.getArchivedEmailIds(activeAccountId, activeMailbox);
    const localEmails = await db.getLocalEmails(activeAccountId, activeMailbox);
    useMailStore.setState({ savedEmailIds, archivedEmailIds, localEmails });
    get().updateSortedEmails();
  }

  useMailStore.setState({ bulkSaveProgress: { total: uids.length, completed, errors, active: false } });
  setTimeout(() => useMailStore.setState({ bulkSaveProgress: null }), 3000);
}


// ── saveSelectedLocally workflow ──

export async function saveSelectedLocally() {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const { selectedEmailIds, activeMailbox } = get();
  if (selectedEmailIds.size === 0) return;
  const keys = Array.from(selectedEmailIds);
  useMailStore.setState({ selectedEmailIds: new Set() });
  const uids = activeMailbox === 'UNIFIED' ? keys.map(k => _parseSelKey(k).uid) : keys;
  await get().saveEmailsLocally(uids);
}


// ── removeLocalEmail workflow ──

export async function removeLocalEmail(uid) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const state = get();
  const isUnified = state.activeMailbox === 'UNIFIED';
  const unified = isUnified ? _resolveUnifiedContext(uid, state) : null;
  const accountId = unified?.accountId || state.activeAccountId;
  const mailbox = (unified?.mailbox || state.activeMailbox) === 'UNIFIED' ? 'INBOX' : (unified?.mailbox || state.activeMailbox);
  const selectedEmailId = state.selectedEmailId;
  const localId = `${accountId}-${mailbox}-${uid}`;

  await db.deleteLocalEmail(localId);

  try {
    await api.removeFromLocalIndex(accountId, mailbox, uid);
  } catch (e) {
    console.warn('[mailStore] Failed to remove from local-index.json:', e);
  }

  const savedEmailIds = await db.getSavedEmailIds(accountId, mailbox);
  const archivedEmailIds = await db.getArchivedEmailIds(accountId, mailbox);
  const localEmails = await db.getLocalEmails(accountId, mailbox);

  if (selectedEmailId === uid) {
    useMailStore.setState({ savedEmailIds, archivedEmailIds, localEmails, selectedEmailId: null, selectedEmail: null, selectedEmailSource: null, selectedThread: null });
  } else {
    useMailStore.setState({ savedEmailIds, archivedEmailIds, localEmails });
  }
  get().updateSortedEmails();
}


// ── deleteEmailFromServer workflow ──

export async function deleteEmailFromServer(uid, { skipRefresh = false, mailboxOverride = null } = {}) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const state = get();
  const isUnified = state.activeMailbox === 'UNIFIED';
  const unified = isUnified ? _resolveUnifiedContext(uid, state) : null;
  const accountId = unified?.accountId || state.activeAccountId;
  const rawMb = mailboxOverride || unified?.mailbox || state.activeMailbox;
  const mailbox = rawMb === 'UNIFIED' ? 'INBOX' : rawMb;
  let account = unified?.account || state.accounts.find(a => a.id === accountId);
  const selectedEmailId = state.selectedEmailId;
  if (!account) { console.error('[deleteEmail] No account found for', accountId); return; }

  // Local-only short-circuit: if this UID belongs to an email that only
  // exists in Maildir + local-index (never confirmed server-side), route to
  // the local delete path. Otherwise the server delete would error on the
  // pseudo-UID and the entry would re-hydrate on next loadEmails.
  const candidate = [...(state.emails || []), ...(state.sentEmails || [])].find(e => e.uid === uid);
  const isLocalOnly = candidate?.source === 'local-only' || candidate?._localStaged === true;

  const invoke = window.__TAURI__?.core?.invoke;

  if (isLocalOnly) {
    if (invoke) {
      try {
        await invoke('maildir_delete', { accountId, mailbox, uid });
        await invoke('local_index_remove', { accountId, mailbox, uid });
        console.log(`[deleteEmail] Local-only delete: UID ${uid} (${accountId}/${mailbox})`);
      } catch (err) {
        console.error(`[deleteEmail] Local-only delete FAILED for UID ${uid}:`, err);
        throw err;
      }
    }
  } else {
    account = await ensureFreshToken(account);
    console.log(`[deleteEmail] Deleting UID ${uid} from mailbox "${mailbox}" (account: ${account.email}, isGraph: ${isGraphAccount(account)}, override: ${mailboxOverride})`);
    try {
      if (isGraphAccount(account)) {
        const graphId = getGraphMessageId(accountId, mailbox, uid);
        if (!graphId) throw new Error('Cannot delete: no Graph message ID found for this email.');
        await api.graphDeleteMessage(account.oauth2AccessToken, graphId);
      } else {
        await api.deleteEmail(account, uid, mailbox);
      }
      console.log(`[deleteEmail] Successfully deleted UID ${uid} from "${mailbox}"`);
    } catch (err) {
      console.error(`[deleteEmail] FAILED to delete UID ${uid} from "${mailbox}":`, err);
      throw err;
    }
  }

  const filteredEmails = get().emails.filter(e => e.uid !== uid);
  const filteredSent = get().sentEmails.filter(e => e.uid !== uid);
  const newTotal = Math.max(0, (get().totalEmails || 0) - 1);
  const updates = {
    emails: filteredEmails,
    sentEmails: filteredSent,
    totalEmails: newTotal,
  };
  if (selectedEmailId === uid) {
    updates.selectedEmailId = null;
    updates.selectedEmail = null;
    updates.selectedEmailSource = null;
    updates.selectedThread = null;
  }
  useMailStore.setState(updates);
  get().updateSortedEmails();

  if (!isUnified) {
    await db.saveEmailHeaders(accountId, mailbox, filteredEmails, newTotal, { removedUids: [uid] });
  }

  if (!skipRefresh && !isUnified) get().loadEmails();
}


// ── read-flag helpers (shared by the single-email and bulk paths) ──

const _withSeen = (flags, read) => read
  ? [...(flags || []), '\\Seen'].filter((f, i, a) => a.indexOf(f) === i)
  : (flags || []).filter(f => f !== '\\Seen');

// One message's \Seen change on the server. Graph accounts have no IMAP flags —
// the bulk path used to skip this branch, so mark-as-read silently failed there.
export async function _setSeenOnServer(account, accountId, mailbox, uid, read) {
  if (isGraphAccount(account)) {
    const graphId = getGraphMessageId(accountId, mailbox, uid);
    if (!graphId) {
      console.warn('[setSeenOnServer] No Graph message ID for UID', uid);
      return;
    }
    await api.graphSetRead(account.oauth2AccessToken, graphId, read);
    return;
  }
  await api.updateEmailFlags(account, uid, ['\\Seen'], read ? 'add' : 'remove', mailbox);
}

// Re-derive everything the list renders from after a flag-only change.
// A flag change moves no message in or out of the list, so it is invisible to
// the fingerprints in updateSortedEmails/getChatEmails/getThreads unless the
// flag counter is bumped first, and EmailList only rebuilds its threads when
// _flagSeq changes. Skip any of the three and the rows keep the old flags.
function _refreshAfterFlagChange(useMailStore) {
  bumpFlagChangeCounter();
  useMailStore.setState(state => ({ _flagSeq: state._flagSeq + 1 }));
  useMailStore.getState().updateSortedEmails();
}

function _syncUnreadBadge(useMailStore, accountId, mailbox) {
  if (mailbox !== 'INBOX') return;
  const unread = useMailStore.getState().emails.filter(e => !e.flags?.includes('\\Seen')).length;
  useSettingsStore.getState().setUnreadForAccount(accountId, unread);
}

// Land one message's \Seen change on every surface that renders read state:
// the list row, the open viewer copy, the cached body, the derived lists and
// the sidebar badge. The body cache is the easy one to miss — it freezes the
// flags the message had when it was fetched, so skipping it makes the next
// open of that message show the stale state and offer the wrong next action.
export function applySeenLocally(useMailStore, { accountId, mailbox, uid, read, isUnified = false }) {
  useMailStore.setState(state => ({
    emails: state.emails.map(e => {
      const match = isUnified ? (e._accountId === accountId && e.uid === uid) : (e.uid === uid);
      return match ? { ...e, flags: _withSeen(e.flags, read) } : e;
    }),
    selectedEmail: state.selectedEmail?.uid === uid
      ? { ...state.selectedEmail, flags: _withSeen(state.selectedEmail.flags, read) }
      : state.selectedEmail,
  }));

  const entry = useMailStore.getState().emailCache.get(`${accountId}-${mailbox}-${uid}`);
  if (entry) entry.email = { ...entry.email, flags: _withSeen(entry.email.flags, read) };

  _refreshAfterFlagChange(useMailStore);
  _syncUnreadBadge(useMailStore, accountId, mailbox);
}


// ── markEmailReadStatus workflow ──

export async function markEmailReadStatus(uid, read) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const state = get();
  const isUnified = state.activeMailbox === 'UNIFIED';
  const unified = isUnified ? _resolveUnifiedContext(uid, state) : null;
  const realUid = unified?.uid ?? uid;
  const accountId = unified?.accountId || state.activeAccountId;
  const mailbox = (unified?.mailbox || state.activeMailbox) === 'UNIFIED' ? 'INBOX' : (unified?.mailbox || state.activeMailbox);
  let account = unified?.account || state.accounts.find(a => a.id === accountId);
  if (!account) return;
  account = await ensureFreshToken(account);

  try {
    await _setSeenOnServer(account, accountId, mailbox, realUid, read);

    applySeenLocally(useMailStore, { accountId, mailbox, uid: realUid, read, isUnified });

    // Marking the open email unread means "not dealt with yet" — keeping it on
    // screen contradicts that, and the next open would just mark it read again.
    if (!read && useMailStore.getState().selectedEmail?.uid === realUid) {
      useMailStore.setState({
        selectedEmailId: null,
        selectedEmail: null,
        selectedEmailSource: null,
        selectedThread: null,
      });
    }
  } catch (error) {
    useMailStore.setState({ error: `Failed to update read status: ${error.message}` });
  }
}


// ── exportEmail workflow ──

export async function exportEmail(uid) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const state = get();
  const isUnified = state.activeMailbox === 'UNIFIED';
  const unified = isUnified ? _resolveUnifiedContext(uid, state) : null;
  const accountId = unified?.accountId || state.activeAccountId;
  const mailbox = (unified?.mailbox || state.activeMailbox) === 'UNIFIED' ? 'INBOX' : (unified?.mailbox || state.activeMailbox);
  const localId = `${accountId}-${mailbox}-${uid}`;
  return db.exportEmail(localId);
}


// ── bulk mark read/unread workflow ──

async function _markSelected(read) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const state = get();
  const { selectedEmailIds, accounts } = state;
  const isUnified = state.activeMailbox === 'UNIFIED';
  if (selectedEmailIds.size === 0) return;

  const keys = Array.from(selectedEmailIds);
  const keySet = new Set(keys);
  const selKeyOf = (e) => (isUnified ? _selKey(e) : e.uid);

  useMailStore.setState(s => ({
    emails: s.emails.map(e => keySet.has(selKeyOf(e)) ? { ...e, flags: _withSeen(e.flags, read) } : e),
    selectedEmail: s.selectedEmail && keySet.has(selKeyOf(s.selectedEmail))
      ? { ...s.selectedEmail, flags: _withSeen(s.selectedEmail.flags, read) }
      : s.selectedEmail,
    selectedEmailIds: new Set(),
  }));
  _refreshAfterFlagChange(useMailStore);

  if (isUnified) {
    // Unified rows span accounts, so the sidebar badges have to be counted per
    // account. The unified list is INBOX-only, so no mailbox check here.
    const byAccount = new Map();
    for (const e of get().emails) {
      if (!e._accountId) continue;
      byAccount.set(e._accountId, (byAccount.get(e._accountId) || 0) + (e.flags?.includes('\\Seen') ? 0 : 1));
    }
    for (const [id, unread] of byAccount) useSettingsStore.getState().setUnreadForAccount(id, unread);
  } else {
    _syncUnreadBadge(useMailStore, state.activeAccountId, state.activeMailbox);
  }

  for (const key of keys) {
    try {
      const ctx = isUnified ? _resolveUnifiedContext(key, state) : null;
      const realUid = ctx?.uid ?? key;
      const accountId = ctx?.accountId || state.activeAccountId;
      const rawMailbox = ctx?.mailbox || state.activeMailbox;
      const mailbox = rawMailbox === 'UNIFIED' ? 'INBOX' : rawMailbox;
      let account = ctx?.account || accounts.find(a => a.id === accountId);
      account = await ensureFreshToken(account);
      await _setSeenOnServer(account, accountId, mailbox, realUid, read);
    } catch (e) {
      console.error(`Failed to mark email ${key} as ${read ? 'read' : 'unread'}:`, e);
    }
  }
}

export const markSelectedAsRead = () => _markSelected(true);
export const markSelectedAsUnread = () => _markSelected(false);


// ── deleteSelectedFromServer workflow ──


export async function deleteSelectedFromServer() {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const state = get();
  const { selectedEmailIds, accounts } = state;
  const isUnified = state.activeMailbox === 'UNIFIED';
  if (selectedEmailIds.size === 0) return;

  const keys = Array.from(selectedEmailIds);

  const sentPath = get().getSentMailboxPath();
  const allEmails = [...state.emails, ...state.sentEmails];
  const emailMap = new Map(allEmails.map(e => [isUnified ? _selKey(e) : e.uid, e]));

  // Remove from the UI immediately — the server/maildir deletes below can take
  // seconds (pool checkout + one round-trip per email). The post-loop
  // loadEmails() reconcile restores anything whose server delete failed.
  const deletedKeySet = new Set(keys);
  const realUidSet = new Set(keys.map(k => (isUnified ? _resolveUnifiedContext(k, state)?.uid : k) ?? k));

  // Tombstone helper — must match the composition in updateSortedEmails.
  const tombstoneKey = (key) => {
    const ctx = isUnified ? _resolveUnifiedContext(key, state) : null;
    const realUid = ctx?.uid ?? key;
    const accountId = ctx?.accountId || state.activeAccountId;
    const emailObj = emailMap.get(key);
    const rawMailbox = ctx?.mailbox || (emailObj?._fromSentFolder && sentPath ? sentPath : state.activeMailbox);
    const mailbox = rawMailbox === 'UNIFIED' ? 'INBOX' : rawMailbox;
    return `${accountId}|${mailbox}|${realUid}`;
  };
  const newTombstones = new Set(state.deleteTombstones);
  for (const key of keys) newTombstones.add(tombstoneKey(key));

  useMailStore.setState({
    deleteTombstones: newTombstones,
    selectedEmailIds: new Set(),
    emails: state.emails.filter(e => !deletedKeySet.has(isUnified ? _selKey(e) : e.uid)),
    sentEmails: state.sentEmails.filter(e => !deletedKeySet.has(isUnified ? _selKey(e) : e.uid)),
    totalEmails: Math.max(0, (state.totalEmails || 0) - keys.length),
    selectedEmailId: realUidSet.has(state.selectedEmailId) ? null : state.selectedEmailId,
    selectedEmail: realUidSet.has(state.selectedEmailId) ? null : state.selectedEmail,
  });
  get().updateSortedEmails();

  const deletedRealUids = new Set();

  const invoke = window.__TAURI__?.core?.invoke;

  for (const key of keys) {
    try {
      const ctx = isUnified ? _resolveUnifiedContext(key, state) : null;
      const realUid = ctx?.uid ?? key;
      const accountId = ctx?.accountId || state.activeAccountId;
      const emailObj = emailMap.get(key);
      const rawMailbox = ctx?.mailbox || (emailObj?._fromSentFolder && sentPath ? sentPath : state.activeMailbox);
      const mailbox = rawMailbox === 'UNIFIED' ? 'INBOX' : rawMailbox;

      // Local-only messages (e.g. sent emails that never made it to server via
      // IMAP APPEND) live only in Maildir + local-index. Route them through the
      // local-delete path — otherwise the IMAP/Graph delete either errors or
      // no-ops on the pseudo-UID and the entry re-hydrates on next loadEmails.
      const isLocalOnly = emailObj?.source === 'local-only' || emailObj?._localStaged === true;
      if (isLocalOnly) {
        if (invoke) {
          try {
            await invoke('maildir_delete', { accountId, mailbox, uid: realUid });
            await invoke('local_index_remove', { accountId, mailbox, uid: realUid });
            console.log(`[deleteSelectedFromServer] Local-only delete: UID ${realUid} (${accountId}/${mailbox})`);
          } catch (err) {
            console.warn(`[deleteSelectedFromServer] Local-only delete failed for UID ${realUid}:`, err);
          }
        }
        deletedRealUids.add(realUid);
        continue;
      }

      let account = ctx?.account || accounts.find(a => a.id === accountId);
      account = await ensureFreshToken(account);

      if (isGraphAccount(account)) {
        const graphId = getGraphMessageId(accountId, mailbox, realUid);
        if (graphId) {
          await api.graphDeleteMessage(account.oauth2AccessToken, graphId);
        } else {
          console.warn(`[deleteSelectedFromServer] No Graph ID for UID ${realUid}, skipping`);
        }
      } else {
        await api.deleteEmail(account, realUid, mailbox);
      }
      deletedRealUids.add(realUid);
    } catch (e) {
      console.error(`Failed to delete email ${key}:`, e);
      // Lift the tombstone so the reconcile below can restore this email.
      const ts = new Set(get().deleteTombstones);
      ts.delete(tombstoneKey(key));
      useMailStore.setState({ deleteTombstones: ts });
    }
  }

  // Reconcile with the server: prunes the header cache and restores any email
  // whose delete failed (resilient over silently wrong).
  if (!isUnified) get().loadEmails();
}


// ── moveEmails workflow ──

export async function moveEmails(uids, targetMailbox) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const state = get();
  const isUnified = state.activeMailbox === 'UNIFIED';
  const selectedEmailId = state.selectedEmailId;
  const { activeAccountId, activeMailbox } = state;

  if (isUnified) {
    const groups = new Map();
    for (const key of uids) {
      const ctx = _resolveUnifiedContext(key, state);
      if (!ctx) continue;
      if (!groups.has(ctx.accountId)) groups.set(ctx.accountId, { account: ctx.account, mailbox: ctx.mailbox, uids: [] });
      groups.get(ctx.accountId).uids.push(ctx.uid);
    }
    for (const [, group] of groups) {
      const freshAccount = await ensureFreshToken(group.account);
      await api.moveEmails(freshAccount, group.uids, group.mailbox, targetMailbox);
    }
  } else {
    const { accounts, mailboxes } = state;
    let account = accounts.find(a => a.id === activeAccountId);
    if (!account) return;
    account = await ensureFreshToken(account);

    if (isGraphAccount(account)) {
      const messageIds = uids
        .map(uid => getGraphMessageId(activeAccountId, activeMailbox, uid))
        .filter(Boolean);
      if (messageIds.length === 0) throw new Error('Cannot move: no Graph message IDs found for selected emails.');

      const targetFolder = mailboxes.find(m => m.path === targetMailbox || m.name === targetMailbox);
      if (!targetFolder || !targetFolder._graphFolderId) {
        throw new Error(`Cannot move: target folder "${targetMailbox}" not found.`);
      }

      await api.graphMoveEmails(account.oauth2AccessToken, messageIds, targetFolder._graphFolderId);
    } else {
      await api.moveEmails(account, uids, activeMailbox, targetMailbox);
    }
  }

  const keySet = new Set(uids);
  const filteredEmails = get().emails.filter(e => {
    const k = isUnified ? _selKey(e) : e.uid;
    return !keySet.has(k);
  });
  const newTotal = Math.max(0, (get().totalEmails || 0) - uids.length);
  const updates = {
    emails: filteredEmails,
    totalEmails: newTotal,
    selectedEmailIds: new Set(),
  };

  if (keySet.has(selectedEmailId)) {
    updates.selectedEmailId = null;
    updates.selectedEmail = null;
    updates.selectedEmailSource = null;
    updates.selectedThread = null;
  }
  useMailStore.setState(updates);
  // Drop the moved rows now — loadEmails() below is a server round-trip, and
  // until it returns the list still renders what was moved away.
  get().updateSortedEmails();

  const { invalidateRestoreDescriptors: _invalidateRestore } = await import('../cacheManager');
  // Unified keys aren't UIDs — only the per-account path can name removed UIDs.
  await db.saveEmailHeaders(activeAccountId, activeMailbox, filteredEmails, newTotal,
    isUnified ? undefined : { removedUids: uids });

  _invalidateRestore(activeAccountId);

  get().loadEmails();
}
