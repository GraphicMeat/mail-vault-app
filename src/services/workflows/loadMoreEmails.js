// ── loadMoreEmails workflow — pagination and range loading ──

import * as db from '../db';
import * as api from '../api';
import { ensureFreshToken, resolveServerAccount } from '../authUtils';
import { getSyncStatus } from '../syncService';
import { saveRestoreDescriptor as _saveRestore } from '../cacheManager';
import { _buildRestoreDescriptor } from '../../stores/slices/unifiedHelpers';
import {
  getLoadMoreTimer, setLoadMoreTimer,
} from '../../stores/slices/messageListSlice';
import { mergeRanges, evictExcess } from './helpers/rangeLoading';

// Module-level range retry state
const _rangeRetryDelays = new Map();

// How many 1s waits we'll grant a daemon backfill before paginating ourselves.
// The daemon is meant to clear `backfilling` when it stops, but a daemon that
// wedges must never leave the list spinning with nothing fetching.
const MAX_BACKFILL_WAITS = 60;
const _backfillWaits = new Map();


const PAGE_SIZE = 200;

/**
 * Drain everything the sidecar cache holds beyond what's already in the store,
 * in ONE read. Returns null when the cache has nothing left to give, so the
 * caller falls back to server pagination for the remainder.
 */
async function _drainCache(accountId, mailbox, loadedCount) {
  try {
    const meta = await db.getEmailHeadersMeta(accountId, mailbox);
    const totalCached = meta?.totalCached || 0;
    if (totalCached <= loadedCount) return null;

    const cached = await db.getEmailHeadersPartial(accountId, mailbox, totalCached);
    const rest = cached?.emails?.slice(loadedCount);
    if (!rest?.length) return null;

    const loaded = loadedCount + rest.length;
    const total = Math.max(meta?.totalEmails || 0, loaded);
    return {
      emails: rest.map(e => ({ ...e, source: e.source || 'cache' })),
      total,
      loaded,
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
    const drained = await _drainCache(activeAccountId, activeMailbox, emails.length);
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
      const updatedServerUidSet = new Set(current.serverUidSet);
      for (const e of drained.emails) updatedServerUidSet.add(e.uid);
      useMailStore.setState({
        emails: [...current.emails, ...freshCached],
        // floor, not ceil: a partial page must be re-requested from the server
        // (overlap is deduped below) or the next page would skip messages.
        currentPage: Math.floor(drained.loaded / PAGE_SIZE),
        hasMoreEmails: drained.hasMore,
        totalEmails: drained.total,
        loadingMore: false,
        serverUidSet: updatedServerUidSet,
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
      const updatedServerUidSet = new Set(current.serverUidSet);
      for (const e of serverResult.emails) updatedServerUidSet.add(e.uid);
      useMailStore.setState({
        emails: newEmails,
        currentPage: nextPage,
        hasMoreEmails: serverResult.hasMore,
        totalEmails: serverResult.total,
        loadingMore: false,
        serverUidSet: updatedServerUidSet
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
        console.warn(`[loadMoreEmails] ${serverResult.skippedUids.length} messages skipped on page ${nextPage}, will re-request`);
        useMailStore.setState({ currentPage: nextPage - 1, hasMoreEmails: true });
        let timer = getLoadMoreTimer();
        if (timer) clearTimeout(timer);
        setLoadMoreTimer(setTimeout(() => { setLoadMoreTimer(null); get().loadMoreEmails(); }, 5000));
      } else if (serverResult.hasMore) {
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


// ── loadEmailRange workflow ──

export async function loadEmailRange(startIndex, endIndex) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const { activeAccountId, accounts, activeMailbox, loadedRanges, loadingRanges, savedEmailIds } = get();
  let account = accounts.find(a => a.id === activeAccountId);
  account = await ensureFreshToken(account);

  const hasCredentials = account && (account.password || (account.authType === 'oauth2' && account.oauth2AccessToken));
  if (!hasCredentials) return;

  // Check if this range is already loaded
  const isRangeLoaded = (start, end) => {
    for (const range of loadedRanges) {
      if (range.start <= start && range.end >= end) return true;
    }
    return false;
  };

  if (isRangeLoaded(startIndex, endIndex)) return;

  const rangeKey = `${startIndex}-${endIndex}`;
  if (loadingRanges.has(rangeKey)) return;

  const newLoadingRanges = new Set(loadingRanges);
  newLoadingRanges.add(rangeKey);
  useMailStore.setState({ loadingRanges: newLoadingRanges });

  try {
    const result = await api.fetchEmailsRange(account, activeMailbox, startIndex, endIndex);

    const previousTotal = get().totalEmails;
    if (previousTotal > 0 && result.total !== previousTotal) {
      console.warn(`[loadEmailRange] Mailbox total changed (${previousTotal} -> ${result.total}), restarting`);
      const loadingRangesAfter = new Set(get().loadingRanges);
      loadingRangesAfter.delete(rangeKey);
      useMailStore.setState({ loadingRanges: loadingRangesAfter });
      get().loadEmails();
      return;
    }

    if (result.emails && result.emails.length > 0) {
      const currentEmails = get().emails;
      const existingUids = new Set(currentEmails.map(e => e.uid));

      const newEntries = [];
      for (const email of result.emails) {
        if (!existingUids.has(email.uid)) {
          newEntries.push({ ...email, isLocal: savedEmailIds.has(email.uid), source: 'server' });
        }
      }

      const merged = [...currentEmails, ...newEntries];
      for (const e of merged) {
        if (e._ts === undefined) e._ts = new Date(e.date || e.internalDate || 0).getTime();
      }
      merged.sort((a, b) => b._ts - a._ts);

      const finalEmails = evictExcess(merged);

      const newLoadedRanges = [...get().loadedRanges, { start: startIndex, end: endIndex }];
      const mergedRanges = mergeRanges(newLoadedRanges);

      const loadingRangesAfter = new Set(get().loadingRanges);
      loadingRangesAfter.delete(rangeKey);
      const rangeServerUidSet = new Set(get().serverUidSet);
      for (const e of result.emails) rangeServerUidSet.add(e.uid);

      useMailStore.setState({
        loadedRanges: mergedRanges,
        loadingRanges: loadingRangesAfter,
        emails: finalEmails,
        totalEmails: result.total,
        serverUidSet: rangeServerUidSet
      });

      get().updateSortedEmails();

      // Only the range just fetched — see the note in loadMoreEmails.
      if (newEntries.length) {
        db.saveEmailHeaders(activeAccountId, activeMailbox, newEntries, result.total)
          .catch(e => console.warn('[loadEmailRange] Failed to cache headers:', e));
      }

      if (result.skippedUids && result.skippedUids.length > 0) {
        console.warn(`[loadEmailRange] ${result.skippedUids.length} messages skipped, scheduling retry for range ${startIndex}-${endIndex}`);
        setTimeout(() => {
          const currentRanges = get().loadedRanges.filter(r => !(r.start === startIndex && r.end === endIndex));
          useMailStore.setState({ loadedRanges: currentRanges });
          get().loadEmailRange(startIndex, endIndex);
        }, 5000);
      }
    }
  } catch (error) {
    console.error('[loadEmailRange] Failed:', error);
    const loadingRangesAfter = new Set(get().loadingRanges);
    loadingRangesAfter.delete(rangeKey);
    useMailStore.setState({ loadingRanges: loadingRangesAfter });

    const prevDelay = _rangeRetryDelays.get(rangeKey) || 0;
    const nextDelay = prevDelay === 0 ? 3000 : Math.min(prevDelay * 2, 120000);
    _rangeRetryDelays.set(rangeKey, nextDelay);
    console.log(`[loadEmailRange] Retrying range ${startIndex}-${endIndex} in ${nextDelay / 1000}s`);
    setTimeout(() => {
      _rangeRetryDelays.delete(rangeKey);
      get().loadEmailRange(startIndex, endIndex);
    }, nextDelay);
  }
}
