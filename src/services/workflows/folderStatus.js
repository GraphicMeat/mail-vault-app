// The daemon selects closed folders; the renderer merges rows for display.
import { send } from '../transport';
import { isGraphAccount } from '../graphConfig';
import { accountExpectedContext } from '../db/accounts';

const ADAPTER_BUDGET_MS = 126_000;
const generations = new Map();
const invalidatedAt = new Map();
const publishedAt = new Map();

function advance(accountId) {
  const generation = (generations.get(accountId) || 0) + 1;
  generations.set(accountId, generation);
  return generation;
}

function matchesContext(account, context) {
  return !!account
    && Object.entries(context.fields).every(([key, value]) => account[key] === value)
    && context.absent.every(key => account[key] === undefined);
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
  const context = accountExpectedContext(account, 'all');
  const generation = advance(accountId);
  const { useMailStore } = await import('../../stores/mailStore');
  let invalidated = false;
  const observe = state => {
    if (invalidated) return;
    const current = state.accounts?.find(item => item.id === accountId);
    if (!matchesContext(current, context)) {
      invalidated = true;
      invalidatedAt.set(accountId, advance(accountId));
    }
  };
  const unsubscribe = useMailStore.subscribe(observe);
  try {
    observe(useMailStore.getState());
    const result = await bounded(() => send('folders.status', {
      op: 'refresh', accountId, activeMailbox: activeMailbox ?? null,
      mailboxes: Array.isArray(mailboxes) ? mailboxes : [],
    }));
    if (result === null) return null;
    if (!Array.isArray(result?.rows)) throw new Error('errors.connectionFailed');
    const byPath = Object.fromEntries(result.rows
      .filter(row => row && typeof row.path === 'string')
      .map(row => [row.path, row]));
    let published = false;
    useMailStore.setState(state => {
      const current = state.accounts?.find(item => item.id === accountId);
      if (generation <= (invalidatedAt.get(accountId) || 0)
        || generation < (publishedAt.get(accountId) || 0)
        || !matchesContext(current, context)) return state;
      publishedAt.set(accountId, generation);
      published = true;
      return { folderStatus: {
        ...(state.folderStatus || {}),
        [accountId]: { ...((state.folderStatus || {})[accountId] || {}), ...byPath },
      } };
    });
    return published ? byPath : null;
  } finally {
    unsubscribe();
  }
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
