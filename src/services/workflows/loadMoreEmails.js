// ── loadMoreEmails workflow — pagination and range loading ──

import * as db from '../db';
import * as api from '../api';
import { ensureFreshToken, resolveServerAccount } from '../authUtils';
import { saveRestoreDescriptor as _saveRestore } from '../cacheManager';
import { _buildRestoreDescriptor } from '../../stores/slices/unifiedHelpers';
import {
  getLoadMoreTimer, setLoadMoreTimer,
} from '../../stores/slices/messageListSlice';
import { mergeRanges, evictExcess } from './helpers/rangeLoading';

// Module-level range retry state
const _rangeRetryDelays = new Map();


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

      const newEmails = [...current.emails, ...serverResult.emails];
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

      if (!get().unifiedInbox) {
        _saveRestore(_buildRestoreDescriptor(get()));
      }

      db.saveEmailHeaders(activeAccountId, activeMailbox, newEmails, serverResult.total)
        .catch(e => console.warn('[loadMoreEmails] Failed to cache headers:', e));

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

      db.saveEmailHeaders(activeAccountId, activeMailbox, finalEmails, result.total)
        .catch(e => console.warn('[loadEmailRange] Failed to cache headers:', e));

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
