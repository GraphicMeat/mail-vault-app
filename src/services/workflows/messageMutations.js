// ── messageMutations workflow — archive, delete, mark, move, export ──

import * as db from '../db';
import * as api from '../api';
import { useSettingsStore } from '../../stores/settingsStore';
import { ensureFreshToken } from '../authUtils';
import { isGraphAccount, graphMessageToEmail } from '../graphConfig';
import { resolveGraphMessageId } from '../cacheManager';
import { _resolveUnifiedContext, _selKey, _parseSelKey } from '../../stores/slices/unifiedHelpers';
import { bumpFlagChangeCounter } from '../../stores/slices/messageListSlice';
import { withoutUids } from '../../stores/slices/serverUids';


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
    // Says what did NOT happen, too: an archive that fails is the moment a
    // user most needs to know their server copy is still there.
    useMailStore.setState({ error: `Could not copy that email into your vault. Nothing was removed from the server. (${error.message})` });
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

  // Journal the intent first, and await it — same reason and same ordering as
  // deleteSelectedFromServer: the row is about to vanish from the list, so a
  // reload or quit before the server answers must leave something the next
  // launch can finish (replayPendingDeletes). Skipped for Graph (its delete is
  // addressed by a per-session message id, not a replayable uid) and for
  // local-only rows (no server delete to replay).
  const realUid = unified?.uid ?? uid;
  const journalled = !isLocalOnly && !isGraphAccount(account);
  if (journalled) await db.queuePendingDeletes(accountId, mailbox, [realUid]);

  // ── Optimistic removal ──
  // Take the row out now. Everything below is a network round trip (pool
  // checkout, STORE + EXPUNGE, or a Graph id lookup) and takes seconds; a list
  // that sits there unchanged while a modal spins is the same UI the bulk
  // paths already refuse to show (deleteSelectedFromServer, purgeEverywhere).
  // The tombstone stops a stale header cache re-rendering the row in the
  // meantime; a failed delete lifts it again and reloads, which puts the row
  // back — exactly the contract the bulk paths use.
  const tombstone = `${accountId}|${mailbox}|${realUid}`;
  const isThisEmail = (e) => (isUnified ? _selKey(e) === String(uid) || (e._accountId === accountId && e.uid === realUid) : e.uid === uid);
  useMailStore.setState({
    deleteTombstones: new Set(state.deleteTombstones).add(tombstone),
    emails: state.emails.filter(e => !isThisEmail(e)),
    sentEmails: state.sentEmails.filter(e => !isThisEmail(e)),
    selectedEmailIds: new Set([...state.selectedEmailIds].filter(k => k !== uid && k !== realUid)),
    ...(selectedEmailId === uid || selectedEmailId === realUid
      ? { selectedEmailId: null, selectedEmail: null, selectedEmailSource: null, selectedThread: null }
      : {}),
  });
  get().updateSortedEmails();

  // Put the row back and let the reconcile re-derive it. `totalEmails` is
  // untouched above — applyServerRemoval owns that decrement on the success
  // path, so a failure has nothing to restore there.
  const restoreRow = () => {
    const ts = new Set(get().deleteTombstones);
    ts.delete(tombstone);
    useMailStore.setState({ deleteTombstones: ts });
    // Drop the journal entry too: the row is back on screen, so a replay at
    // next launch would delete a message the app is currently showing as
    // present. Same call the bulk path makes for its whole group.
    if (journalled) db.clearPendingDeletes(accountId, mailbox, [realUid]);
    if (!isUnified) get().loadEmails();
  };

  if (isLocalOnly) {
    if (invoke) {
      try {
        await invoke('maildir_delete', { accountId, mailbox, uid });
        await invoke('local_index_remove', { accountId, mailbox, uid });
        console.log(`[deleteEmail] Local-only delete: UID ${uid} (${accountId}/${mailbox})`);
      } catch (err) {
        console.error(`[deleteEmail] Local-only delete FAILED for UID ${uid}:`, err);
        restoreRow();
        throw err;
      }
    }
  } else {
    account = await ensureFreshToken(account);
    console.log(`[deleteEmail] Deleting UID ${uid} from mailbox "${mailbox}" (account: ${account.email}, isGraph: ${isGraphAccount(account)}, override: ${mailboxOverride})`);
    try {
      if (isGraphAccount(account)) {
        const graphId = await resolveGraphMessageId(accountId, mailbox, uid, {
          row: candidate, token: account.oauth2AccessToken,
        });
        if (!graphId) throw new Error('Cannot delete: no Graph message ID found for this email.');
        await api.graphDeleteMessage(account.oauth2AccessToken, graphId);
      } else {
        await api.deleteEmail(account, uid, mailbox);
      }
      console.log(`[deleteEmail] Successfully deleted UID ${uid} from "${mailbox}"`);
    } catch (err) {
      console.error(`[deleteEmail] FAILED to delete UID ${uid} from "${mailbox}":`, err);
      restoreRow();
      throw err;
    }
  }

  if (journalled) await db.clearPendingDeletes(accountId, mailbox, [realUid]);

  await applyServerRemoval(uid, {
    accountId, mailbox, isUnified, skipRefresh,
    clearSelection: selectedEmailId === uid,
  });
}


// ── applyServerRemoval ──
//
// "The server does not hold this uid." Two callers with the same fact from
// different directions: the delete above, which just made it true, and
// selectEmail, which finds it out when a body fetch proves the message gone —
// a message deleted from another client leaves a row behind that errors on
// every click, and the row outlives the session because the header sidecar
// still has it.
//
// NOT a delete: nothing leaves the vault. An archived copy simply stops being
// shadowed by the server row and re-derives as `local-only` — "deleted from
// server" is a state this list already renders. Dropping the uid from a
// COMPLETE enumeration is what enables it (see withoutUids), and
// `removedUids` is what stops the sidecar re-hydrating the row on reload.
export async function applyServerRemoval(uid, {
  accountId, mailbox, isUnified = false, skipRefresh = false, clearSelection = true,
} = {}) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const filteredEmails = get().emails.filter(e => e.uid !== uid);
  const filteredSent = get().sentEmails.filter(e => e.uid !== uid);
  const newTotal = Math.max(0, (get().totalEmails || 0) - 1);
  const updates = {
    emails: filteredEmails,
    sentEmails: filteredSent,
    totalEmails: newTotal,
  };
  if (clearSelection) {
    updates.selectedEmailId = null;
    updates.selectedEmail = null;
    updates.selectedEmailSource = null;
    updates.selectedThread = null;
  }
  // The server confirmed this uid is gone, so take it out of the uid set too.
  // Only the active view's set — uids are per-mailbox, and the store holds one
  // mailbox's set at a time. See withoutUids for why loadEmails() below cannot
  // do this for us.
  if (!isUnified && accountId === get().activeAccountId && mailbox === get().activeMailbox) {
    updates.serverUids = withoutUids(get().serverUids, new Set([uid]));
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
    const graphId = await resolveGraphMessageId(accountId, mailbox, uid, { token: account.oauth2AccessToken });
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
    useMailStore.setState({ error: `Could not change the read status on the server. (${error.message})` });
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


// ── shared per-key context resolution ──
//
// Both delete workflows below need the same thing per selected key: unwind a
// unified-inbox composite key (or a plain uid) into the real uid, account,
// mailbox and — if we have one — the matching email object. `emailMap` and
// `sentPath` are supplied by the caller since each builds `emailMap` from a
// different set of arrays (see purgeEverywhere's comment on why it also
// includes `localEmails`).

function _resolveKeyContext(key, state, emailMap, sentPath) {
  const isUnified = state.activeMailbox === 'UNIFIED';
  const ctx = isUnified ? _resolveUnifiedContext(key, state) : null;
  const uid = ctx?.uid ?? key;
  const accountId = ctx?.accountId || state.activeAccountId;
  const emailObj = emailMap.get(key);
  const rawMailbox = ctx?.mailbox || (emailObj?._fromSentFolder && sentPath ? sentPath : state.activeMailbox);
  const mailbox = rawMailbox === 'UNIFIED' ? 'INBOX' : rawMailbox;
  const account = ctx?.account || state.accounts.find(a => a.id === accountId);
  return { uid, accountId, mailbox, account, emailObj, tombstone: `${accountId}|${mailbox}|${uid}` };
}


// ── deleteSelectedFromServer workflow ──


export async function deleteSelectedFromServer() {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const state = get();
  const { selectedEmailIds } = state;
  const isUnified = state.activeMailbox === 'UNIFIED';
  if (selectedEmailIds.size === 0) return;

  const keys = Array.from(selectedEmailIds);

  const sentPath = get().getSentMailboxPath();
  const allEmails = [...state.emails, ...state.sentEmails];
  const emailMap = new Map(allEmails.map(e => [isUnified ? _selKey(e) : e.uid, e]));
  const contextOf = (key) => _resolveKeyContext(key, state, emailMap, sentPath);

  // Journal the intent BEFORE anything else, and await it.
  //
  // Everything below runs in the webview: reload or quit inside the loop and
  // this context dies before the remaining commands are sent. The journal is
  // what lets the next launch finish the job (see replayPendingDeletes) — but
  // only if it actually reached disk first, and it is an async IPC racing the
  // very window it exists to cover.
  //
  // So it goes ahead of the optimistic update, not after it. That ordering is
  // the guarantee: the rows do not disappear until the delete is durable, so
  // from the moment the app shows the user a completed delete, it is one. The
  // other order lost the race outright — the row vanished, the app was
  // reloaded, and the write never landed.
  //
  // Graph accounts are skipped: their delete is addressed by a per-session
  // message id, not a UID, so a journalled uid is not something a later launch
  // could act on. Nothing is written rather than something unreplayable.
  const journalGroups = new Map();
  for (const key of keys) {
    const { uid, accountId, mailbox, account, emailObj } = contextOf(key);
    if (!account || isGraphAccount(account)) continue;
    if (emailObj?.source === 'local-only' || emailObj?._localStaged === true) continue;
    const groupKey = `${accountId}|${mailbox}`;
    if (!journalGroups.has(groupKey)) journalGroups.set(groupKey, { accountId, mailbox, uids: [] });
    journalGroups.get(groupKey).uids.push(uid);
  }
  await Promise.all([...journalGroups.values()].map(
    (g) => db.queuePendingDeletes(g.accountId, g.mailbox, g.uids),
  ));

  // Remove from the UI immediately — the server/maildir deletes below can take
  // seconds (pool checkout + one round-trip per email). The post-loop
  // loadEmails() reconcile restores anything whose server delete failed.
  const deletedKeySet = new Set(keys);
  const realUidSet = new Set(keys.map(k => (isUnified ? _resolveUnifiedContext(k, state)?.uid : k) ?? k));

  const newTombstones = new Set(state.deleteTombstones);
  for (const key of keys) newTombstones.add(contextOf(key).tombstone);

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
  // Uids deleted out of the mailbox currently on screen. Only these can be
  // pruned from the header sidecar here, because saveEmailHeaders rewrites a
  // mailbox's whole entry from the `emails` array passed to it — handing it the
  // active list while naming another mailbox would corrupt that mailbox's
  // cache. Deletes in other mailboxes (Sent) are pruned when those are next
  // loaded.
  const deletedInActiveMailbox = new Set();
  // Tombstones to lift once the server delete succeeds AND the message still
  // has a surviving local (archived) copy on disk — those rows must re-render
  // as "Local only" rather than staying hidden for the rest of the session.
  // A message with no local copy keeps its tombstone forever (see the
  // comment on the tombstone block above for why that half is load-bearing).
  const survivingLocalTombstones = new Set();

  const invoke = window.__TAURI__?.core?.invoke;

  for (const key of keys) {
    try {
      const { uid: realUid, accountId, mailbox, account: ctxAccount, emailObj, tombstone } = contextOf(key);

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

      const account = await ensureFreshToken(ctxAccount);

      if (isGraphAccount(account)) {
        // Not "skipping" — a Graph id we cannot establish means the delete did
        // not happen, and falling through to `deletedRealUids.add()` below
        // reported it as done: the row went away, the sidecar was pruned, and
        // the message sat on the server until the next reload put it back.
        // Throw into the catch, which lifts the tombstone and lets the
        // reconcile restore the row — the same contract as any failed delete.
        const graphId = await resolveGraphMessageId(accountId, mailbox, realUid, {
          row: emailObj, token: account.oauth2AccessToken,
        });
        if (!graphId) throw new Error(`No Graph message ID for UID ${realUid}`);
        await api.graphDeleteMessage(account.oauth2AccessToken, graphId);
      } else {
        await api.deleteEmail(account, realUid, mailbox);
      }
      deletedRealUids.add(realUid);
      if (!isUnified && mailbox === state.activeMailbox) deletedInActiveMailbox.add(realUid);
      if (!isUnified && get().archivedEmailIds.has(realUid)) {
        survivingLocalTombstones.add(tombstone);
      }
    } catch (e) {
      console.error(`Failed to delete email ${key}:`, e);
      // Lift the tombstone so the reconcile below can restore this email.
      const ts = new Set(get().deleteTombstones);
      ts.delete(contextOf(key).tombstone);
      useMailStore.setState({ deleteTombstones: ts });
    }
  }

  // Every uid above has now been attempted — the loop's own catch is what makes
  // that true even for the ones that failed. Clearing the whole batch (rather
  // than a uid at a time) keeps this to one small write instead of one per
  // message, and the only thing it gives up is that a crash mid-loop replays a
  // few already-deleted uids at launch, which the replay is written to shrug off.
  await Promise.all([...journalGroups.values()].map(
    (g) => db.clearPendingDeletes(g.accountId, g.mailbox, g.uids),
  ));

  // Prune the header sidecar for the rows just deleted.
  //
  // loadEmails() below cannot do this for us: it derives `removedUids` by
  // diffing the emails it had before against what the server returns, and the
  // optimistic update above already stripped these uids from `state.emails` —
  // so they are absent from both sides and never register as newly-gone. Left
  // unpruned, the session tombstone is the only thing hiding the row, and a
  // reload (which wipes tombstones — they are store state) repaints a message
  // that is gone from the server. deleteEmailFromServer has always pruned like
  // this for the single-row path; the bulk paths never did, which is why
  // deleting one row and deleting a selection behaved differently on reload.
  // Pin the identity: these uids were collected against the account/mailbox
  // that was active when the loop started, but the per-message server deletes
  // above take seconds and the user can switch view inside that window.
  //
  // Two halves, and BOTH matter:
  //   - the KEY and the uids always come from `state`, never from live state.
  //     Pruning the mailbox that happens to be on screen now, with uids from
  //     the one we deleted from, makes a row disappear from a mailbox nobody
  //     touched — uids are unique per mailbox, not globally.
  //   - the prune still runs when the view HAS moved; only the `emails`
  //     payload is dropped (an empty array writes no headers, and a null total
  //     leaves the stored one untouched). Skipping the prune outright was the
  //     first fix and it was wrong: by the comment above, loadEmails() cannot
  //     reconcile this later — the uid is absent from both sides of its diff —
  //     so the sidecar keeps the header forever, the session tombstone is the
  //     only thing hiding the row, and the next reload repaints a message that
  //     is gone from the server. Deleting and then switching account made a
  //     delete permanently fail to stick.
  if (!isUnified && deletedInActiveMailbox.size > 0) {
    const s = get();
    const viewUnmoved = s.activeAccountId === state.activeAccountId && s.activeMailbox === state.activeMailbox;
    // Same reasoning as the sidecar prune, for the in-memory uid set: these
    // uids are gone from the server and nothing downstream will take them out
    // (see withoutUids). Only when the view has not moved — the store holds
    // whatever mailbox is on screen now, and uids are per-mailbox.
    if (viewUnmoved) {
      useMailStore.setState({ serverUids: withoutUids(s.serverUids, deletedInActiveMailbox) });
    }
    await db.saveEmailHeaders(
      state.activeAccountId, state.activeMailbox,
      viewUnmoved ? s.emails : [],
      viewUnmoved ? s.totalEmails : null,
      { removedUids: [...deletedInActiveMailbox] },
    );
  }

  // Reconcile with the server: prunes the header cache and restores any email
  // whose delete failed (resilient over silently wrong).
  if (!isUnified) {
    await get().loadEmails();

    // Lift tombstones for messages whose local archive survived the server
    // delete, now that loadEmails() has refreshed serverUids (and
    // archivedEmailIds/localEmails, unchanged but re-confirmed) — lifting
    // any earlier risks a brief flash as "still on server" before the next
    // refresh corrects it.
    if (survivingLocalTombstones.size > 0) {
      const ts = new Set(get().deleteTombstones);
      for (const t of survivingLocalTombstones) ts.delete(t);
      useMailStore.setState({ deleteTombstones: ts });
      get().updateSortedEmails();
    }
  }
}


// ── purgeEverywhere workflow ──
//
// A message can live in three places: the IMAP server, the local vault Maildir,
// and the external backup mirror. Every existing delete verb touches exactly
// one of them, which is why deleting an archived message in Spam looks like a
// no-op — the server copy goes, the vault copy stays and re-renders.
//
// Order matters: server first, and a uid whose server delete FAILED keeps its
// local copies. Deleting the only backup of a message that is still sitting on
// the server is data loss the user never asked for; leaving a stale local copy
// is merely untidy, and the next reconcile fixes it.

export async function purgeEverywhere(keys, { onProgress } = {}) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const state = get();
  const isUnified = state.activeMailbox === 'UNIFIED';
  if (!keys?.length) return { deleted: 0, failed: 0, queuedBackup: 0, needsResync: 0 };

  const sentPath = get().getSentMailboxPath();
  // Includes localEmails (unlike deleteSelectedFromServer's emailMap) because
  // that's where a genuinely local-only row actually lives. localEmails goes
  // FIRST: `new Map(...)` keeps the last entry on a uid collision, and a
  // still-server-side archived row is a normal case in both `emails` and
  // `localEmails` at once (the local archive read can land before the server
  // window fills in). Provenance below already settles which *source* a uid
  // has — it's looked up by (accountId, mailbox, uid), not read off whichever
  // object wins this collision — but `_localStaged` is still read straight off
  // the winning object. Emails/sentEmails must win the collision so a stale
  // `_localStaged` duplicate sitting in `localEmails` can never masquerade as
  // the server-backed row's verdict.
  const allEmails = [...state.localEmails, ...state.emails, ...state.sentEmails];
  const emailMap = new Map(allEmails.map(e => [isUnified ? _selKey(e) : e.uid, e]));

  const contexts = keys.map(key => _resolveKeyContext(key, state, emailMap, sentPath));

  // Local-only is a claim about provenance, so prove it from provenance.
  // `source` on a store object is derived from `serverUids`, which is
  // window-derived on three load paths and empty during a restore paint — so
  // "absent from it" means "not seen yet", never "not on the server". Getting
  // this wrong in the local-only direction skips the server delete and destroys
  // both local copies of a message the server still has.
  // `'local'` in the index means archived FROM a server. Only `local_sent` /
  // `local_draft` were created here. Anything unproven gets a server delete
  // attempt, which is harmless when the UID is already gone: the permanent path
  // is STORE \Deleted + UID EXPUNGE and no-ops.
  const LOCALLY_CREATED = new Set(['local_sent', 'local_draft']);

  // Read provenance once per distinct (accountId, mailbox) pair in the target
  // set — this runs over bulk selections of thousands of uids, not once each.
  const groupKey = (accountId, mailbox) => JSON.stringify([accountId, mailbox]);
  const distinctGroups = new Map();
  for (const c of contexts) distinctGroups.set(groupKey(c.accountId, c.mailbox), { accountId: c.accountId, mailbox: c.mailbox });
  const provenanceByGroup = new Map(
    await Promise.all([...distinctGroups.entries()].map(async ([gk, { accountId, mailbox }]) =>
      [gk, await db.getLocalIndexProvenance(accountId, mailbox)]
    ))
  );

  const targets = contexts.map(({ uid, accountId, mailbox, account, emailObj, tombstone }) => {
    // `_localStaged` is sufficient proof on its own — the compose optimistic
    // entry has no index row yet.
    const provenance = provenanceByGroup.get(groupKey(accountId, mailbox))?.get(uid);
    const localOnly = emailObj?._localStaged === true || LOCALLY_CREATED.has(provenance);
    // `row` rides along for Graph: it carries `_graphId`, the only id stamped
    // from the same listing that assigned this uid its position.
    return { uid, accountId, mailbox, account, localOnly, tombstone, row: emailObj };
  }).filter(t => t.account || t.localOnly);

  // Optimistic removal, same shape as deleteSelectedFromServer — the deletes
  // below take seconds (now including a STATUS round trip) and the list must
  // not sit there looking untouched. Must run before the UIDVALIDITY guard,
  // not after: the guard is a network call and `state` here is a snapshot —
  // running the guard first would widen the window in which a row the store
  // gains mid-purge gets clobbered by the `emails: state.emails.filter(...)`
  // write below.
  const keySet = new Set(keys);
  const tombstones = new Set(state.deleteTombstones);
  for (const t of targets) tombstones.add(t.tombstone);
  useMailStore.setState({
    deleteTombstones: tombstones,
    selectedEmailIds: new Set(),
    emails: state.emails.filter(e => !keySet.has(isUnified ? _selKey(e) : e.uid)),
    sentEmails: state.sentEmails.filter(e => !keySet.has(isUnified ? _selKey(e) : e.uid)),
    totalEmails: Math.max(0, (state.totalEmails || 0) - keys.length),
  });
  get().updateSortedEmails();

  // ── UIDVALIDITY guard ──
  // Neither the vault nor local-index.json carries a UIDVALIDITY stamp. After
  // a server-side UID reissue (the change-server flow, or one the server
  // initiates on its own), a uid this mailbox holds for a SERVER delete can
  // now name an unrelated message: `t.uid` at the server-delete call below
  // would be spent against whatever the server put there instead.
  // headerMemo.js:131 and syncProbe.js:83 already refuse to trust a UID set
  // across a reissue; this is the same refusal before a uid gets spent there.
  //
  // Only targets headed for a server delete are gated. A proven local-only
  // target's purge touches local files under the uid it was archived/staged
  // under — no server round trip, so no server UID space to have been
  // reissued out from under it; gating it too would make deleting an
  // offline-composed message a permanent failure for an operation that
  // touches no server at all. Graph accounts are exempt outright: Graph
  // deletes address messages by Graph id (resolveGraphMessageId), never by IMAP
  // uid, so there is no UID space here to poison in the first place.
  //
  // One STATUS round trip per (accountId, mailbox) group, not per message.
  const uvGroups = new Map();
  for (const t of targets) {
    if (t.localOnly) continue;
    const gk = groupKey(t.accountId, t.mailbox);
    if (!uvGroups.has(gk)) uvGroups.set(gk, { accountId: t.accountId, mailbox: t.mailbox, account: t.account, items: [] });
    const g = uvGroups.get(gk);
    g.items.push(t);
    if (!g.account) g.account = t.account;
  }

  const untrustedTargets = new Set();
  let needsResync = 0;
  await Promise.all([...uvGroups.values()].map(async (g) => {
    if (isGraphAccount(g.account)) return; // no UID space to poison — trusted without a STATUS call
    let trusted = false;
    try {
      const account = g.account ? await ensureFreshToken(g.account) : null;
      const [meta, status] = await Promise.all([
        db.getEmailHeadersMeta(g.accountId, g.mailbox),
        account ? api.checkMailboxStatus(account, g.mailbox) : Promise.resolve(null),
      ]);
      const cachedUV = meta?.uidValidity;
      const liveUV = status?.uidValidity;
      trusted = cachedUV != null && liveUV != null && cachedUV === liveUV;
    } catch (e) {
      console.warn(`[purgeEverywhere] UIDVALIDITY check failed for ${g.accountId}/${g.mailbox}:`, e);
    }
    if (!trusted) {
      needsResync += g.items.length;
      for (const t of g.items) untrustedTargets.add(t);
    }
  }));

  // ── Phase 1: server ──
  onProgress?.({ phase: 'delete', total: targets.length, completed: 0 });
  const purgeable = [];
  let failed = 0;

  for (const t of targets) {
    if (untrustedTargets.has(t)) {
      // UIDVALIDITY guard tripped for this uid's group: skip the server
      // delete AND the vault/backup purge below — never spend an untrusted
      // uid on any of the three. Lift the tombstone so the reconcile
      // restores the row, same contract as an ordinary failed server delete.
      failed++;
      const ts = new Set(get().deleteTombstones);
      ts.delete(t.tombstone);
      useMailStore.setState({ deleteTombstones: ts });
    } else if (t.localOnly) {
      purgeable.push(t);
    } else {
      try {
        const account = await ensureFreshToken(t.account);
        if (isGraphAccount(account)) {
          const graphId = await resolveGraphMessageId(t.accountId, t.mailbox, t.uid, {
            row: t.row, token: account.oauth2AccessToken,
          });
          if (!graphId) throw new Error(`No Graph ID for UID ${t.uid}`);
          await api.graphDeleteMessage(account.oauth2AccessToken, graphId);
        } else {
          await api.deleteEmail(account, t.uid, t.mailbox);
        }
        purgeable.push(t);
      } catch (e) {
        console.error(`[purgeEverywhere] Server delete failed for ${t.uid}:`, e);
        failed++;
        // Lift the tombstone so the trailing reconcile restores this row, and
        // leave its local copies alone — they are now the only copies but one.
        const ts = new Set(get().deleteTombstones);
        ts.delete(t.tombstone);
        useMailStore.setState({ deleteTombstones: ts });
      }
    }
    onProgress?.({ phase: 'delete', total: targets.length, completed: purgeable.length });
  }

  // ── Phases 2 and 3: vault, then backup — batched per (account, mailbox) ──
  const groups = new Map();
  for (const t of purgeable) {
    const gk = `${t.accountId}|${t.mailbox}`;
    if (!groups.has(gk)) groups.set(gk, { accountId: t.accountId, mailbox: t.mailbox, account: t.account, uids: [] });
    groups.get(gk).uids.push(t.uid);
  }

  let queuedBackup = 0;
  for (const g of groups.values()) {
    onProgress?.({ phase: 'vault', total: g.uids.length, completed: 0 });
    try {
      await api.maildirDeleteMany(g.accountId, g.mailbox, g.uids);
    } catch (e) {
      console.error('[purgeEverywhere] Vault purge failed:', e);
    }

    onProgress?.({ phase: 'backup', total: g.uids.length, completed: 0 });
    try {
      const email = g.account?.email || state.accounts.find(a => a.id === g.accountId)?.email;
      if (email) {
        const res = await api.backupPurgeUids(email, g.mailbox, g.uids);
        queuedBackup += res?.queued || 0;
      }
    } catch (e) {
      console.error('[purgeEverywhere] Backup purge failed:', e);
    }
  }

  // savedEmailIds/archivedEmailIds/localEmails are single-mailbox-scoped store
  // fields — refreshing more than one group would just have the last write
  // clobber the rest, not "cover" every group. Refresh only the group that
  // matches the currently active (account, mailbox); skip entirely if the
  // active view wasn't touched by this purge.
  const activeMailboxKey = state.activeMailbox === 'UNIFIED' ? 'INBOX' : state.activeMailbox;
  const activeGroup = groups.get(`${state.activeAccountId}|${activeMailboxKey}`);
  if (activeGroup) {
    const [savedEmailIds, archivedEmailIds, localEmails] = await Promise.all([
      db.getSavedEmailIds(activeGroup.accountId, activeGroup.mailbox),
      db.getArchivedEmailIds(activeGroup.accountId, activeGroup.mailbox),
      db.getLocalEmails(activeGroup.accountId, activeGroup.mailbox),
    ]);
    useMailStore.setState({ savedEmailIds, archivedEmailIds, localEmails });
  }
  get().updateSortedEmails();

  // Prune the header sidecar for the rows just purged — same reason as in
  // deleteSelectedFromServer: the optimistic update already stripped these uids
  // from `state.emails`, so loadEmails()'s prior-vs-server diff never sees them
  // as newly-gone and leaves the sidecar entry behind. The session tombstone
  // then hides the row only until a reload, after which a message purged from
  // the server, the vault and the backup mirror reappears from cache.
  //
  // Only the active mailbox's group: saveEmailHeaders rewrites a mailbox's
  // whole entry from the `emails` passed to it, so naming another mailbox while
  // handing it the active list would corrupt that mailbox's cache.
  // Pin the identity: `activeGroup.uids` belongs to the mailbox this purge ran
  // against, while `s.emails` is whatever is on screen NOW — the purge spans
  // seconds of server, vault and backup awaits, and the user can switch account
  // or folder inside that window. Writing one with the other hands a different
  // account's cache a foreign uid list, and a row vanishes from a mailbox
  // nobody deleted from (uids collide freely across accounts — they are only
  // unique per mailbox).
  //
  // When the view HAS moved, drop the payload but still prune: an empty
  // `emails` writes no headers and a null total leaves the stored one alone,
  // so nothing foreign lands in this mailbox's cache — while the uids that
  // were genuinely purged still go away. "Skip and let it reconcile later" was
  // the first fix and it does not hold: per the paragraph above, loadEmails()
  // never sees these uids as newly-gone, so the sidecar keeps them forever.
  if (!isUnified && activeGroup?.uids.length) {
    const s = get();
    const viewUnmoved = s.activeAccountId === activeGroup.accountId && s.activeMailbox === activeGroup.mailbox;
    await db.saveEmailHeaders(
      activeGroup.accountId, activeGroup.mailbox,
      viewUnmoved ? s.emails : [],
      viewUnmoved ? s.totalEmails : null,
      { removedUids: [...activeGroup.uids] },
    );
  }

  if (!isUnified) get().loadEmails();

  return { deleted: purgeable.length, failed, queuedBackup, needsResync };
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
      const rowOf = (uid) => state.emails.find(e => e.uid === uid) || state.sentEmails.find(e => e.uid === uid);
      const messageIds = (await Promise.all(uids.map(uid => resolveGraphMessageId(
        activeAccountId, activeMailbox, uid, { row: rowOf(uid), token: account.oauth2AccessToken },
      )))).filter(Boolean);
      if (messageIds.length !== uids.length) {
        throw new Error('Cannot move: no Graph message ID for some of the selected emails.');
      }

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
