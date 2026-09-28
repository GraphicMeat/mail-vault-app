// ── Snooze ──
//
// A snooze is the app's own move into the account's Snoozed folder — through
// moveEmails, so the op journal, the list, the cache sidecar and the vault
// rules all hold exactly as for any move — followed by one daemon row per
// moved message (`snooze.create`). The daemon's worker moves it back, unread,
// at the wake time, and finds it by Message-ID (the move's COPYUID is only a
// hint), so a message with no Message-ID cannot be snoozed.
//
// A server that will not host a Snoozed folder (it refused both CREATEs, or
// answered ALREADYEXISTS or BAD, or has no hierarchy) gets a LOCAL snooze:
// nothing moves, the row's `snoozedMailbox` is '', the list holds the message
// out of its folder until the row wakes (deriveDisplayRows), and the wake
// marks it unread where it is. Other clients still show it in the inbox.
//
// Not on a Graph account: the daemon never refreshes an OAuth token, so a
// background Graph move would fail at wake time. Not offline either: the move
// would be journalled for later while the row already exists, and a wake that
// ran first would find nothing and let the replayed move strand the message.
import * as api from '../api';
import { daemonCall } from '../daemonClient';
import { ensureFreshToken } from '../authUtils';
import { isGraphAccount } from '../graphConfig';
import { moveEmails, reloadListInView } from './messageMutations';
import { forceMailboxRefetch } from './helpers/mailboxRefetch';
import { resolveEmailLocation, selectionKey } from '../../stores/slices/unifiedHelpers';
import { useConnectivityStore } from '../../stores/connectivityStore';
import { useSnoozeStore } from '../../stores/snoozeStore';
import { t as tr } from '../../i18n/index.js';

// `mailvault_core::imap::SNOOZE_FOLDER_REFUSED`: the server answered, and
// will not host a Snoozed folder.
const FOLDER_REFUSED = 'E_SNOOZE_FOLDER_REFUSED:';

/** Whether `email` can be snoozed at all (see the header). */
export function canSnooze(email, state) {
  if (!email?.messageId || email.source === 'local-only' || email._insightsReadOnly || email._insightsNoServerActions) return false;
  const location = resolveEmailLocation(email, state);
  const account = location && state.accounts?.find(a => a.id === location.accountId);
  return !!account && !isGraphAccount(account);
}

/**
 * Snooze the messages `keys` (selection keys) until `wakeAt` (epoch ms).
 * Resolves `{ snoozed, skipped }`; rows `canSnooze` refuses are skipped.
 */
export async function snoozeEmails(keys, wakeAt) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();
  if (!useConnectivityStore.getState().online) throw new Error(tr('snooze.offline'));

  const state = get();
  const rows = new Map([...state.emails, ...state.sentEmails, ...(state.localEmails || [])]
    .map(e => [selectionKey(e, state), e]));
  const groups = new Map();
  for (const key of keys) {
    const email = rows.get(key);
    if (!canSnooze(email, state)) continue;
    const { accountId } = resolveEmailLocation(email, state);
    if (!groups.has(accountId)) groups.set(accountId, []);
    groups.get(accountId).push(key);
  }
  // Only the keyboard shortcut gets here with nothing to snooze: the quick
  // actions are disabled for such a selection.
  if (!groups.size) throw new Error(tr('snooze.unavailable'));

  // Every moved message gets its row or goes back where it came from; one
  // failure never stops the rest, and the first error is reported at the end.
  const created = [];
  const heldKeys = [];
  let failure = null;
  let movedAny = false;
  try {
    for (const [accountId, groupKeys] of groups) {
      const account = await ensureFreshToken(state.accounts.find(a => a.id === accountId));
      const folder = await daemonCall('snooze.ensure_folder', { account }).catch((e) => {
        const reason = String(e?.message || e);
        if (reason.startsWith(FOLDER_REFUSED)) {
          console.warn('[snooze] the server will not host a Snoozed folder, snoozing on this computer:', reason);
          return null;
        }
        console.error('[snooze] could not resolve or create the Snoozed folder:', e);
        throw new Error(tr('snooze.error.createFolder', { reason }));
      });
      if (folder === null) {
        // Nothing moved, so a row that cannot be written has nothing to put back.
        for (const key of groupKeys) {
          const email = rows.get(key);
          try {
            created.push(await daemonCall('snooze.create', {
              accountId, mailbox: resolveEmailLocation(email, state).mailbox, snoozedMailbox: '',
              uid: email.uid ?? null, messageId: email.messageId, wakeAt,
            }));
            heldKeys.push(key);
          } catch (e) {
            failure ||= e;
          }
        }
        continue;
      }
      if (!(accountId === state.activeAccountId && (state.mailboxes || []).some(m => m.path === folder))) {
        forceMailboxRefetch(accountId);
      }
      const { moved } = await moveEmails(groupKeys, folder);
      movedAny ||= moved.length > 0;
      for (const r of moved) {
        for (let i = 0; i < r.srcUids.length; i++) {
          try {
            created.push(await daemonCall('snooze.create', {
              accountId: r.accountId, mailbox: r.from, snoozedMailbox: r.to,
              uid: r.dstUids?.[i] ?? null, messageId: r.messageIds[i], wakeAt,
            }));
          } catch (e) {
            failure ||= e;
            await putBack(r, i).catch(err => console.error('[snooze] could not put back a message with no row:', err));
          }
        }
      }
    }
  } finally {
    if (heldKeys.length) {
      // The rows hide them from the list; the reader and the selection let go too.
      const held = new Set(heldKeys);
      const live = get();
      useMailStore.setState({
        selectedEmailIds: new Set([...(live.selectedEmailIds || [])].filter(k => !held.has(k))),
        ...(held.has(live.selectedEmailId) ? { selectedEmailId: null, selectedEmail: null, selectedEmailSource: null, selectedThread: null } : {}),
      });
    }
    if (created.length) {
      useSnoozeStore.getState().upsert(created);
      const ids = created.map(row => row.id);
      get().setUndo({ labelKey: 'undo.snoozed', labelParams: { count: ids.length }, run: () => unsnooze(ids) });
    } else if (movedAny) {
      // moveEmails left its own "Moved to Snoozed" undo, over messages that
      // have all been put back already.
      get().setUndo(null);
    }
  }
  if (failure) throw failure;
  return { snoozed: created.length, skipped: keys.length - [...groups.values()].reduce((n, g) => n + g.length, 0) };
}

// A moved message whose row could not be written: nothing would ever wake
// it, so it goes back. Without a COPYUID it is found by Message-ID in the
// Snoozed folder, like the move workflow's own undo does.
async function putBack(r, i) {
  let uids = r.dstUids?.[i] != null ? [r.dstUids[i]] : [];
  if (!uids.length && r.messageIds[i]) {
    const probe = await api.findMessageId(r.account, r.messageIds[i], { stopOnFirst: false });
    uids = (probe?.found || []).filter(loc => loc.mailbox === r.to).map(loc => loc.uid);
  }
  if (uids.length) await api.moveEmails(r.account, uids, r.to, r.from);
}

/**
 * Wake these snooze rows now (the daemon moves a server snooze back; a local
 * one only ends, and the list shows its message again), then repaint.
 */
export async function unsnooze(ids) {
  try {
    for (const id of ids) {
      const row = await daemonCall('snooze.cancel', { id });
      useSnoozeStore.getState().applyEvent({ id, state: row?.state || 'woken' });
    }
  } finally {
    await reloadListInView();
  }
}
