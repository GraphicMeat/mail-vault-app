// ── folderOps — create / rename / delete a folder, on the server and in the vault ──
//
// "Delete" is Thunderbird's: RENAME under Trash, keeping the leaf; only a
// folder already under Trash is DELETEd for real, behind a confirm. The vault
// never loses a directory — renames follow the server path so the Maildir,
// the index, the sidecar cache and the mirror stay addressable by the folder's
// new name. One pair per descendant: two of the four local locations are flat
// per full path (sanitized), not nested, so a child that gets no pair of its
// own never moves.
import * as api from '../api';
import { ensureFreshToken } from '../authUtils';
import { isGraphAccount } from '../graphConfig';
import { forceMailboxRefetch } from './helpers/mailboxRefetch';
import { encodeImapUtf7 } from '../../utils/imapUtf7';
import { t as tr } from '../../i18n/index.js';

export const folderDelimiter = (mailboxes) => mailboxes?.find(m => m.delimiter)?.delimiter || '/';
export const trashPathOf = (mailboxes) => mailboxes?.find(m => m.specialUse === '\\Trash')?.path || null;
export const specialOrInbox = (node) => node.path === 'INBOX' || !!node.specialUse;

// A NIL delimiter is a namespace with no hierarchy at all: nothing can sit
// under anything, so "move it under Trash" has no destination to name.
// `folderDelimiter` still answers "/" for the callers that only need a
// separator to print; this is the question that has to be asked before a path
// is built out of one.
const hasHierarchy = (mailboxes) => (mailboxes || []).some(m => m.delimiter);

const isUnder = (path, ancestor, d) => path === ancestor || path.startsWith(ancestor + d);
const descendantsOf = (mailboxes, path, d) =>
  mailboxes.filter(m => m.path !== path && isUnder(m.path, path, d)).map(m => m.path);
const renamePairs = (mailboxes, from, to, d) =>
  [from, ...descendantsOf(mailboxes, from, d)].map(p => ({ from: p, to: to + p.slice(from.length) }));

// CR/LF as well as the delimiter: `quote_mailbox` in src-core refuses them
// outright, and a newline in a mailbox name is how a second IMAP command gets
// spliced onto the wire.
function validName(name, d) {
  const n = (name || '').trim();
  if (!n || n.includes(d) || /[\r\n]/.test(n)) {
    throw new Error(tr('errors.folderNameInvalid', { delimiter: d }));
  }
  return encodeImapUtf7(n);
}

async function _ctx(accountId) {
  const { useMailStore } = await import('../../stores/mailStore');
  const s = useMailStore.getState();
  const account = await ensureFreshToken(s.accounts.find(a => a.id === accountId));
  return { s, account, mailboxes: s.mailboxes || [], d: folderDelimiter(s.mailboxes), email: account?.email || null };
}

// After any change: the server is the source of truth for the list, and the
// open folder may have moved or gone.
async function _settle(s, accountId, nextMailbox) {
  forceMailboxRefetch(accountId);
  await s.activateAccount(accountId, nextMailbox);
}

// The server op has already landed by the time this runs, so a vault failure
// must not also strand the sidebar on the old name: the error is captured, the
// list still refreshes, and the caller re-throws it into the error toast — the
// user has to learn the vault is half-moved.
async function _moveVaultDirs(accountId, email, pairs) {
  try {
    await api.vaultRenameMailbox(accountId, email, pairs);
    return null;
  } catch (e) {
    return e;
  }
}

const graphIdOf = (mailboxes, path) => mailboxes.find(m => m.path === path)?._graphFolderId;

export async function createFolder(accountId, parentPath, displayName) {
  const { s, account, mailboxes, d } = await _ctx(accountId);
  const leaf = validName(displayName, d);
  const path = parentPath ? `${parentPath}${d}${leaf}` : leaf;
  if (isGraphAccount(account)) {
    // Graph names folders, it does not path them: the display name goes over
    // as the user typed it and the parent is an id.
    await api.graphCreateFolder(account.oauth2AccessToken, displayName.trim(), parentPath ? graphIdOf(mailboxes, parentPath) || null : null);
  } else {
    await api.createMailbox(account, path);
  }
  await _settle(s, accountId, s.activeMailbox);
  return path;
}

export async function renameFolder(accountId, path, displayName) {
  const { s, account, mailboxes, d, email } = await _ctx(accountId);
  const leaf = validName(displayName, d);
  const parent = path.includes(d) ? path.slice(0, path.lastIndexOf(d) + 1) : '';
  const to = parent + leaf;
  if (isGraphAccount(account)) {
    await api.graphRenameFolder(account.oauth2AccessToken, graphIdOf(mailboxes, path), displayName.trim());
  } else {
    await api.renameMailbox(account, path, to);
  }
  const vaultError = await _moveVaultDirs(accountId, email, renamePairs(mailboxes, path, to, d));
  const active = s.activeMailbox;
  await _settle(s, accountId, isUnder(active, path, d) ? to + active.slice(path.length) : active);
  if (vaultError) throw vaultError;
  return to;
}

export async function deleteFolder(accountId, path) {
  const { s, account, mailboxes, d, email } = await _ctx(accountId);
  const trash = trashPathOf(mailboxes);
  if (!trash || !hasHierarchy(mailboxes)) throw new Error(tr('errors.noTrashFolder'));
  const active = s.activeMailbox;
  const next = isUnder(active, path, d) ? 'INBOX' : active;

  if (isUnder(path, trash, d)) {
    // Already in the bin — this is the real DELETE, and the vault directories
    // go with the folder rather than following it somewhere.
    const paths = [path, ...descendantsOf(mailboxes, path, d)];
    if (isGraphAccount(account)) {
      for (const p of paths.slice().reverse()) {
        await api.graphDeleteFolder(account.oauth2AccessToken, graphIdOf(mailboxes, p));
      }
    } else {
      await api.deleteMailbox(account, paths);
    }
    await _settle(s, accountId, next);
    return { deleted: paths.length };
  }

  const to = `${trash}${d}${path.split(d).pop()}`;
  if (isGraphAccount(account)) {
    // Graph's own DELETE on a folder outside Deleted Items is a move anyway;
    // saying so explicitly keeps the two cases apart.
    await api.graphMoveFolder(account.oauth2AccessToken, graphIdOf(mailboxes, path), 'deleteditems');
  } else {
    await api.renameMailbox(account, path, to);
  }
  const vaultError = await _moveVaultDirs(accountId, email, renamePairs(mailboxes, path, to, d));
  await _settle(s, accountId, next);
  if (vaultError) throw vaultError;
  return { movedTo: to };
}
