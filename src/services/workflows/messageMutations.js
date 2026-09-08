// ── messageMutations workflow — archive, delete, mark, move, export ──

import * as db from '../db';
import * as api from '../api';
import { useSettingsStore } from '../../stores/settingsStore';
import { ensureFreshToken } from '../authUtils';
import { isGraphAccount, graphMessageToEmail } from '../graphConfig';
import { resolveGraphMessageId } from '../cacheManager';
import { _resolveUnifiedContext, requireUnifiedContext, _selKey, _parseSelKey, spansMailboxes, resolveEmailLocation, emailScopeKey, selectionKey, pruneSelectedThread, nextAfterRemoval } from '../../stores/slices/unifiedHelpers';
import { filterUnread } from '../../utils/emailParser';
import { bumpFlagChangeCounter } from '../../stores/slices/messageListSlice';
import { useConnectivityStore } from '../../stores/connectivityStore';
import { withoutUids } from '../../stores/slices/serverUids';
import { mailboxLabel } from '../../utils/imapUtf7';
// Aliased: this module binds `t` locally (tombstone loop vars), which
// would shadow the catalog lookup inside those callbacks.
import { t as tr } from '../../i18n/index.js';


/**
 * A failure that says "try again later", not "this mutation cannot be applied".
 *
 * The journal replay clears an entry once attempted — a uid that fails twice
 * fails forever — so this is the one class of failure that has to keep it.
 */
export const isCredentialsProblem = (message) =>
  /password missing|no password|authentication|auth failed|login failed|credential/i.test(message || '');


/**
 * Reload the list that is actually on screen.
 *
 * `loadEmails()` reloads one (account, mailbox) — and a branch listing, via
 * loadSubtree. It knows nothing about the unified view, where `activeMailbox`
 * is the literal 'UNIFIED': no account can SELECT that, which is why every
 * other reload in this file is guarded with `if (!isUnified)`.
 *
 * The three that were not guarded are exactly the ones that put rows BACK — an
 * undo, and the repaint after a move. Taking rows out hides that: the
 * optimistic update already did what the user asked, so a reload of a folder
 * that does not exist changes nothing visible. Putting one back needs the
 * reload to land, and in All Inboxes it never did: the message returned to the
 * server and the row stayed off the screen.
 *
 * `refreshCurrentView` is the one verb that knows all three view shapes. The
 * workflow, not the store action of the same name — that one throttles to a
 * run per 15 s, and an undo that repaints a quarter of a minute later is the
 * same bug wearing a timer.
 */
export async function reloadListInView() {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();
  if (get().activeMailbox !== 'UNIFIED') return get().loadEmails();
  // A cache-merge repaint (loadUnifiedInbox alone) would bring the row back
  // carrying the uid the delete retired — the move back gave the message a new
  // one. The accounts have to be refetched for the row to be clickable.
  const { refreshCurrentView } = await import('./refreshAccounts');
  return refreshCurrentView();
}


// One message as local-index.json stores it. `local_index_append` upserts by
// uid, so this doubles as the shape any later writer has to preserve — see
// markServerDeleted, which re-appends an entry to add one field.
export function indexEntryFor(email, extra = {}) {
  return {
    uid: email.uid,
    from: email.from,
    to: email.to,
    subject: email.subject,
    date: email.date,
    flags: email.flags || [],
    has_attachments: email.hasAttachments || email.has_attachments || false,
    message_id: email.messageId || email.message_id || null,
    in_reply_to: email.inReplyTo || email.in_reply_to || null,
    references: email.references || null,
    snippet: email.snippet || '',
    source: 'local',
    ...extra,
  };
}


// Maildir flags for a fresh vault copy: archived, plus whatever the server
// says about read state. `seen` used to be hardcoded, which is where every
// downstream lie about a vault message's read state began — the file name is
// what restore uploads, what the mirror copies, and what a vault row reads.
export const vaultStoreFlags = (flags = []) => [
  'archived',
  ...(flags.includes('\\Seen') ? ['seen'] : []),
  ...(flags.includes('\\Flagged') ? ['flagged'] : []),
  ...(flags.includes('\\Answered') ? ['replied'] : []),
];


// ── saveEmailLocally workflow ──

export async function saveEmailLocally(uid) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const state = get();
  const isUnified = spansMailboxes(state);
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
        throw new Error(tr('errors.noRawSource'));
      }

      const invoke = window.__TAURI__?.core?.invoke;
      await invoke('maildir_store', {
        accountId: accountId,
        mailbox: mailbox,
        uid: email.uid,
        rawSourceBase64: email.rawSource,
        flags: vaultStoreFlags(email.flags),
      });
    }

    try {
      const emailData = get().emails?.find(e => e.uid === uid) || get().sortedEmails?.find(e => e.uid === uid);
      if (emailData) {
        await api.appendLocalIndex(accountId, mailbox, [indexEntryFor(emailData)]);
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
    useMailStore.setState({ error: tr('svc.messageMutations.couldCopyEmailIntoVault', { error: error.message }) });
    throw error;
  }
}


// ── saveEmailsLocally workflow ──
//
// Takes ROWS, not uids. A uid names a message only inside one mailbox of one
// account, and the rows a thread or a selection hands over do not all live in
// the view's: the all-inboxes list mixes every account under the placeholder
// mailbox 'UNIFIED', and a single folder's list merges Sent copies in. Reading
// the location off the view sent every one of those to `archive_emails` under
// the last-activated account and a mailbox no server has — "Archived with 3
// error(s)" on a thread opened from All Inboxes. Each row resolves its own
// location and the run is one archive per (account, mailbox). A row whose
// location cannot be resolved is skipped: a guessed folder archives a different
// message under this uid.

export async function saveEmailsLocally(rows) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const state = get();
  const groups = new Map();
  for (const row of rows || []) {
    const loc = row?.uid != null ? resolveEmailLocation(row, state) : null;
    if (!loc) continue;
    const key = `${loc.accountId}|${loc.mailbox}`;
    if (!groups.has(key)) groups.set(key, { ...loc, uids: [] });
    groups.get(key).uids.push(row.uid);
  }
  if (groups.size === 0) return;

  const tally = { total: [...groups.values()].reduce((n, g) => n + g.uids.length, 0), completed: 0, errors: 0 };
  useMailStore.setState({ bulkSaveProgress: { ...tally, active: true } });
  for (const group of groups.values()) {
    // Cancel clears the progress object (accountSlice.cancelBulkSave).
    if (!get().bulkSaveProgress) return;
    await _archiveGroup(useMailStore, group, tally);
  }
  if (!get().bulkSaveProgress) return;
  useMailStore.setState({ bulkSaveProgress: { ...tally, active: false } });
  if (!window.__TAURI__?.core?.invoke) {
    setTimeout(() => useMailStore.setState({ bulkSaveProgress: null }), 3000);
  }
}

// One (account, mailbox) of a saveEmailsLocally run. `tally` is the whole run's
// count: progress is painted as run totals, so a thread spanning two folders
// reads as one archive, not two that each restart at zero.
async function _archiveGroup(useMailStore, { accountId, mailbox, uids }, tally) {
  const get = () => useMailStore.getState();
  let account = get().accounts.find(a => a.id === accountId);
  if (!account) {
    tally.errors += uids.length;
    return;
  }
  account = await ensureFreshToken(account);

  const base = { completed: tally.completed, errors: tally.errors };
  const paint = (completed, errors) => {
    tally.completed = base.completed + completed;
    tally.errors = base.errors + errors;
    useMailStore.setState({ bulkSaveProgress: { ...tally, active: true } });
  };
  // `archivedEmailIds` is keyed by bare uid, so a group that is not the
  // folder on screen must not paint into it: INBOX's own message under a Sent
  // copy's uid would read as archived. A list spanning mailboxes holds the
  // union and takes every group.
  const s0 = get();
  const paintsIds = spansMailboxes(s0) || (accountId === s0.activeAccountId && mailbox === s0.activeMailbox);

  const invoke = window.__TAURI__?.core?.invoke;
  if (invoke) {
    console.log('[saveEmailsLocally] Starting Tauri archive for', uids.length, 'UIDs in', accountId, mailbox);

    let unlisten;
    try {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen('archive-progress', (event) => {
        const p = event.payload;
        const current = get().bulkSaveProgress;
        if (current && !current.active) return;

        paint(p.completed, p.errors);

        if (p.lastUid && paintsIds) {
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
        accountId,
        accountJson: JSON.stringify(account),
        mailbox,
        uids,
      });

      if (unlisten) { unlisten(); unlisten = null; }

      console.log('[saveEmailsLocally] invoke result:', JSON.stringify(result));
      paint(result?.completed ?? uids.length, result?.errors ?? 0);
      await _foldVaultGroup(useMailStore, { accountId, mailbox, account });
    } catch (err) {
      console.error('[saveEmailsLocally] archive_emails failed:', err);
      paint(0, uids.length);
    } finally {
      if (unlisten) unlisten();
    }
    return;
  }

  const cacheLimitMB = useSettingsStore.getState().cacheLimitMB;
  const emails = [];
  let completed = 0;
  let errors = 0;

  for (const uid of uids) {
    if (!get().bulkSaveProgress) break;

    try {
      const email = await api.fetchEmail(account, uid, mailbox);
      get().addToCache(`${accountId}-${mailbox}-${uid}`, email, cacheLimitMB);
      emails.push(email);
      completed++;
    } catch (error) {
      console.error(`Failed to fetch email ${uid}:`, error);
      errors++;
    }
    paint(completed, errors);
  }

  if (!get().bulkSaveProgress) return;

  if (emails.length > 0) {
    await db.saveEmails(emails, accountId, mailbox);
    await _foldVaultGroup(useMailStore, { accountId, mailbox, account });
  }
}

// Re-read the vault sets for the (account, mailbox) a write just landed in and
// fold them into the view. A single folder's list holds one mailbox's sets, so
// only its own pair is refreshed — another folder's ids would collide by bare
// uid. A list spanning mailboxes holds the union (see loadUnifiedInbox), so the
// group's ids are added and its slice of `localEmails` replaced, stamped the
// way that loader stamps them.
async function _foldVaultGroup(useMailStore, { accountId, mailbox, account }) {
  const get = () => useMailStore.getState();
  const state = get();
  const spans = spansMailboxes(state);
  if (!spans && (accountId !== state.activeAccountId || mailbox !== state.activeMailbox)) return;

  const [saved, archived] = await Promise.all([
    db.getSavedEmailIds(accountId, mailbox),
    db.getArchivedEmailIds(accountId, mailbox),
  ]);
  let locals = await db.readLocalEmailIndex(accountId, mailbox);
  if (!locals) locals = await db.getLocalEmails(accountId, mailbox);

  if (!spans) {
    useMailStore.setState({ savedEmailIds: saved, archivedEmailIds: archived, localEmails: locals });
    get().updateSortedEmails();
    return;
  }

  const s = get();
  const own = (e) => (e._accountId || s.activeAccountId) === accountId && (e._mailbox || 'INBOX') === mailbox;
  useMailStore.setState({
    savedEmailIds: new Set([...s.savedEmailIds, ...saved]),
    archivedEmailIds: new Set([...s.archivedEmailIds, ...archived]),
    localEmails: [
      ...(s.localEmails || []).filter(e => !own(e)),
      ...locals.map(e => ({ ...e, _accountEmail: account?.email, _accountId: accountId, _mailbox: mailbox })),
    ],
  });
  get().updateSortedEmails();
}


// ── saveSelectedLocally workflow ──

export async function saveSelectedLocally() {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const state = get();
  const { selectedEmailIds } = state;
  if (selectedEmailIds.size === 0) return;
  const keys = Array.from(selectedEmailIds);
  useMailStore.setState({ selectedEmailIds: new Set() });
  // Each key names its own account and folder (a full key), or the view's (a
  // bare uid) — the same reading every other selection workflow does.
  const emailMap = new Map([...state.emails, ...(state.localEmails || []), ...(state.sentEmails || [])]
    .map(e => [selectionKey(e, state), e]));
  const rows = [];
  for (const key of keys) {
    const ctx = _resolveKeyContext(key, state, emailMap, { require: false });
    if (!ctx) {
      console.warn('[saveSelectedLocally] skipped a row that names no account:', key);
      continue;
    }
    rows.push({ uid: ctx.uid, _accountId: ctx.accountId, _mailbox: ctx.mailbox });
  }
  await get().saveEmailsLocally(rows);
}


// ── removeLocalEmail workflow ──

export async function removeLocalEmail(uid) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const state = get();
  const isUnified = spansMailboxes(state);
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


// ── what stays open after a delete ──
//
// Off by default (settings.behavior.afterDeleting): opening the next message
// the moment you delete one also marks it read, which is a decision the user
// opts into rather than inherits.
//
// On, it reads the list the user can actually SEE — with the unread filter on
// `sortedEmails` still holds every loaded message, and selecting one of those
// opens a row that is not on screen. Same reading as App.jsx's j/k step.
// Called before the rows are removed, because the open row is what places the
// cursor.
function _openAfterDelete(state, isOpenRow, isRemoved) {
  if (useSettingsStore.getState().afterDeleteSelect !== 'next') return null;
  const keyOf = (e) => selectionKey(e, state);
  const visible = filterUnread(state.sortedEmails, state.unreadOnly, state.selectedEmailId, keyOf);
  return nextAfterRemoval(visible, isOpenRow, isRemoved);
}


// ── deleteEmailFromServer workflow ──

export async function deleteEmailFromServer(uid, { skipRefresh = false, mailboxOverride = null } = {}) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const state = get();
  const isUnified = spansMailboxes(state);
  const unified = isUnified ? requireUnifiedContext(uid, state) : null;
  const accountId = unified?.accountId || state.activeAccountId;
  const rawMb = mailboxOverride || unified?.mailbox || state.activeMailbox;
  const mailbox = rawMb === 'UNIFIED' ? 'INBOX' : rawMb;
  let account = unified?.account || state.accounts.find(a => a.id === accountId);
  const selectedEmailId = state.selectedEmailId;
  if (!account) { console.error('[deleteEmail] No account found for', accountId); return; }

  // The uid the server knows. In a spanning view the argument is a whole
  // selection key ("acct:INBOX:7"), and everything below — the row lookup, the
  // journal, the tombstone, the network call, the custody stamp — addresses a
  // message by number inside one (account, mailbox).
  const realUid = unified?.uid ?? uid;

  // Local-only short-circuit: if this UID belongs to an email that only
  // exists in Maildir + local-index (never confirmed server-side), route to
  // the local delete path. Otherwise the server delete would error on the
  // pseudo-UID and the entry would re-hydrate on next loadEmails.
  // Matched on the resolved uid and, in a spanning view, on the account and
  // folder this delete is aimed at: keyed by the raw key it matches no row at
  // all, and a bare uid matches any account's row carrying that number.
  const candidate = [...(state.emails || []), ...(state.sentEmails || [])].find(e => e.uid === realUid
    && (!isUnified || (e._accountId === accountId && (e._mailbox == null || e._mailbox === mailbox))));
  const isLocalOnly = candidate?.source === 'local-only' || candidate?._localStaged === true;

  const invoke = window.__TAURI__?.core?.invoke;
  // Where the message ended up, for a caller that wants to offer an undo.
  // Stays undefined for the paths that have nothing to address: local-only,
  // Graph (no uid the server would take back), and an offline journalled row.
  let outcome;

  // Journal the intent first, and await it — same reason and same ordering as
  // deleteSelectedFromServer: the row is about to vanish from the list, so a
  // reload or quit before the server answers must leave something the next
  // launch can finish (replayOps). Skipped for Graph (its delete is addressed
  // by a per-session message id, not a replayable uid) and for local-only rows
  // (no server delete to replay).
  const journalled = !isLocalOnly && !isGraphAccount(account);
  if (journalled) await db.queueOp({ op: 'delete', accountId, mailbox, uids: [realUid] });
  // Offline the journal entry IS the delete: replayOps sends it when the link
  // is back, and its completion path prunes the sidecar and stamps custody.
  const offline = journalled && !useConnectivityStore.getState().online;

  // ── Optimistic removal ──
  // Take the row out now. Everything below is a network round trip (pool
  // checkout, STORE + EXPUNGE, or a Graph id lookup) and takes seconds; a list
  // that sits there unchanged while a modal spins is the same UI the bulk
  // paths already refuse to show (deleteSelectedFromServer, purgeEverywhere).
  // The tombstone stops a stale header cache re-rendering the row in the
  // meantime; a failed delete lifts it again and reloads, which puts the row
  // back — exactly the contract the bulk paths use.
  const tombstone = `${accountId}|${mailbox}|${realUid}`;
  // The folder is part of the identity, exactly as in applyServerRemoval's
  // `sameMessage`: a thread and the unified list both merge INBOX with Sent,
  // and the two share uids — without it, deleting the INBOX copy took the Sent
  // row off the list too.
  const isThisEmail = (e) => (isUnified
    ? _selKey(e) === String(uid)
      || (e._accountId === accountId && e.uid === realUid && (e._mailbox == null || e._mailbox === mailbox))
    : e.uid === uid);
  // The open thread is a snapshot; take the message out of it too, and close
  // the reader only when nothing is left (pruneSelectedThread). Matched by
  // folder wherever the row can say where it lives: a thread merges INBOX with
  // Sent, and the two share uids.
  const isThisMessage = (e) => {
    const loc = resolveEmailLocation(e, state);
    return loc ? e.uid === realUid && loc.accountId === accountId && loc.mailbox === mailbox : isThisEmail(e);
  };
  const threadUpdate = pruneSelectedThread(state, isThisMessage);
  // Only a delete that CLOSES the reader hands it a new message: a thread with
  // messages left keeps the one pruneSelectedThread moved to.
  const closedReader = threadUpdate
    ? threadUpdate.selectedThread === null
    : (selectedEmailId === uid || selectedEmailId === realUid);
  const openNext = closedReader ? _openAfterDelete(state, isThisEmail, isThisEmail) : null;
  useMailStore.setState({
    deleteTombstones: new Set(state.deleteTombstones).add(tombstone),
    emails: state.emails.filter(e => !isThisEmail(e)),
    sentEmails: state.sentEmails.filter(e => !isThisEmail(e)),
    selectedEmailIds: new Set([...state.selectedEmailIds].filter(k => k !== uid && k !== realUid)),
    ...(threadUpdate ?? (selectedEmailId === uid || selectedEmailId === realUid
      ? { selectedEmailId: null, selectedEmail: null, selectedEmailSource: null, selectedThread: null }
      : {})),
  });
  get().updateSortedEmails();
  // Now, not after the round trip: the reader is empty from this paint, and a
  // message that appears seconds later reads as a bug. A delete the server
  // refuses restores the row, not the reader — the same trade the optimistic
  // removal above already makes.
  if (openNext) get().selectEmail(selectionKey(openNext, state));

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
    if (journalled) db.clearOps({ op: 'delete', accountId, mailbox, uids: [realUid], arg: {} });
    // The open thread was pruned optimistically too: put the message back, or
    // the row the reload restores counts one more than the reader shows. Only
    // while that pruned thread is still what is open — a reader the user has
    // since moved on from is not this delete's to reopen.
    const cur = get();
    if (threadUpdate && cur.selectedThread === threadUpdate.selectedThread && cur.selectedEmailId === threadUpdate.selectedEmailId) {
      useMailStore.setState({ selectedThread: state.selectedThread, selectedEmailId });
    }
    if (!isUnified) get().loadEmails();
  };

  if (isLocalOnly) {
    if (invoke) {
      try {
        await invoke('maildir_delete', { accountId, mailbox, uid: realUid });
        await invoke('local_index_remove', { accountId, mailbox, uid: realUid });
        console.log(`[deleteEmail] Local-only delete: UID ${realUid} (${accountId}/${mailbox})`);
      } catch (err) {
        console.error(`[deleteEmail] Local-only delete FAILED for UID ${realUid}:`, err);
        restoreRow();
        throw err;
      }
    }
  } else {
    // The row is already hidden by its tombstone, which is what the user was
    // promised. Stop here: the journal entry carries the rest, and the replay's
    // completion path owns the sidecar prune and the custody stamp — running
    // applyServerRemoval now would claim a server delete that has not happened.
    if (offline) {
      console.log(`[deleteEmail] offline — UID ${realUid} journalled, replayOps will finish it`);
      return undefined;
    }
    account = await ensureFreshToken(account);
    // `realUid`, not the argument: in a spanning view the caller hands us a
    // whole selection key ("acct:INBOX:7"), and the server takes a uid.
    console.log(`[deleteEmail] Deleting UID ${realUid} from mailbox "${mailbox}" (account: ${account.email}, isGraph: ${isGraphAccount(account)}, override: ${mailboxOverride})`);
    try {
      if (isGraphAccount(account)) {
        const graphId = await resolveGraphMessageId(accountId, mailbox, realUid, {
          row: candidate, token: account.oauth2AccessToken,
        });
        if (!graphId) throw new Error(tr('errors.noGraphIdDelete'));
        await api.graphDeleteMessage(account.oauth2AccessToken, graphId);
      } else {
        const res = await api.deleteEmail(account, realUid, mailbox);
        // Where it went, so a caller can offer an undo instead of a SEARCH:
        // both null for a permanent delete, and for a server that reported no
        // COPYUID — never a guessed uid.
        outcome = {
          account, accountId, mailbox, uid: realUid,
          trash: res?.trash ?? null, trashUid: res?.trashUid ?? null,
          // The only handle left when the server reports no COPYUID — same
          // fallback the move undo uses. See setDeleteUndo.
          messageId: candidate?.messageId ?? null,
        };
      }
      console.log(`[deleteEmail] Successfully deleted UID ${realUid} from "${mailbox}"`);
    } catch (err) {
      console.error(`[deleteEmail] FAILED to delete UID ${realUid} from "${mailbox}":`, err);
      restoreRow();
      throw err;
    }
  }

  if (journalled) await db.clearOps({ op: 'delete', accountId, mailbox, uids: [realUid], arg: {} });

  await applyServerRemoval(realUid, {
    accountId, mailbox, isUnified, skipRefresh,
    // Never over a message this delete just opened.
    clearSelection: !threadUpdate && selectedEmailId === uid && !openNext,
    deletedByUs: true,
  });

  // `skipRefresh` means a caller is deleting a set one message at a time (the
  // row menu's thread delete): a slot per call would describe the last message
  // and strand the rest, so those callers collect the outcomes and fill the
  // slot once themselves.
  //
  // `outcome` exists exactly where something is addressable — never for a
  // local-only row, a Graph delete (it lands in Deleted Items, so "deleted
  // permanently" would be a false claim, and there is no uid to restore by) or
  // an offline journalled one, which returns before here.
  if (!skipRefresh) await setDeleteUndo(outcome ? [outcome] : []);

  return outcome;
}

/**
 * One slot for a delete, however many messages it took.
 *
 * Restorable wins over permanent: a mixed batch offers the undo for what CAN
 * come back rather than reporting the half that cannot and leaving the rest
 * stranded. An empty list sets nothing — a local-only, Graph or offline delete
 * has nothing addressable, and leaves the previous slot alone.
 *
 * Exported because the row menu deletes each copy of a thread row separately
 * (`skipRefresh`) and offers the whole row back in one go.
 */
export async function setDeleteUndo(outcomes) {
  const { useMailStore } = await import('../../stores/mailStore');
  // Addressable, not necessarily by uid. A server without UIDPLUS reports no
  // COPYUID, so `trashUid` is null for a message that is sitting in Trash and
  // is perfectly restorable — offering nothing there told the user their mail
  // was gone for good, under the word "permanently", and left it in the bin.
  // The Message-ID is the handle in that case, exactly as it is for a move
  // (see _resolveDestinationUids). Only a delete that resolved NO trash folder
  // is truly permanent.
  const restorable = (outcomes || []).filter(o => o?.trashUid != null || (o?.trash && o?.messageId));
  if (restorable.length) {
    useMailStore.getState().setUndo({
      labelKey: 'undo.deleted',
      labelParams: { count: restorable.length },
      run: () => _restoreFromTrash(restorable),
    });
  } else if (outcomes?.length) {
    useMailStore.getState().setUndo({
      labelKey: 'undo.deletedPermanently',
      labelParams: { count: outcomes.length },
      canUndo: false,
    });
  }
}

// Put the messages back where they were deleted from — one IMAP move per
// (account, Trash, source folder), not one per message.
async function _restoreFromTrash(outcomes) {
  const { useMailStore } = await import('../../stores/mailStore');
  const groups = new Map();
  for (const o of outcomes) {
    const k = `${o.accountId}|${o.trash}|${o.mailbox}`;
    if (!groups.has(k)) groups.set(k, { ...o, trashUids: [], uids: [], messageIds: [] });
    groups.get(k).trashUids.push(o.trashUid);
    groups.get(k).uids.push(o.uid);
    groups.get(k).messageIds.push(o.messageId);
  }
  // A throw on the second group must still repaint what the first one restored.
  try {
    for (const g of groups.values()) {
      const account = await ensureFreshToken(g.account);
      // Without UIDPLUS the server named no destination uid, so find the copy
      // by Message-ID in the folder it was moved to — never a guessed uid,
      // which would move somebody else's message back.
      const known = g.trashUids.filter(u => u != null);
      const trashUids = known.length === g.uids.length
        ? known
        : await _resolveDestinationUids(account, g.trash, g.messageIds);
      // Bare: runUndo already says "Undo failed: {{err}}" around whatever this
      // throws, and saying it twice reads as a bug.
      if (!trashUids.length) throw new Error(g.trash);
      await api.moveEmails(account, trashUids, g.trash, g.mailbox);
      // The vault copy was stamped "we deleted the server copy" a moment ago
      // (markServerDeleted / applyServerRemoval); it is back, so custody must
      // stop claiming this is the only copy left. See stores/slices/custody.js.
      for (const uid of g.uids) await stampVaultEntry(g.accountId, g.mailbox, uid, { serverDeleted: false });
      // The restored message gets a NEW uid in the source folder, so the old
      // tombstone would not hide it — but a tombstone naming a uid that is no
      // longer deleted is a lie the next reconcile has to work around.
      const ts = new Set(useMailStore.getState().deleteTombstones);
      for (const uid of g.uids) ts.delete(`${g.accountId}|${g.mailbox}|${uid}`);
      useMailStore.setState({ deleteTombstones: ts });
    }
  } finally {
    await reloadListInView();
  }
}


// Write custody fields onto the vault's index entry for one message.
//
// `local_index_append` upserts by uid, so re-appending the existing entry with
// the extra fields is the whole write — no Rust change, and the entry keeps its
// own `source` ('local' / 'local_sent' / 'local_draft'), which custody reads
// separately as `_origin`.
//
// Every gold claim goes through here, because every gold claim has to survive a
// reload: an in-memory stamp dies with the session and the row goes quiet again
// on the next launch, which is the same silence the bug produced.
//
// @returns {Promise<boolean>} whether the stamp reached disk.
export async function stampVaultEntry(accountId, mailbox, uid, extra) {
  if (!accountId || !mailbox || uid == null) return false;
  try {
    const entry = await db.getLocalIndexEntry(accountId, mailbox, uid);
    if (entry) {
      await api.appendLocalIndex(accountId, mailbox, [{ ...entry, ...extra }]);
      return true;
    }
    // No entry yet. The bulk archive path stores the .eml through Rust and
    // never writes one, so without this a bulk-archived message loses its gold
    // the moment the app restarts.
    //
    // Only for a message the vault actually holds: writing an entry for one it
    // does not would put a row on screen with nothing behind it.
    const { useMailStore } = await import('../../stores/mailStore');
    const state = useMailStore.getState();
    if (!state.archivedEmailIds?.has(uid)) return false;
    const row = [...(state.localEmails || []), ...(state.emails || []), ...(state.sortedEmails || [])]
      .find(e => e.uid === uid && (e._mailbox == null || e._mailbox === mailbox));
    if (!row?.subject) return false;
    await api.appendLocalIndex(accountId, mailbox, [indexEntryFor(row, extra)]);
    return true;
  } catch (e) {
    console.warn('[stampVaultEntry] Failed to stamp uid', uid, extra, e);
    return false;
  }
}

// "This app deleted the server copy" — one of the three proofs custody accepts.
export async function markServerDeleted(accountId, mailbox, uid) {
  return stampVaultEntry(accountId, mailbox, uid, { serverDeleted: true });
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
  deletedByUs = false,
} = {}) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  // Record the removal on the vault entry before touching the store: this is
  // the only durable proof that the server copy is gone by our own hand, and
  // it is what makes the row gold. Derivation used to infer it from "uid not
  // in the active mailbox's set", which is a mailbox fact wearing a server
  // fact's clothes — see stores/slices/custody.js. Best-effort: a message with
  // no vault copy has no entry to stamp, and its row leaves the list anyway.
  //
  // ONLY for a delete this app issued. The other caller (selectEmail, on a
  // fetch that proves the uid is not in the mailbox) knows one mailbox lost
  // the message and nothing more — the message may well be sitting in All Mail
  // or the Bin, and that is precisely the guess this whole change removes.
  if (deletedByUs) await markServerDeleted(accountId, mailbox, uid);

  // A uid names a message only inside one (account, mailbox). In a list that
  // spans mailboxes another account's row carries the same number, so the row
  // filter has to read each row's own location — this is the same predicate
  // the localEmails stamp below has always used. A single folder's list has
  // one location, and there the bare uid is the whole answer.
  const sameMessage = (e) => e.uid === uid
    && (e._mailbox == null || e._mailbox === mailbox)
    && (e._accountId == null || e._accountId === accountId);
  const isRemoved = isUnified ? sameMessage : (e) => e.uid === uid;
  const filteredEmails = get().emails.filter(e => !isRemoved(e));
  const filteredSent = get().sentEmails.filter(e => !isRemoved(e));
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
  // The vault rows already in memory carry custody with them (db.getArchivedEmails
  // stamps it at read time), so stamp them here too rather than waiting for the
  // next disk read — the row must go gold in this paint, not the one after.
  if (deletedByUs) updates.localEmails = get().localEmails.map(e => (
    sameMessage(e) ? { ...e, serverDeleted: true } : e
  ));

  useMailStore.setState(updates);
  get().updateSortedEmails();

  if (!isUnified) {
    await db.saveEmailHeaders(accountId, mailbox, filteredEmails, newTotal, { removedUids: [uid] });
  }

  if (!skipRefresh && !isUnified) get().loadEmails();
}


// ── flag helpers (shared by read state, the star, \Answered and $Forwarded) ──

// Add or remove one flag, deduped. Read state is just this with '\\Seen'.
export const withFlag = (flags, flag, on) => on
  ? [...(flags || []), flag].filter((f, i, a) => a.indexOf(f) === i)
  : (flags || []).filter(f => f !== flag);

const _withSeen = (flags, read) => withFlag(flags, '\\Seen', read);

// One message's flag change on the server. Graph accounts have no IMAP flags —
// the bulk path used to skip this branch, so mark-as-read silently failed there
// — and only two of ours map onto anything Graph understands: isRead and its
// own flag, which is our star. \Answered and keywords have no equivalent, so
// they are dropped with a line rather than sent as something else.
export async function _setFlagOnServer(account, accountId, mailbox, uid, flags, action) {
  if (isGraphAccount(account)) {
    const graphId = await resolveGraphMessageId(accountId, mailbox, uid, { token: account.oauth2AccessToken });
    if (!graphId) {
      console.warn('[setFlagOnServer] No Graph message ID for UID', uid);
      return;
    }
    const on = action === 'add';
    if (flags.includes('\\Seen')) await api.graphSetRead(account.oauth2AccessToken, graphId, on);
    if (flags.includes('\\Flagged')) await api.graphSetFlagged(account.oauth2AccessToken, graphId, on);
    const rest = flags.filter(f => f !== '\\Seen' && f !== '\\Flagged');
    if (rest.length) console.log('[setFlagOnServer] Graph has no equivalent for', rest);
    return;
  }
  await api.updateEmailFlags(account, uid, flags, action, mailbox);
}

export const _setSeenOnServer = (account, accountId, mailbox, uid, read) =>
  _setFlagOnServer(account, accountId, mailbox, uid, ['\\Seen'], read ? 'add' : 'remove');

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

// Unified rows span accounts, so one \Seen change there has to be counted per
// account. Every single-account list is recounted by updateSortedEmails, which
// deliberately leaves this one alone — it cannot tell whose inbox it is looking
// at. An account with no row in the list keeps the count it already had.
function _syncUnifiedUnreadBadges(useMailStore) {
  const byAccount = new Map();
  for (const e of useMailStore.getState().emails) {
    if (!e._accountId) continue;
    byAccount.set(e._accountId, (byAccount.get(e._accountId) || 0) + (e.flags?.includes('\\Seen') ? 0 : 1));
  }
  for (const [id, unread] of byAccount) useSettingsStore.getState().setUnreadForAccount(id, unread);
}

// The vault half of a flag change.
//
// `localEmails` holds the rows the list gets from the vault, and `sentEmails`
// the Sent copies an INBOX list merges in; a row in one of those is in NO
// other array, so a mutation that maps `emails` alone leaves it untouched —
// the change never reaches the screen. Identity matters too: the array is
// replaced only when a row actually changed, because updateSortedEmails
// memoises on it.
function _mapLocalFlags(localEmails, matches, map) {
  if (!localEmails?.length || !localEmails.some(matches)) return localEmails;
  return localEmails.map(e => matches(e) ? { ...e, flags: map(e.flags) } : e);
}

// The durable half of a flag change.
//
// One Rust call lands it on every copy the vault keeps: the Maildir file name
// (which restore and the external mirror read the flags off), the mirror's
// copy, local-index.json (which the unified list reads a vault row back from)
// and the header sidecar (which the next repaint from cache reads). Each of
// those used to be written by a different path or by none — a message marked
// read here restored to a new server as unread, a vault row rebuilt from its
// file rendered unread whatever had been done to it, and a switch away and
// back repainted the old state until the next delta sync corrected it.
//
// Best-effort, and silent for a message the vault does not hold: Rust finds
// nothing to rename or patch and says so in its counts. The rows' flags are
// read after the caller mapped them, so `mapFlags` here is a no-op that keeps
// the call honest if the order ever changes.
//
// One call for all of `uids`: the writer rewrites the whole index file, so a
// call per message would race itself and the losers' flags would vanish.
//
// A uid is a name only inside one (account, mailbox), and the row is the proof
// of which one: a Sent copy merged into the INBOX list carries
// `_fromSentFolder` / `_mailbox`, and INBOX's own message under that number
// is a different file — the one restore uploads. So the row read here is the
// one of THIS folder, and no row at all (a flag list rebuilt from nothing
// would strip \Flagged and \Answered) is skipped rather than guessed at.
async function _persistVaultFlags(useMailStore, accountId, mailbox, uids, mapFlags, isUnified = false) {
  try {
    const s = useMailStore.getState();
    const pool = [s.selectedEmail, ...(s.emails || []), ...(s.localEmails || []), ...(s.sentEmails || [])];
    const changes = [];
    for (const uid of uids) {
      const row = pool.find(e => e && e.uid === uid
        && (!isUnified || !e._accountId || e._accountId === accountId)
        && (resolveEmailLocation(e, s)?.mailbox ?? mailbox) === mailbox);
      if (!row) {
        console.warn('[persistVaultFlags] No row of %s/%s for uid %s — vault copy left as it was', accountId, mailbox, uid);
        continue;
      }
      changes.push({ uid, flags: mapFlags(row.flags) });
    }
    if (!changes.length) return;
    const accountEmail = s.accounts?.find(a => a.id === accountId)?.email || null;
    await api.vaultApplyFlags(accountId, mailbox, accountEmail, changes);
  } catch (e) {
    console.warn('[persistVaultFlags] Failed to persist flags for', accountId, mailbox, uids, e);
  }
}

const _persistVaultSeen = (useMailStore, accountId, mailbox, uids, read, isUnified = false) =>
  _persistVaultFlags(useMailStore, accountId, mailbox, uids, (f) => _withSeen(f, read), isUnified);

// Land one message's \Seen change on every surface that renders read state:
// the list row, the open viewer copy, the cached body, the derived lists and
// the sidebar badge. The body cache is the easy one to miss — it freezes the
// flags the message had when it was fetched, so skipping it makes the next
// open of that message show the stale state and offer the wrong next action.
export function applySeenLocally(useMailStore, { accountId, mailbox, uid, read, isUnified = false }) {
  // The row of THIS folder: a Sent copy merged into the INBOX list and INBOX's
  // own message share a uid, and only one of them changed. A row that names
  // no folder is the view's — which is where `mailbox` came from.
  const s = useMailStore.getState();
  const matches = (e) => e.uid === uid
    && (!isUnified || e._accountId === accountId)
    && (resolveEmailLocation(e, s)?.mailbox ?? mailbox) === mailbox;
  useMailStore.setState(state => ({
    emails: state.emails.map(e => matches(e) ? { ...e, flags: _withSeen(e.flags, read) } : e),
    // A vault-only row lives in `localEmails` and never in `emails` — see
    // deriveDisplayRows, which pushes it into the list from there. Mapping
    // only `emails` is why marking one read did nothing at all on screen.
    localEmails: _mapLocalFlags(state.localEmails, matches, (f) => _withSeen(f, read)),
    // And a Sent copy merged into the INBOX list lives in `sentEmails`.
    sentEmails: _mapLocalFlags(state.sentEmails, matches, (f) => _withSeen(f, read)),
    selectedEmail: state.selectedEmail && matches(state.selectedEmail)
      ? { ...state.selectedEmail, flags: _withSeen(state.selectedEmail.flags, read) }
      : state.selectedEmail,
  }));

  const entry = useMailStore.getState().emailCache.get(`${accountId}-${mailbox}-${uid}`);
  if (entry) entry.email = { ...entry.email, flags: _withSeen(entry.email.flags, read) };

  _refreshAfterFlagChange(useMailStore);
  // …which recounts the badge for a single-account list. The unified one is on
  // us: counting its rows against `accountId` would put every account's unread
  // on whichever account owns the row that was clicked.
  if (isUnified) _syncUnifiedUnreadBadges(useMailStore);
  _persistVaultSeen(useMailStore, accountId, mailbox, [uid], read, isUnified);
}


// ── markEmailReadStatus workflow ──

export async function markEmailReadStatus(uid, read) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const state = get();
  // The message this uid names — account and folder from the row, not from
  // the view: the INBOX list merges the account's Sent copies in, and INBOX
  // has its own message under a merged copy's number. The viewer's toggle is
  // the caller, so the open copy (stamped with its folder when it was opened)
  // is the answer whenever it matches; otherwise the first row carrying the
  // uid, in-folder rows before merged Sent copies (see _markSelected).
  const open = state.selectedEmail?.uid === uid ? state.selectedEmail : null;
  const row = open || [...state.emails, ...(state.localEmails || []), ...(state.sentEmails || [])].find(e => e.uid === uid);
  const loc = resolveEmailLocation(row, state);
  const accountId = loc?.accountId || state.activeAccountId;
  const rawMailbox = loc?.mailbox || state.activeMailbox;
  const mailbox = rawMailbox === 'UNIFIED' ? 'INBOX' : rawMailbox;
  const account = state.accounts.find(a => a.id === accountId);
  if (!account) return;

  try {
    // The one flag core: rows, vault, journal, server — in that order, so a
    // reload between the journal write and the round-trip finishes the change
    // rather than losing it.
    // `emailObj` so the vault-only guard in there can see what kind of row
    // this is — the viewer's toggle reaches a vault-only message too.
    await applyFlagToTargets([{ account, accountId, mailbox, uid, emailObj: row }], '\\Seen', read);

    // Marking the open email unread means "not dealt with yet" — keeping it on
    // screen contradicts that, and the next open would just mark it read again.
    if (!read && useMailStore.getState().selectedEmail?.uid === uid) {
      useMailStore.setState({
        selectedEmailId: null,
        selectedEmail: null,
        selectedEmailSource: null,
        selectedThread: null,
      });
    }
  } catch (error) {
    useMailStore.setState({ error: tr('svc.messageMutations.couldChangeReadStatusServer', { error: error.message }) });
  }
}


// ── exportEmail workflow ──

export async function exportEmail(uid) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const state = get();
  const isUnified = spansMailboxes(state);
  const unified = isUnified ? _resolveUnifiedContext(uid, state) : null;
  const accountId = unified?.accountId || state.activeAccountId;
  const mailbox = (unified?.mailbox || state.activeMailbox) === 'UNIFIED' ? 'INBOX' : (unified?.mailbox || state.activeMailbox);
  const localId = `${accountId}-${mailbox}-${uid}`;
  return db.exportEmail(localId);
}


// ── the one flag workflow (read state, the star, \Answered, $Forwarded) ──

/**
 * Land one flag change for `targets` everywhere it renders, in the vault, in
 * the journal and on the server — in that order.
 *
 * Rows first because the user is watching them; the journal before the server,
 * because a reload between the two must not lose the intent; the server last,
 * and one message at a time.
 *
 * Offline (the connectivity store's verdict) the journal entry is left in
 * place and the round-trip skipped — replayOps sends it once the link is back.
 * A server failure leaves the entry too: only success clears it, for the same
 * reason. Graph accounts are the exception at both ends — replayOps cannot
 * replay one, so those go straight out and are never journalled.
 *
 * `targets` are already-resolved locations: [{ account, accountId, mailbox, uid }].
 * `undoable` fills the undo slot with the reverse change — only for the two
 * flags the user sets deliberately, and only over the rows this call actually
 * changes. The reverse itself passes false, or Cmd+Z would ping-pong.
 */
export async function applyFlagToTargets(targets, flag, on, { undoable = true } = {}) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const state = get();
  const isUnified = spansMailboxes(state);
  if (!targets.length) return;

  const targetKeys = new Set(targets.map(t => `${t.accountId}-${t.mailbox}-${t.uid}`));
  const matches = (e) => targetKeys.has(emailScopeKey(e, state));
  const map = (flags) => withFlag(flags, flag, on);

  // Read the flags the rows carry NOW, before the mapping below rewrites them:
  // the undo covers only the messages this call moves. Marking ten selected
  // messages read when three already were is a change to seven, and undoing it
  // must not mark those three unread. A target with no row on screen counts as
  // changed — the conservative half, since the offer then does put it back.
  const rowFlags = new Map();
  for (const e of [...state.emails, ...(state.localEmails || []), ...(state.sentEmails || []), state.selectedEmail]) {
    const k = e && emailScopeKey(e, state);
    if (k && !rowFlags.has(k)) rowFlags.set(k, e.flags);
  }
  const changed = targets.filter(t =>
    (rowFlags.get(`${t.accountId}-${t.mailbox}-${t.uid}`)?.includes(flag) ?? !on) !== on);

  useMailStore.setState(s => ({
    emails: s.emails.map(e => matches(e) ? { ...e, flags: map(e.flags) } : e),
    // Vault-only rows are reached through `localEmails`, not `emails` — and
    // the INBOX list's merged Sent copies through `sentEmails`.
    localEmails: _mapLocalFlags(s.localEmails, matches, map),
    sentEmails: _mapLocalFlags(s.sentEmails, matches, map),
    selectedEmail: s.selectedEmail && matches(s.selectedEmail)
      ? { ...s.selectedEmail, flags: map(s.selectedEmail.flags) }
      : s.selectedEmail,
  }));

  // The body cache freezes the flags a message had when it was fetched, so a
  // reopen of an uncorrected entry paints the state from before this change.
  for (const t of targets) {
    const entry = get().emailCache.get(`${t.accountId}-${t.mailbox}-${t.uid}`);
    if (entry) entry.email = { ...entry.email, flags: map(entry.email.flags) };
  }
  _refreshAfterFlagChange(useMailStore);

  // The rows have changed; offer the change back. Only the two flags the user
  // sets deliberately — \Answered and $Forwarded are stamped BY sending, and
  // their callers pass `undoable: false` anyway. The reverse is not itself an
  // action to undo, or Cmd+Z would ping-pong forever.
  if (undoable && changed.length && (flag === '\\Seen' || flag === '\\Flagged')) {
    get().setUndo({
      labelKey: flag === '\\Seen'
        ? (on ? 'undo.markedRead' : 'undo.markedUnread')
        : (on ? 'undo.starred' : 'undo.unstarred'),
      labelParams: { count: changed.length },
      run: () => applyFlagToTargets(changed, flag, !on, { undoable: false }),
    });
  }

  // Single-account lists were recounted by _refreshAfterFlagChange above.
  if (flag === '\\Seen' && isUnified) _syncUnifiedUnreadBadges(useMailStore);

  // The vault copies are written whatever the server says — a vault-only
  // message has no server copy to fail against, and the rows on screen have
  // already changed — and written ONCE per folder, not once per message.
  const byFolder = new Map();
  for (const t of targets) {
    const k = `${t.accountId}|${t.mailbox}`;
    if (!byFolder.has(k)) byFolder.set(k, { ...t, uids: [] });
    byFolder.get(k).uids.push(t.uid);
  }
  for (const f of byFolder.values()) {
    _persistVaultFlags(useMailStore, f.accountId, f.mailbox, f.uids, map, isUnified);
  }

  const action = on ? 'add' : 'remove';
  for (const t of targets) {
    // A vault-only row has no server copy, and its uid is a pseudo-uid the
    // server would refuse — journalling it files an op that can never be
    // finished, and the replay carries it until it has failed once. The vault
    // write above has already landed, which for this row is the whole change.
    // Same guard deleteEmailFromServer applies before it journals a delete.
    if (t.emailObj?.source === 'local-only' || t.emailObj?._localStaged) continue;
    if (isGraphAccount(t.account)) {
      try {
        await _setFlagOnServer(await ensureFreshToken(t.account), t.accountId, t.mailbox, t.uid, [flag], action);
      } catch (e) {
        // The one branch with no journal behind it — replayOps cannot replay a
        // Graph op — so a failure here is the end of the road and has to say so.
        console.error('[applyFlag] Graph write failed:', e);
        useMailStore.setState({ error: tr('svc.messageMutations.couldChangeFlagServer', { error: e.message }) });
      }
      continue;
    }
    await db.queueOp({ op: 'flag', accountId: t.accountId, mailbox: t.mailbox, uids: [t.uid], arg: { flags: [flag], action } });
    if (!useConnectivityStore.getState().online) continue;   // replayOps finishes it
    try {
      const account = await ensureFreshToken(t.account);
      await _setFlagOnServer(account, t.accountId, t.mailbox, t.uid, [flag], action);
      await db.clearOps({ op: 'flag', accountId: t.accountId, mailbox: t.mailbox, uids: [t.uid], arg: { flags: [flag], action } });
    } catch (e) {
      console.error(`[applyFlag] ${flag} ${action} failed for ${t.accountId}/${t.mailbox}/${t.uid} — left in the journal:`, e);
    }
  }
}

/**
 * The same change, addressed by selection key.
 *
 * Which message each key names — account, folder, uid — is resolved once, up
 * front, so that every write below follows it: the rows on screen, the vault
 * copies, the journal and the server. The folder comes from the row, not the
 * view (the resolver the delete workflows use): the INBOX list merges the
 * account's Sent copies in, and a uid names a message only inside one folder,
 * so a `UID STORE` against INBOX for a merged Sent row would flag INBOX's own
 * message under that number.
 *
 * In-folder rows first. A single folder's list keys its selection by bare uid,
 * which cannot say which of two same-numbered rows was ticked; the folder on
 * screen owns the number, and a merged Sent copy answers only when no
 * in-folder row carries it. ponytail: the key itself naming the folder, as the
 * unified list's does, is the real fix for that ambiguity.
 */
export async function applyFlagToKeys(keys, flag, on, opts) {
  const { useMailStore } = await import('../../stores/mailStore');
  const state = useMailStore.getState();

  const emailMap = new Map();
  for (const e of [...state.emails, ...(state.localEmails || []), ...(state.sentEmails || [])]) {
    const k = selectionKey(e, state);
    if (!emailMap.has(k)) emailMap.set(k, e);
  }
  const targets = [];
  for (const key of keys) {
    const ctx = _resolveKeyContext(key, state, emailMap, { require: false });
    if (!ctx) {
      console.warn('[applyFlag] skipped a row that names no account:', key);
      continue;
    }
    targets.push({ key, ...ctx });
  }

  // A bulk path hands the selection back empty, as mark read always has. A
  // single row acted on while an unrelated bulk selection is live is NOT that,
  // so the selection is only cleared when these keys ARE the selection.
  const selected = state.selectedEmailIds;
  if (keys.length && new Set(keys).size === selected.size && keys.every(k => selected.has(k))) {
    useMailStore.setState({ selectedEmailIds: new Set() });
  }

  return applyFlagToTargets(targets, flag, on, opts);
}


// ── bulk mark read/unread workflow ──

async function _markSelected(read) {
  const { useMailStore } = await import('../../stores/mailStore');
  const { selectedEmailIds } = useMailStore.getState();
  if (selectedEmailIds.size === 0) return;
  return applyFlagToKeys([...selectedEmailIds], '\\Seen', read);
}

export const markSelectedAsRead = () => _markSelected(true);
export const markSelectedAsUnread = () => _markSelected(false);


// ── star (\Flagged) ──

export async function setSelectedFlagged(on) {
  const { useMailStore } = await import('../../stores/mailStore');
  const { selectedEmailIds } = useMailStore.getState();
  if (selectedEmailIds.size === 0) return;
  return applyFlagToKeys([...selectedEmailIds], '\\Flagged', on);
}

/**
 * Flip one row's star. `key` is that row's selection key — a bare uid in a
 * single folder's list, the full `account:mailbox:uid` in a spanning one.
 *
 * The current state is read off the row (or the open copy, for a message whose
 * row has scrolled out of the loaded window), and compared as a string: a bare
 * uid key arrives as a number from the row and as a string from a data
 * attribute, and `7 === '7'` is false.
 */
export async function toggleFlagged(key) {
  const { useMailStore } = await import('../../stores/mailStore');
  const state = useMailStore.getState();
  const sameKey = (e) => String(selectionKey(e, state)) === String(key);
  const row = [...state.emails, ...(state.localEmails || []), ...(state.sentEmails || [])].find(sameKey)
    || (state.selectedEmail && sameKey(state.selectedEmail) ? state.selectedEmail : null);
  const on = !row?.flags?.includes('\\Flagged');
  return applyFlagToKeys([key], '\\Flagged', on);
}


// ── \Answered / $Forwarded — the message a reply or forward answered ──

// `replyTo` is the open copy the viewer handed compose — stamped
// _accountId/_mailbox by selectEmail when the reply started from the reading
// pane, but NOT when it started from a row menu: `replyTarget` there merges a
// plain list row with its resolved body, and a single-folder list's rows
// carry no such stamp. `resolveEmailLocation` is the same fallback every other
// flag path uses for an unstamped row — the active account/mailbox, which for
// a row menu action is exactly where that row lives. A message that never
// reached a server, or whose location cannot be resolved at all (a foreign
// account's untagged row), is left alone: there is nothing to write to, and
// guessing the folder would flag another message under the same number.
// Not undoable — the user asked to send, not to set a flag.
async function _flagRepliedTo(replyTo, flag) {
  if (!replyTo || typeof replyTo.uid !== 'number' || replyTo._localStaged || replyTo.source === 'local-only') return;
  const { useMailStore } = await import('../../stores/mailStore');
  const state = useMailStore.getState();
  const loc = resolveEmailLocation(replyTo, state);
  if (!loc) return;
  const account = state.accounts.find(a => a.id === loc.accountId);
  if (!account) return;
  return applyFlagToTargets(
    [{ account, accountId: loc.accountId, mailbox: loc.mailbox, uid: replyTo.uid }],
    flag, true, { undoable: false },
  );
}

export const markAnswered = (replyTo) => _flagRepliedTo(replyTo, '\\Answered');
export const markForwarded = (replyTo) => _flagRepliedTo(replyTo, '$Forwarded');


// ── shared per-key context resolution ──
//
// The bulk read-state and delete workflows need the same thing per selected
// key: unwind a unified-inbox composite key (or a plain uid) into the real
// uid, account, mailbox and — if we have one — the matching email object.
// `emailMap` is supplied by the caller since each builds it from a different
// set of arrays (see purgeEverywhere's comment on why it also includes
// `localEmails`).

function _resolveKeyContext(key, state, emailMap, { require = true } = {}) {
  const isUnified = spansMailboxes(state);
  // `require` is what happens to a key that names no account: the actions that
  // destroy a message (delete, purge) refuse the whole batch rather than guess
  // a folder, and the ones that do not (save, mark, move) skip the row and go
  // on. Guessing was the original bug — it aimed the mutation at the active
  // account's INBOX under the raw uid, i.e. at somebody else's message.
  let ctx = null;
  if (isUnified) {
    try {
      // Not `_resolveUnifiedContext`: a FULL key still names its own account
      // and folder after the row has left every list, and that case resolves
      // in both modes. Only a key that names nothing at all throws.
      ctx = requireUnifiedContext(key, state);
    } catch (e) {
      if (require) throw e;
      return null;
    }
  }
  // A full key names its account and folder itself (a merged Sent copy in a
  // single folder's list gets one — see selectionKey); a bare uid names the
  // view's.
  const parsed = _parseSelKey(key);
  const uid = ctx?.uid ?? parsed.uid;
  const accountId = ctx?.accountId || parsed.accountId || state.activeAccountId;
  const emailObj = emailMap.get(key);
  // The row's own folder where it names one — `_mailbox`, or the Sent path
  // for a copy the INBOX list merged in — the key's, and the view's otherwise.
  const rawMailbox = ctx?.mailbox || resolveEmailLocation(emailObj, state)?.mailbox || parsed.mailbox || state.activeMailbox;
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
  const isUnified = spansMailboxes(state);
  if (selectedEmailIds.size === 0) return { deleted: [] };

  const keys = Array.from(selectedEmailIds);

  const allEmails = [...state.emails, ...state.sentEmails];
  const emailMap = new Map(allEmails.map(e => [selectionKey(e, state), e]));
  const contextOf = (key) => _resolveKeyContext(key, state, emailMap);

  // Journal the intent BEFORE anything else, and await it.
  //
  // Everything below runs in the webview: reload or quit inside the loop and
  // this context dies before the remaining commands are sent. The journal is
  // what lets the next launch finish the job (see replayOps) — but only if it
  // actually reached disk first, and it is an async IPC racing the very window
  // it exists to cover.
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
    (g) => db.queueOp({ op: 'delete', accountId: g.accountId, mailbox: g.mailbox, uids: g.uids }),
  ));

  // Offline the journal entries ARE the deletes: replayOps sends them when the
  // link is back, and its completion path prunes the sidecar and stamps
  // custody. So the rows go (their tombstones hold), but nothing below may
  // claim a server delete that has not happened.
  const offline = !useConnectivityStore.getState().online;

  // Remove from the UI immediately — the server/maildir deletes below can take
  // seconds (pool checkout + one round-trip per email). The post-loop
  // loadEmails() reconcile restores anything whose server delete failed.
  const deletedKeySet = new Set(keys);
  const realUidSet = new Set(keys.map(k => (isUnified ? requireUnifiedContext(k, state).uid : k)));

  const newTombstones = new Set(state.deleteTombstones);
  for (const key of keys) newTombstones.add(contextOf(key).tombstone);

  // The open message may be one of the ticked ones; if it is, the same setting
  // the single delete honours decides what replaces it.
  const isDeletedRow = (e) => deletedKeySet.has(selectionKey(e, state));
  const openNext = realUidSet.has(state.selectedEmailId)
    ? _openAfterDelete(state, (e) => selectionKey(e, state) === state.selectedEmailId, isDeletedRow)
    : null;

  useMailStore.setState({
    deleteTombstones: newTombstones,
    selectedEmailIds: new Set(),
    emails: state.emails.filter(e => !deletedKeySet.has(selectionKey(e, state))),
    sentEmails: state.sentEmails.filter(e => !deletedKeySet.has(selectionKey(e, state))),
    totalEmails: Math.max(0, (state.totalEmails || 0) - keys.length),
    selectedEmailId: realUidSet.has(state.selectedEmailId) ? null : state.selectedEmailId,
    selectedEmail: realUidSet.has(state.selectedEmailId) ? null : state.selectedEmail,
  });
  get().updateSortedEmails();
  if (openNext) get().selectEmail(selectionKey(openNext, state));

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
  // Where each deleted message went, so a caller can offer an undo instead of
  // a SEARCH per uid. Same record shape as deleteEmailFromServer's.
  const deleted = [];

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

      // The row is already hidden by its tombstone; the journal entry carries
      // the rest. Nothing below this line may run — the prune, the custody
      // stamp and the clear all assert a delete that has not happened yet.
      if (offline) {
        console.log(`[deleteSelectedFromServer] offline — UID ${realUid} journalled, replayOps will finish it`);
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
        if (!graphId) throw new Error(tr('errors.noGraphIdForUid', { uid: realUid }));
        await api.graphDeleteMessage(account.oauth2AccessToken, graphId);
      } else {
        const res = await api.deleteEmail(account, realUid, mailbox);
        deleted.push({
          account, accountId, mailbox, uid: realUid,
          trash: res?.trash ?? null, trashUid: res?.trashUid ?? null,
          messageId: emailObj?.messageId ?? null,
        });
      }
      deletedRealUids.add(realUid);
      if (!isUnified && mailbox === state.activeMailbox) deletedInActiveMailbox.add(realUid);
      if (!isUnified && get().archivedEmailIds.has(realUid)) {
        survivingLocalTombstones.add(tombstone);
      }
      // Same durable stamp the single delete writes — a surviving vault copy is
      // gold because WE removed the server copy, never because a uid set is
      // missing it. See stores/slices/custody.js.
      await markServerDeleted(accountId, mailbox, realUid);
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
  //
  // Offline nothing was attempted, so nothing may be cleared: the entries are
  // the whole delete until replayOps sends them.
  if (!offline) {
    await Promise.all([...journalGroups.values()].map(
      (g) => db.clearOps({ op: 'delete', accountId: g.accountId, mailbox: g.mailbox, uids: g.uids, arg: {} }),
    ));
  }

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
      // The vault rows in memory were read before the delete, so they still say
      // "also on the server". The index on disk is already stamped; carry the
      // same fact into this paint rather than waiting for a cold read that only
      // happens when localEmails is empty.
      const survived = new Set([...survivingLocalTombstones].map(t => Number(t.split('|')[2])));
      useMailStore.setState({
        deleteTombstones: ts,
        localEmails: get().localEmails.map(e => (survived.has(Number(e.uid)) ? { ...e, serverDeleted: true } : e)),
      });
      get().updateSortedEmails();
    }
  }

  // One slot for the whole batch.
  await setDeleteUndo(deleted);

  return { deleted };
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
  const isUnified = spansMailboxes(state);
  if (!keys?.length) return { deleted: 0, failed: 0, queuedBackup: 0, needsResync: 0 };

  // A purge destroys every copy — nothing here can be undone, and a stale
  // "Moved 3 to Trash" left in the slot would offer to restore messages this
  // call is about to erase.
  get().clearUndo();

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
  const emailMap = new Map(allEmails.map(e => [selectionKey(e, state), e]));

  const contexts = keys.map(key => _resolveKeyContext(key, state, emailMap));

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
    emails: state.emails.filter(e => !keySet.has(selectionKey(e, state))),
    sentEmails: state.sentEmails.filter(e => !keySet.has(selectionKey(e, state))),
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
          if (!graphId) throw new Error(tr('errors.noGraphIdForUid', { uid: t.uid }));
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
//
// Takes SELECTION KEYS — what the checkbox writes and every bulk action reads
// back (selectionKey) — and moves each message out of ITS OWN folder. A bare
// uid names the view's folder; a full `account:folder:uid` names its own: a
// merged Sent copy in the INBOX list, a search hit from another folder, any
// row of a list spanning folders. The single-folder branch used to hand the
// keys straight to `imap_move_emails`, whose `uids` is a Vec<u32>:
//
//   invalid args `uids` for command `imap_move_emails`: invalid type: string
//   "e7ce0440-…:INBOX:34363", expected u32   (bson73, discussion #1)
//
// One move per (account, mailbox). A key that names no account, or no numeric
// uid, is skipped — the rest of the selection still moves. A guessed folder
// moves a different message under that uid, and refusing the whole batch over
// one unstamped row would strand a move that is not destroying anything.
//
// Resolves `{ moved: [{ account, accountId, from, to, srcUids, dstUids,
// messageIds, deferred? }] }` — one record per group that reached the server or
// was journalled for one, carrying the destination uids (COPYUID) an undo needs.
// `dstUids` is null when the server reported none; `deferred` marks a group the
// journal is still holding because the app is offline. Graph groups get no
// record: their move is addressed by a per-session id, not a uid.

export async function moveEmails(keys, targetMailbox) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const state = get();
  const isUnified = spansMailboxes(state);
  const { activeAccountId, activeMailbox, selectedEmailId } = state;

  const emailMap = new Map([...state.emails, ...state.sentEmails, ...(state.localEmails || [])]
    .map(e => [selectionKey(e, state), e]));
  const groups = new Map();
  for (const key of keys) {
    const ctx = _resolveKeyContext(key, state, emailMap, { require: false });
    if (!ctx) {
      console.warn('[moveEmails] skipped a row that names no account:', key);
      continue;
    }
    if (!ctx.account || typeof ctx.uid !== 'number') continue;
    const gk = `${ctx.accountId}|${ctx.mailbox}`;
    if (!groups.has(gk)) groups.set(gk, { account: ctx.account, accountId: ctx.accountId, mailbox: ctx.mailbox, uids: [], rows: [], keys: [] });
    groups.get(gk).uids.push(ctx.uid);
    groups.get(gk).rows.push(ctx.emailObj);
    groups.get(gk).keys.push(key);
  }

  // Where each group came from and where it landed — the destination uids
  // (COPYUID) included, which is what an undo addresses the moved copy by.
  const records = [];
  for (const group of groups.values()) {
    const account = await ensureFreshToken(group.account);
    const record = (dstUids, extra) => ({
      account, accountId: group.accountId, from: group.mailbox, to: targetMailbox,
      srcUids: group.uids, dstUids, messageIds: group.rows.map(r => r?.messageId || null),
      ...extra,
    });
    if (isGraphAccount(account)) {
      // Addressed by a per-session message id, not a replayable uid: a
      // journalled entry is something no later launch could act on, and there
      // is no destination uid to hand an undo either.
      await _graphMoveGroup(state, account, group, targetMailbox);
      continue;
    }
    // Same ordering as every other mutation: the journal is written before the
    // round trip (the rows are about to leave the list, so a reload or a quit
    // in between must not lose the intent) and cleared only after it.
    await db.queueOp({ op: 'move', accountId: group.accountId, mailbox: group.mailbox, uids: group.uids, arg: { target: targetMailbox } });
    if (!useConnectivityStore.getState().online) {
      console.log(`[moveEmails] offline — ${group.mailbox} → ${targetMailbox} journalled, replayOps will finish it`);
      records.push(record(null, { deferred: true }));
      continue;
    }
    const res = await api.moveEmails(account, group.uids, group.mailbox, targetMailbox);
    await db.clearOps({ op: 'move', accountId: group.accountId, mailbox: group.mailbox, uids: group.uids, arg: { target: targetMailbox } });
    // Null when the server reported no COPYUID (no UIDPLUS) — never a guess.
    records.push(record(Array.isArray(res?.newUids) ? res.newUids : null));
  }

  // Resolved rows only. A key nothing could place named no folder, so nothing
  // moved for it: taking its row off the list (or its tick off the selection)
  // would show the user a move that did not happen. Clearing only the keys
  // this move resolved — not the whole selectedEmailIds set — means a single
  // row-menu move leaves an unrelated bulk selection intact.
  const keySet = new Set([...groups.values()].flatMap(g => g.keys));
  const filteredEmails = get().emails.filter(e => !keySet.has(selectionKey(e, state)));
  const newTotal = Math.max(0, (get().totalEmails || 0) - (get().emails.length - filteredEmails.length));
  const updates = {
    emails: filteredEmails,
    sentEmails: get().sentEmails.filter(e => !keySet.has(selectionKey(e, state))),
    totalEmails: newTotal,
    selectedEmailIds: new Set([...state.selectedEmailIds].filter(k => !keySet.has(k))),
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

  // A hit moved out of the results list stays gone: the results are not
  // `emails`, and loadEmails() reloads the folder, not the search.
  const { useSearchStore } = await import('../../stores/searchStore');
  const search = useSearchStore.getState();
  if (search.searchActive) {
    useSearchStore.setState({ searchResults: search.searchResults.filter(e => !keySet.has(selectionKey(e, state))) });
  }

  const { invalidateRestoreDescriptors: _invalidateRestore } = await import('../cacheManager');
  // Only the view's own folder can name removed uids — the sidecar is per
  // (account, mailbox), and a merged copy's uid belongs to another one.
  //
  // And no write at all when the list spans folders: `filteredEmails` then
  // holds rows from every folder in the scope, while `activeMailbox` is the
  // branch ROOT — a real folder ('INBOX' on bson73's INBOX-prefixed server,
  // discussion #1), unlike the literal 'UNIFIED'. Writing the branch list and
  // its total into that folder's cache is what the next single-folder load
  // paints cache-first: mail that was moved away still in the inbox.
  const own = groups.get(`${activeAccountId}|${activeMailbox}`);
  if (!isUnified) {
    await db.saveEmailHeaders(activeAccountId, activeMailbox, filteredEmails, newTotal,
      own ? { removedUids: own.uids } : undefined);
  }

  _invalidateRestore(activeAccountId);

  reloadListInView();

  // Graph groups produce no record — no replayable uid, no COPYUID — so a
  // Graph-only move leaves the previous slot alone rather than offering an
  // undo it could not perform.
  if (records.length) {
    get().setUndo({
      labelKey: 'undo.moved',
      labelParams: {
        count: records.reduce((n, r) => n + r.srcUids.length, 0),
        folder: mailboxLabel(targetMailbox.split(/[./]/).pop()),
      },
      run: () => _undoMove(records),
    });
  }

  return { moved: records };
}

// Move the messages back. The destination uids came with COPYUID; without
// UIDPLUS they are found by Message-ID in the destination folder.
async function _undoMove(records) {
  // A throw on the second record must still repaint what the first one moved.
  try {
    for (const r of records) {
      // Never sent: forgetting the journal entry IS the undo. The rows come back
      // through the reload below — they were only hidden locally.
      if (r.deferred) {
        await db.clearOps({ op: 'move', accountId: r.accountId, mailbox: r.from, uids: r.srcUids, arg: { target: r.to } });
        continue;
      }
      const dst = r.dstUids ?? await _resolveDestinationUids(r.account, r.to, r.messageIds);
      // Bare: runUndo already says "Undo failed: {{err}}" around whatever this
      // throws, and saying it twice reads as a bug.
      if (!dst.length) throw new Error(r.to);
      await api.moveEmails(r.account, dst, r.to, r.from);
    }
  } finally {
    await reloadListInView();
  }
}

// What a server with no UIDPLUS never told us: which uids the copies got. The
// Message-ID is the only handle left, and only the hit in the destination
// folder is this move's — the same id can sit in Sent or in the source.
// ponytail: one SEARCH per message, serial; batch per destination folder if a
// no-UIDPLUS server ever hosts a big move.
async function _resolveDestinationUids(account, mailbox, messageIds) {
  const uids = [];
  for (const mid of messageIds) {
    if (!mid) continue;
    const probe = await api.findMessageId(account, mid, { stopOnFirst: false });
    for (const loc of probe?.found || []) if (loc.mailbox === mailbox) uids.push(loc.uid);
  }
  return uids;
}

// One (account, mailbox) of a move on a Graph account: every uid must resolve
// to a Graph message id, and the target must be a folder Graph knows.
async function _graphMoveGroup(state, account, { accountId, mailbox, uids, rows }, targetMailbox) {
  const messageIds = (await Promise.all(uids.map((uid, i) => resolveGraphMessageId(
    accountId, mailbox, uid, { row: rows[i], token: account.oauth2AccessToken },
  )))).filter(Boolean);
  if (messageIds.length !== uids.length) {
    throw new Error(tr('errors.noGraphIdMove'));
  }
  const targetFolder = state.mailboxes.find(m => m.path === targetMailbox || m.name === targetMailbox);
  if (!targetFolder || !targetFolder._graphFolderId) {
    throw new Error(tr('errors.moveTargetNotFound', { folder: targetMailbox }));
  }
  await api.graphMoveEmails(account.oauth2AccessToken, messageIds, targetFolder._graphFolderId);
}
