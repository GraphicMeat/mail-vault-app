import { ensureFreshToken, hasValidCredentials } from './authUtils.js';
import { getAccountCacheMailboxes } from './cacheManager.js';
import { mailboxDescendants, SUBTREE_PREFIX } from './workflows/mailboxTree.js';
import { _resolveMailboxPath, flattenMailboxes } from '../stores/slices/unifiedHelpers.js';

// Selectable folders for a server-side all-folders search. Container-only
// mailboxes cannot be SELECTed, and duplicate paths can appear in nested trees.
export function serverSearchTargets(mailboxes) {
  const paths = [];
  const seen = new Set();
  for (const box of flattenMailboxes(mailboxes)) {
    if (box.noselect || !box.path || seen.has(box.path)) continue;
    seen.add(box.path);
    paths.push(box.path);
  }
  paths.sort((a, b) => (/^inbox$/i.test(a) ? -1 : 0) - (/^inbox$/i.test(b) ? -1 : 0));
  return paths;
}

function currentMailbox(mail) {
  if (mail?.unifiedInbox) return mail.unifiedFolder || 'INBOX';
  if (mail?.activeMailbox && mail.activeMailbox !== 'UNIFIED') return mail.activeMailbox;
  return mail?.unifiedFolder || 'INBOX';
}

function resolveMailbox(mailboxes, folder) {
  return _resolveMailboxPath(mailboxes, folder || 'INBOX');
}

function selectableExplicitPath(mailboxes, folder) {
  const path = resolveMailbox(mailboxes, folder);
  const flat = flattenMailboxes(mailboxes);
  if (flat.some(box => box.path === path && box.noselect)) return [];
  return [path];
}

export function resolveServerScope(_account, tree, mail, folder) {
  const scope = folder || 'current';
  if (scope === 'all') return serverSearchTargets(tree);

  if (String(scope).startsWith(SUBTREE_PREFIX)) {
    const root = resolveMailbox(tree, String(scope).slice(SUBTREE_PREFIX.length));
    const branch = new Set(mailboxDescendants(root, flattenMailboxes(tree)));
    return serverSearchTargets(tree).filter(path => branch.has(path));
  }

  const selected = scope === 'current' ? currentMailbox(mail) : scope;
  return selectableExplicitPath(tree, selected);
}

export function resolveLocalScope(tree, mail, folder) {
  const scope = folder || 'current';
  if (scope === 'all') return null;

  if (String(scope).startsWith(SUBTREE_PREFIX)) {
    const root = resolveMailbox(tree, String(scope).slice(SUBTREE_PREFIX.length));
    return mailboxDescendants(root, flattenMailboxes(tree));
  }

  const selected = scope === 'current' ? currentMailbox(mail) : scope;
  return [resolveMailbox(tree, selected)];
}

export async function mailboxTreeFor(accountId, mail) {
  if (accountId === mail?.activeAccountId) return mail.mailboxes ?? [];
  return getAccountCacheMailboxes(accountId) ?? [];
}

export async function buildSearchTargets(mail, settings, searchFilters) {
  const folder = searchFilters?.folder || 'current';
  const crossAccountUnifiedScope = mail.unifiedInbox && (folder === 'current' || folder === 'all');
  const visibleAccounts = (mail.accounts || []).filter(account => !settings?.hiddenAccounts?.[account.id]);
  const accounts = visibleAccounts.filter(account =>
    crossAccountUnifiedScope || account.id === mail.activeAccountId);

  return Promise.all(accounts.map(async account => {
    const tree = await mailboxTreeFor(account.id, mail);
    const serverMailboxes = resolveServerScope(account, tree, mail, folder);
    const canSearchServer = account.oauth2Transport !== 'graph' && hasValidCredentials(account);
    return {
      accountId: account.id,
      account: canSearchServer ? await ensureFreshToken(account) : null,
      localMailboxes: resolveLocalScope(tree, mail, folder),
      knownMailboxes: serverSearchTargets(tree),
      serverMailboxes: canSearchServer ? serverMailboxes : [],
    };
  }));
}
