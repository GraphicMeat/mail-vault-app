// The daemon selects closed folders; the renderer merges rows for display.
import { send } from '../transport';
import { isGraphAccount } from '../graphConfig';

const ADAPTER_BUDGET_MS = 126_000;
const generations = new Map();
const invalidatedAt = new Map();
const publishedAt = new Map();

function advance(accountId) {
  const generation = (generations.get(accountId) || 0) + 1;
  generations.set(accountId, generation);
  return generation;
}

function bounded(work) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('errors.connectionFailed')), ADAPTER_BUDGET_MS);
  });
  let task;
  try { task = Promise.resolve(work()); }
  catch (error) { task = Promise.reject(error); }
  return Promise.race([task, expired])
    .finally(() => clearTimeout(timer));
}

export async function refreshFolderStatus(account, mailboxes, activeMailbox) {
  if (!account?.id || isGraphAccount(account)) return null;
  const accountId = account.id;
  const generation = advance(accountId);
  const result = await bounded(() => send('folders.status', {
    op: 'refresh', accountId, activeMailbox: activeMailbox ?? null,
    mailboxes: Array.isArray(mailboxes) ? mailboxes : [],
  }));
  if (result === null) return null;
  if (!Array.isArray(result?.rows)) throw new Error('errors.connectionFailed');
  const byPath = Object.fromEntries(result.rows
    .filter(row => row && typeof row.path === 'string')
    .map(row => [row.path, row]));
  const { useMailStore } = await import('../../stores/mailStore');
  let published = false;
  useMailStore.setState(state => {
    if (generation <= (invalidatedAt.get(accountId) || 0)
      || generation < (publishedAt.get(accountId) || 0)
      || state.accounts?.find(item => item.id === accountId) !== account) return state;
    publishedAt.set(accountId, generation);
    published = true;
    return { folderStatus: {
      ...(state.folderStatus || {}),
      [accountId]: { ...((state.folderStatus || {})[accountId] || {}), ...byPath },
    } };
  });
  return published ? byPath : null;
}

export function invalidateFolderStatus(accountId) {
  if (!accountId) return Promise.resolve({ invalidated: false });
  invalidatedAt.set(accountId, advance(accountId));
  return bounded(async () => {
    const result = await send('folders.status', { op: 'invalidate', accountId });
    if (result?.invalidated !== true) throw new Error('errors.connectionFailed');
    return result;
  }).catch(() => ({ invalidated: false }));
}
