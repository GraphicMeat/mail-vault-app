// ── Snooze ──
//
// A snooze is the app's own move into the account's Snoozed folder — through
// moveEmails, so the op journal, the list, the cache sidecar and the vault
// rules all hold exactly as for any move — followed by one daemon row per
// moved message (`snooze.create`). The daemon's worker moves it back, unread,
// at the wake time, and finds it by Message-ID (the move's COPYUID is only a
// hint), so a message with no Message-ID cannot be snoozed.
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

  const created = [];
  for (const [accountId, groupKeys] of groups) {
    const account = await ensureFreshToken(state.accounts.find(a => a.id === accountId));
    const folder = await daemonCall('snooze.ensure_folder', { account });
    if (!(accountId === state.activeAccountId && (state.mailboxes || []).some(m => m.path === folder))) {
      forceMailboxRefetch(accountId);
    }
    const { moved } = await moveEmails(groupKeys, folder);
    for (const r of moved) {
      for (let i = 0; i < r.srcUids.length; i++) {
        const uid = r.dstUids?.[i] ?? null;
        try {
          created.push(await daemonCall('snooze.create', {
            accountId: r.accountId, mailbox: r.from, snoozedMailbox: r.to, uid, messageId: r.messageIds[i], wakeAt,
          }));
        } catch (e) {
          // No row means nothing would ever wake it: put it back. Without a
          // COPYUID there is no uid to address it by; the error says so.
          if (uid != null) await api.moveEmails(r.account, [uid], r.to, r.from).catch(() => {});
          throw e;
        }
      }
    }
  }

  if (created.length) {
    useSnoozeStore.getState().upsert(created);
    const ids = created.map(row => row.id);
    get().setUndo({ labelKey: 'undo.snoozed', labelParams: { count: ids.length }, run: () => unsnooze(ids) });
  }
  const snoozed = created.length;
  return { snoozed, skipped: keys.length - [...groups.values()].reduce((n, g) => n + g.length, 0) };
}

/** Wake these snooze rows now (the daemon moves them back), then repaint. */
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
