// ── prefetch workflow — background mailbox/cache warm-up for inactive accounts ──

import * as db from '../db';
import { useSettingsStore } from '../../stores/settingsStore';
import { saveRestoreDescriptor as _saveRestore, getRestoreDescriptor as _getRestore } from '../cacheManager';
import { fetchAccountMailboxes, shouldUseFreshMailboxCache, isSuspiciousEmptyMailboxResult, MAILBOX_PREFETCH_LIMIT } from './activateAccount';


// ── _prefetchAllMailboxes workflow ──

export async function _prefetchAllMailboxes({ limit = MAILBOX_PREFETCH_LIMIT } = {}) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const { accounts, activeAccountId } = get();
  const { hiddenAccounts } = useSettingsStore.getState();

  const otherAccounts = accounts.filter(a =>
    a.id !== activeAccountId && !hiddenAccounts[a.id]
  );

  if (otherAccounts.length === 0) return;
  const mailboxEntries = await Promise.all(otherAccounts.map(async account => ({
    account,
    entry: await db.getCachedMailboxEntry(account.id).catch(() => null),
  })));
  const staleAccounts = mailboxEntries
    .filter(({ entry }) => !shouldUseFreshMailboxCache(entry))
    .sort((a, b) => (a.entry?.fetchedAt || 0) - (b.entry?.fetchedAt || 0))
    .slice(0, limit);

  if (staleAccounts.length === 0) return;
  console.log('[prefetch] Pre-fetching mailboxes for', staleAccounts.length, 'background accounts');

  await Promise.allSettled(staleAccounts.map(async ({ account, entry }) => {
    try {
      if (shouldUseFreshMailboxCache(entry)) return;
      const mailboxes = await fetchAccountMailboxes(account);

      if (isSuspiciousEmptyMailboxResult(mailboxes, entry)) {
        console.warn(`[prefetch] Server returned [] mailboxes for ${account.email} — skipping persist (prior cache had data)`);
        return;
      }

      await db.saveMailboxes(account.id, mailboxes);
      const cachedDesc = _getRestore(account.id, 'INBOX', 'all');
      if (cachedDesc) {
        _saveRestore({ ...cachedDesc, mailboxes, mailboxesFetchedAt: Date.now() });
      }
    } catch (e) {
      console.warn(`[prefetch] Mailbox fetch failed for ${account.email} (non-fatal):`, e.message);
    }
  }));
  console.log('[prefetch] Mailbox pre-fetch complete');
}


// ── _prewarmAccountCaches workflow ──

export async function _prewarmAccountCaches() {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const { accounts, activeAccountId } = get();
  const { hiddenAccounts } = useSettingsStore.getState();

  const otherAccounts = accounts.filter(a =>
    a.id !== activeAccountId && !hiddenAccounts[a.id]
  );

  if (otherAccounts.length === 0) return;
  console.log('[prewarm] Pre-warming account cache for', otherAccounts.length, 'background accounts');

  await Promise.allSettled(otherAccounts.map(async (account) => {
    if (_getRestore(account.id, 'INBOX', 'all')) return;

    try {
      const [cachedHeaders, archivedEmailIds, savedEmailIds, cachedMailboxEntry] = await Promise.all([
        db.getEmailHeadersPartial(account.id, 'INBOX', 500),
        db.getArchivedEmailIds(account.id, 'INBOX'),
        db.getSavedEmailIds(account.id, 'INBOX'),
        db.getCachedMailboxEntry(account.id).catch(() => null),
      ]);
      if (!cachedHeaders || !cachedHeaders.emails || cachedHeaders.emails.length === 0) return;

      const cachedMailboxes = cachedMailboxEntry?.mailboxes || null;

      let localEmails = [];
      if (archivedEmailIds.size > 0) {
        try {
          localEmails = await db.readLocalEmailIndex(account.id, 'INBOX') ||
            await db.getArchivedEmails(account.id, 'INBOX', archivedEmailIds);
        } catch (e) {
          console.warn(`[prewarm] Failed to load local emails for ${account.email}:`, e.message);
        }
      }

      _saveRestore({
        accountId: account.id,
        mailbox: 'INBOX',
        viewMode: 'all',
        totalEmails: cachedHeaders.totalEmails || cachedHeaders.emails.length,
        topVisibleIndex: 0,
        selectedUid: null,
        mailboxes: cachedMailboxes || [],
        mailboxesFetchedAt: cachedMailboxEntry?.fetchedAt ?? null,
        firstWindow: cachedHeaders.emails.slice(0, 50),
        firstWindowSavedUids: cachedHeaders.emails.slice(0, 50)
          .filter(e => savedEmailIds.has(e.uid)).map(e => e.uid),
        firstWindowArchivedUids: cachedHeaders.emails.slice(0, 50)
          .filter(e => archivedEmailIds.has(e.uid)).map(e => e.uid),
        timestamp: Date.now(),
      });
      const unread = cachedHeaders.emails.filter(e => !e.flags?.includes('\\Seen')).length;
      useSettingsStore.getState().setUnreadForAccount(account.id, unread);

      console.log('[prewarm] Cached', cachedHeaders.emails.length, 'headers +', localEmails.length, 'local emails for', account.email);
    } catch (e) {
      console.warn(`[prewarm] Failed for ${account.email} (non-fatal):`, e.message);
    }
  }));
  console.log('[prewarm] Account cache pre-warm complete');
}
