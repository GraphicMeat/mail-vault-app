// ── loadMoreEmails workflow — pagination ──

import * as db from '../db';
import * as api from '../api';
import { resolveServerAccount } from '../authUtils';
import { getSyncStatus } from '../syncService';
import { saveRestoreDescriptor as _saveRestore } from '../cacheManager';
import { _buildRestoreDescriptor } from '../../stores/slices/unifiedHelpers';
import { serverUids } from '../../stores/slices/serverUids';
import {
  getLoadMoreTimer, setLoadMoreTimer,
} from '../../stores/slices/messageListSlice';

// How many 1s waits we'll grant a daemon backfill before paginating ourselves.
// The daemon is meant to clear `backfilling` when it stops, but a daemon that
// wedges must never leave the list spinning with nothing fetching.
const MAX_BACKFILL_WAITS = 60;
const _backfillWaits = new Map();


const PAGE_SIZE = 200;

/**
 * Pull whatever the sidecar cache holds that the store doesn't, reading ONLY the
 * missing UIDs.
 *
 * This used to re-read the entire mailbox on every call — `load_email_cache_partial`
 * with limit = totalCached, which is one file read plus one JSON parse per
 * message — and then `slice(loadedCount)` off the front. While the daemon
 * backfills, that runs every 200ms: the backfill lands 100 new sidecars, the
 * drain reads 13,796 files to find them, and the next tick reads 13,896. The
 * counter crawls because each small step costs a full-mailbox disk walk.
 *
 * Now: one readdir for the UID list, then a read per message actually missing.
 * On a cold start that's the same work as before; on the incremental steps that
 * make up a backfill it's ~100 reads instead of ~14,000.
 *
 * Taking the UIDs the store holds rather than a count also drops the old
 * assumption that the store was exactly the top N of the cache by UID — the
 * slice silently skipped messages whenever it wasn't.
 */
export async function _drainCache(accountId, mailbox, loadedUids) {
  try {
    const meta = await db.getEmailHeadersMeta(accountId, mailbox);
    const totalCached = meta?.totalCached || 0;
    // Keep the count gate. Without it a stale cache row the reconcile has not
    // pruned yet (gone from the server) drains straight back into the list.
    // It never hid an arrival: the IDLE watcher announces arrivals before the
    // reconcile prunes (`sync_account_announcing`), so at that moment the
    // cache holds every old row plus the new one and outnumbers the store.
    if (totalCached <= loadedUids.size) return null;

    const listing = await db.listCachedUids(accountId, mailbox);
    if (!listing?.uids?.length) return null;

    const missing = listing.uids
      .filter(uid => !loadedUids.has(uid))
      .sort((a, b) => b - a); // newest first, same order the list renders in
    if (!missing.length) return null;

    const rows = await db.getEmailHeadersByUids(accountId, mailbox, missing);
    if (!rows.length) return null;

    const loaded = loadedUids.size + rows.length;
    const total = Math.max(meta?.totalEmails || 0, loaded);
    return {
      emails: rows.map(e => ({ ...e, source: e.source || 'cache' })),
      total,
      loaded,
      cached: totalCached,
      hasMore: loaded < total,
    };
  } catch (e) {
    console.warn('[loadMoreEmails] Cache drain failed, falling back to server:', e);
    return null;
  }
}


const _waitKey = (accountId, mailbox) => `${accountId}${mailbox}`;

/**
 * True while the daemon is still filling this mailbox's cache from the server.
 * Checks the cheap local signal first — a cache that already covers the mailbox
 * can't be mid-backfill, so healthy mailboxes never pay for an RPC.
 */
async function _daemonIsBackfilling(accountId, mailbox) {
  const key = _waitKey(accountId, mailbox);
  try {
    const meta = await db.getEmailHeadersMeta(accountId, mailbox);
    if (!meta?.totalEmails || (meta.totalCached || 0) >= meta.totalEmails) {
      _backfillWaits.delete(key);
      return false;
    }
    const status = await getSyncStatus(accountId);
    if (!status?.backfilling) {
      _backfillWaits.delete(key);
      return false;
    }

    const waits = (_backfillWaits.get(key) || 0) + 1;
    _backfillWaits.set(key, waits);
    if (waits > MAX_BACKFILL_WAITS) {
      console.warn(`[loadMoreEmails] Daemon still reports backfilling after ${waits}s — paginating anyway`);
      return false;
    }
    return true;
  } catch {
    _backfillWaits.delete(key);
    return false; // daemon down or RPC failed — fall through to server pagination
  }
}


// ── loadMoreEmails workflow ──

export async function loadMoreEmails() {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const { activeAccountId, accounts, activeMailbox, emails, currentPage, hasMoreEmails, loadingMore } = get();
  let account = accounts.find(a => a.id === activeAccountId);

  if (!account || loadingMore || !hasMoreEmails) return;

  const resolved = await resolveServerAccount(account.id, account);
  if (!resolved.ok) return;
  account = resolved.account;

  if (!navigator.onLine) {
    useMailStore.setState({ _loadMorePausedOffline: true });
    return;
  }

  useMailStore.setState({ loadingMore: true });

  try {
    const nextPage = currentPage + 1;

    // Cache-first: the sidecar cache usually already holds the whole mailbox,
    // so paginating from the server re-downloads headers we have on disk —
    // on a 14k inbox that was ~70 IMAP round-trips (each re-saving the whole
    // header list) after every launch.
    const drained = await _drainCache(
      activeAccountId, activeMailbox, new Set(emails.map(e => e.uid))
    );
    if (drained) {
      const current = get();
      if (current.activeAccountId !== activeAccountId || current.activeMailbox !== activeMailbox) {
        useMailStore.setState({ loadingMore: false });
        return;
      }
      // Dedupe against the live store — activateAccount may have committed
      // headers while the cache read was in flight.
      const loadedUids = new Set(current.emails.map(e => e.uid));
      const freshCached = drained.emails.filter(e => !loadedUids.has(e.uid));
      const updatedServerUidSet = new Set(current.serverUids.uids);
      for (const e of drained.emails) updatedServerUidSet.add(e.uid);
      useMailStore.setState({
        emails: [...current.emails, ...freshCached],
        // floor, not ceil: a partial page must be re-requested from the server
        // (overlap is deduped below) or the next page would skip messages.
        currentPage: Math.floor(drained.loaded / PAGE_SIZE),
        hasMoreEmails: drained.hasMore,
        totalEmails: drained.total,
        cachedCount: drained.cached,
        loadingMore: false,
        // Widening, never replacing: a complete set stays complete, an
        // incomplete one stays incomplete. Stated, not inherited.
        serverUids: serverUids(updatedServerUidSet, { complete: current.serverUids.complete }),
      });
      get().updateSortedEmails();
      // Progress — the backfill is alive, so it gets a fresh wait budget.
      _backfillWaits.delete(_waitKey(activeAccountId, activeMailbox));
      // No saveEmailHeaders — these headers came from that very cache.
      console.log('[loadMoreEmails] Drained %d headers from cache (%d/%d loaded)',
        drained.emails.length, drained.loaded, drained.total);
      if (drained.hasMore) {
        const timer = getLoadMoreTimer();
        if (timer) clearTimeout(timer);
        setLoadMoreTimer(setTimeout(() => { setLoadMoreTimer(null); get().loadMoreEmails(); }, 200));
      }
      return;
    }

    // The cache has nothing left, but is it actually complete? A restored or
    // migrated mailbox can hold 500 sidecars out of 15,000 — the daemon fills
    // the rest in the background, and paginating the server in parallel would
    // just re-download what it is already writing.
    if (await _daemonIsBackfilling(activeAccountId, activeMailbox)) {
      useMailStore.setState({ loadingMore: false });
      const timer = getLoadMoreTimer();
      if (timer) clearTimeout(timer);
      setLoadMoreTimer(setTimeout(() => { setLoadMoreTimer(null); get().loadMoreEmails(); }, 1000));
      return;
    }

    const serverResult = await api.fetchEmails(account, activeMailbox, nextPage);

    useMailStore.setState({ _loadMoreRetryDelay: 0 });

    const previousTotal = get().totalEmails;
    if (previousTotal > 0 && serverResult.total !== previousTotal) {
      console.warn(`[loadMoreEmails] Mailbox total changed (${previousTotal} -> ${serverResult.total}), restarting pagination`);
      useMailStore.setState({ loadingMore: false });
      get().loadEmails();
      return;
    }

    const updateState = () => {
      const current = get();
      if (current.activeAccountId !== activeAccountId || current.activeMailbox !== activeMailbox) {
        useMailStore.setState({ loadingMore: false });
        return;
      }

      // Dedupe: a page can overlap what's already loaded when the store was
      // seeded from a cache whose size isn't a multiple of PAGE_SIZE.
      const existingUids = new Set(current.emails.map(e => e.uid));
      const freshEmails = serverResult.emails.filter(e => !existingUids.has(e.uid));
      const newEmails = [...current.emails, ...freshEmails];
      const updatedServerUidSet = new Set(current.serverUids.uids);
      for (const e of serverResult.emails) updatedServerUidSet.add(e.uid);
      useMailStore.setState({
        emails: newEmails,
        currentPage: nextPage,
        hasMoreEmails: serverResult.hasMore,
        totalEmails: serverResult.total,
        loadingMore: false,
        // Widening only — carry the existing completeness claim forward.
        serverUids: serverUids(updatedServerUidSet, { complete: current.serverUids.complete })
      });

      get().updateSortedEmails();

      // Persist only this page. The cache is per-UID sidecars and a superset of
      // the store, so re-writing the whole accumulated list every page made the
      // save quadratic — page N rewrote N×200 files (~540k writes for a 15k
      // mailbox), which is most of what made a cold backfill feel endless.
      if (freshEmails.length) {
        db.saveEmailHeaders(activeAccountId, activeMailbox, freshEmails, serverResult.total)
          .catch(e => console.warn('[loadMoreEmails] Failed to cache headers:', e));
      }

      if (serverResult.skippedUids && serverResult.skippedUids.length > 0) {
        // A row the server described in a form the parser cannot read. The
        // parser reproduces that on every fetch, so re-requesting the page
        // would loop for ever; the row is left out and named in the daemon log.
        console.warn(`[loadMoreEmails] ${serverResult.skippedUids.length} unreadable message(s) left out of page ${nextPage}`);
      }
      if (serverResult.hasMore) {
        let timer = getLoadMoreTimer();
        if (timer) clearTimeout(timer);
        setLoadMoreTimer(setTimeout(() => { setLoadMoreTimer(null); get().loadMoreEmails(); }, 200));
      }
    };

    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(updateState, { timeout: 2000 });
    } else {
      setTimeout(updateState, 50);
    }
  } catch (error) {
    console.error('[loadMoreEmails] Failed to load more emails:', error);
    useMailStore.setState({ loadingMore: false });

    if (get().hasMoreEmails && get().emails.length < get().totalEmails) {
      const prevDelay = get()._loadMoreRetryDelay || 0;
      const nextDelay = prevDelay === 0 ? 3000 : Math.min(prevDelay * 2, 120000);
      useMailStore.setState({ _loadMoreRetryDelay: nextDelay });
      console.log(`[loadMoreEmails] Will retry in ${nextDelay / 1000}s...`);
      let timer = getLoadMoreTimer();
      if (timer) clearTimeout(timer);
      setLoadMoreTimer(setTimeout(() => { setLoadMoreTimer(null); get().loadMoreEmails(); }, nextDelay));
    }
  }
}
