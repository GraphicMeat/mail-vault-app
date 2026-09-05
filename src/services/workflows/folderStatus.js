// ── folderStatus workflow — unread counts for folders that are not open ──
//
// Thunderbird polls STATUS for every folder it watches; MailVault opened a
// folder (SELECT) to learn anything about it, so the sidebar had no counts
// until each folder was clicked. STATUS costs one round trip per folder on a
// background session and never changes the selected mailbox. The open
// folder's counts come from its own list, so it is left out.
import * as api from '../api';
import { isGraphAccount } from '../graphConfig';

const STATUS_FRESH_MS = 60 * 1000;
// One round trip per folder, all on one background session: a 59-folder
// Dovecot account is on record (bson73), and a sweep that long blocks that
// session for the rest of it. The sidebar's first screenful is what a count is
// for. ponytail: fixed cap, sweep the folders the user actually looks at if 50
// ever proves too few.
const MAX_STATUS_FOLDERS = 50;
const _lastRun = new Map(); // accountId -> timestamp of the last sweep

/** Paths STATUS may be sent for: selectable, and not the folder that is open. */
export function _flattenSelectable(mailboxes, activeMailbox) {
  const out = [];
  const visit = (nodes) => {
    for (const m of nodes || []) {
      if (!m.noselect && m.path !== activeMailbox) out.push(m.path);
      if (m.children?.length) visit(m.children);
    }
  };
  visit(mailboxes);
  return out;
}

export async function refreshFolderStatus(account, mailboxes, activeMailbox, { force = false } = {}) {
  if (!account || isGraphAccount(account)) return null;
  const last = _lastRun.get(account.id) || 0;
  if (!force && Date.now() - last < STATUS_FRESH_MS) return null;
  const paths = _flattenSelectable(mailboxes, activeMailbox).slice(0, MAX_STATUS_FOLDERS);
  if (paths.length === 0) return null;
  _lastRun.set(account.id, Date.now());

  const rows = await api.fetchFolderStatus(account, paths);
  const byPath = Object.fromEntries((rows || []).map(r => [r.path, r]));

  const { useMailStore } = await import('../../stores/mailStore');
  useMailStore.setState(s => ({
    folderStatus: {
      ...(s.folderStatus || {}),
      [account.id]: { ...((s.folderStatus || {})[account.id] || {}), ...byPath },
    },
  }));
  return byPath;
}

/** Tests only. */
export function _resetFolderStatusThrottle() {
  _lastRun.clear();
}
