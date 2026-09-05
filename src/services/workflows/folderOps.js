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
import { isGraphAccount, normalizeGraphFolderName } from '../graphConfig';
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

const nodeAt = (mailboxes, path) => mailboxes.find(m => m.path === path);
const graphIdOf = (mailboxes, path) => nodeAt(mailboxes, path)?._graphFolderId;

// INBOX and every special-use folder are undeletable/unrenamable — the
// context menu already disables those actions, but this is the workflow
// itself, reachable from anywhere (or a stale menu). A caller who reaches
// `deleteFolder(trashPathOf(mailboxes))` must be refused here, not fall into
// "already under Trash" and issue a real DELETE of Trash itself.
function guardLocked(mailboxes, path) {
  const node = nodeAt(mailboxes, path);
  if (node && specialOrInbox(node)) throw new Error(tr('errors.folderLocked'));
}

export async function createFolder(accountId, parentPath, displayName) {
  const { s, account, mailboxes, d } = await _ctx(accountId);
  const leaf = validName(displayName, d);
  const graph = isGraphAccount(account);
  // Graph names folders, it does not path them: a subfolder's path is just
  // normalizeGraphFolderName(displayName), flat, the same shape the refetch
  // will list it under — never the IMAP-shaped `parent + delimiter + leaf`.
  const path = graph ? normalizeGraphFolderName(displayName.trim()) : (parentPath ? `${parentPath}${d}${leaf}` : leaf);
  if (graph) {
    await api.graphCreateFolder(account.oauth2AccessToken, displayName.trim(), parentPath ? graphIdOf(mailboxes, parentPath) || null : null);
  } else {
    await api.createMailbox(account, path);
  }
  await _settle(s, accountId, s.activeMailbox);
  return path;
}

export async function renameFolder(accountId, path, displayName) {
  const { s, account, mailboxes, d, email } = await _ctx(accountId);
  guardLocked(mailboxes, path);
  const leaf = validName(displayName, d);
  const graph = isGraphAccount(account);
  // Same reasoning as createFolder: a Graph folder's path is its normalized
  // display name, flat. Using the IMAP-shaped `to` here would move the vault
  // directories to a path Graph's refetch never produces, silently orphaning
  // the Maildir, the index, the sidecar cache and the mirror.
  const to = graph
    ? normalizeGraphFolderName(displayName.trim())
    : (path.includes(d) ? path.slice(0, path.lastIndexOf(d) + 1) : '') + leaf;
  if (graph) {
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
  guardLocked(mailboxes, path);
  const trash = trashPathOf(mailboxes);
  if (!trash || !hasHierarchy(mailboxes)) throw new Error(tr('errors.noTrashFolder'));
  const active = s.activeMailbox;
  const next = isUnder(active, path, d) ? 'INBOX' : active;
  const graph = isGraphAccount(account);

  if (isUnder(path, trash, d)) {
    // Already in the bin — this is the real DELETE, and the vault directories
    // go with the folder rather than following it somewhere.
    const paths = [path, ...descendantsOf(mailboxes, path, d)];
    if (graph) {
      for (const p of paths.slice().reverse()) {
        await api.graphDeleteFolder(account.oauth2AccessToken, graphIdOf(mailboxes, p));
      }
    } else {
      await api.deleteMailbox(account, paths);
    }
    await _settle(s, accountId, next);
    return { deleted: paths.length };
  }

  if (graph) {
    // Graph's own "move to Deleted Items" does not rename the folder — its
    // display name, and the vault directory that matches it, never change.
    // Moving the vault directory to an IMAP-shaped Trash path here would
    // orphan it: nothing on the server ever produces that path.
    await api.graphMoveFolder(account.oauth2AccessToken, graphIdOf(mailboxes, path), 'deleteditems');
    await _settle(s, accountId, next);
    return { movedTo: path };
  }

  const to = `${trash}${d}${path.split(d).pop()}`;
  await api.renameMailbox(account, path, to);
  const vaultError = await _moveVaultDirs(accountId, email, renamePairs(mailboxes, path, to, d));
  await _settle(s, accountId, next);
  if (vaultError) throw vaultError;
  return { movedTo: to };
}
