import * as api from './api.js';
import { resolveServerAccount } from './authUtils.js';
import { getMailboxes } from '../stores/accountStore.js';
import { useSettingsStore } from '../stores/settingsStore.js';

const LOCAL_MIN = 20;          // ignore trivially small mailboxes
const SERVER_RATIO = 0.10;     // server "near-empty" if < 10% of local

/** Pure heuristic — unit tested. */
export function shouldPromptRestore({ hostChanged, localTotal, serverTotal }) {
  if (!hostChanged) return false;
  if (localTotal < LOCAL_MIN) return false;
  return serverTotal < localTotal * SERVER_RATIO;
}

/**
 * Run after an edited account has synced. Compares local Maildir counts against
 * server counts; on a hit, sets restoreDetected so the banner/modal appears.
 * Best-effort: any error is swallowed (detection must never break sync).
 */
export async function checkRestoreNeeded(account) {
  try {
    if (!account?.id || !account.previousImapHost) return;

    const ss = useSettingsStore.getState();
    // Don't re-prompt while a prompt/restore is already active, or if the user
    // dismissed this account's prompt this session.
    if (ss.restoreDetected || ss.activeRestore) return;
    if (ss.restoreDismissedIds.includes(account.id)) return;

    // Hydrate credentials (store copy may be secret-stripped). If we can't get
    // valid creds, do NOT prompt — a credential-less server check would report
    // 0 messages and false-positive the restore offer.
    const resolved = await resolveServerAccount(account.id, account);
    if (!resolved.ok) return;
    const fullAccount = resolved.account;

    // `mailboxes` items may be objects ({ path, name, ... }) or raw strings.
    // Reduce each to a real mailbox-name string; fall back to a minimal set.
    const mailboxes = (getMailboxes() || [])
      .map((m) => m.path || m.name || m)
      .filter(Boolean);
    const folderNames = mailboxes.length ? mailboxes : ['INBOX', 'Sent'];

    const folders = [];
    let localTotal = 0;
    for (const mailbox of folderNames) {
      const localCount = await api.countLocalFolder(account.id, mailbox).catch(() => 0);
      if (localCount > 0) {
        folders.push({ mailbox, localCount });
        localTotal += localCount;
      }
    }

    let serverTotal = 0;
    for (const { mailbox } of folders) {
      const status = await api.checkMailboxStatus(fullAccount, mailbox).catch(() => ({ exists: 0 }));
      serverTotal += status?.exists || 0;
    }

    const hostChanged = !!account.previousImapHost;
    if (shouldPromptRestore({ hostChanged, localTotal, serverTotal })) {
      useSettingsStore.getState().setRestoreDetected({
        accountId: account.id,
        account: fullAccount,
        folders,
      });
    }
  } catch {
    /* detection is best-effort */
  }
}
