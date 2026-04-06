// ── cacheSlice — in-memory email body cache with LRU eviction ──

import { invalidateRestoreDescriptors as _invalidateRestore } from '../../services/cacheManager';
import { recordSize as _recordCacheSize, shouldPrefetch as _shouldPrefetch } from '../../services/cachePressure';

// Module-level cache size tracking — avoids mutating Zustand state outside set()
let _cacheCurrentSizeMB = 0;

// Expose for cross-slice reads (e.g. selectionSlice prefetch)
export function getCacheCurrentSizeMB() { return _cacheCurrentSizeMB; }
export { _shouldPrefetch };

export const createCacheSlice = (set, get) => ({
  // Email cache - stores full email content by key (accountId-mailbox-uid)
  // Each entry also stores timestamp for LRU eviction
  emailCache: new Map(), // Map<cacheKey, { email, timestamp, size }>
  cacheCurrentSizeMB: 0,

  // Clear email cache (call when switching accounts/mailboxes)
  clearEmailCache: () => {
    _cacheCurrentSizeMB = 0;
    _recordCacheSize(0);
    // Invalidate account cache for current account
    const { activeAccountId } = get();
    if (activeAccountId) _invalidateRestore(activeAccountId);
    set({ emailCache: new Map(), cacheCurrentSizeMB: 0 });
  },

  // Evict prefetch-only body cache entries (never opened by user).
  // Called by scroll-settle idle timer when cache pressure is over threshold.
  evictPrefetchEntries: () => {
    const { emailCache } = get();
    let freedMB = 0;
    for (const [key, entry] of emailCache) {
      if (entry.prefetchOnly) {
        freedMB += entry.size;
        emailCache.delete(key);
      }
    }
    if (freedMB > 0) {
      _cacheCurrentSizeMB = Math.max(0, _cacheCurrentSizeMB - freedMB);
      _recordCacheSize(_cacheCurrentSizeMB);
      console.log('[cache] Evicted %.1fMB of prefetch-only entries', freedMB);
    }
  },

  // Estimate size of an email object in MB
  estimateEmailSizeMB: (email) => {
    try {
      const str = JSON.stringify(email);
      return str.length / (1024 * 1024);
    } catch {
      return 0.1; // Default estimate
    }
  },

  // Add email to cache with size limit enforcement
  // Strips rawSource and attachment content to minimize memory footprint
  addToCache: (cacheKey, email, cacheLimitMB, { prefetch = false } = {}) => {
    const { emailCache } = get();

    // Strip heavy fields before caching — rawSource is already on disk as .eml,
    // and attachment content is fetched on demand
    const lightEmail = { ...email };
    delete lightEmail.rawSource;
    if (lightEmail.attachments) {
      lightEmail.attachments = lightEmail.attachments.map(att => {
        const { content, ...meta } = att;
        return meta;
      });
    }

    const emailSize = get().estimateEmailSizeMB(lightEmail);

    // Reject single items larger than 5MB — likely malformed or unusually large
    const MAX_SINGLE_ITEM_MB = 5;
    if (emailSize > MAX_SINGLE_ITEM_MB) {
      console.warn('[addToCache] Skipping oversized email %.1fMB key=%s', emailSize, cacheKey);
      return;
    }

    // Use user setting as the eviction limit (treat 0 as unlimited but cap for WKWebView safety)
    const effectiveLimit = cacheLimitMB > 0 ? cacheLimitMB : 4096;

    // Evict oldest entries if we'd exceed the MB limit or entry count ceiling.
    // O(1) per eviction: Map preserves insertion order, so first key = oldest.
    // Delete-before-set ensures re-cached keys move to the end (LRU order).
    const MAX_CACHE_ENTRIES = 500;
    let currentSize = _cacheCurrentSizeMB;

    while ((currentSize + emailSize > effectiveLimit || emailCache.size >= MAX_CACHE_ENTRIES) && emailCache.size > 0) {
      const oldestKey = emailCache.keys().next().value;
      if (oldestKey === undefined) break;
      const evicted = emailCache.get(oldestKey);
      currentSize -= evicted.size;
      emailCache.delete(oldestKey);
    }

    // Delete first if key exists so re-insert moves it to end of insertion order (LRU)
    if (emailCache.has(cacheKey)) emailCache.delete(cacheKey);
    emailCache.set(cacheKey, {
      email: lightEmail,
      timestamp: Date.now(),
      size: emailSize,
      prefetchOnly: prefetch, // Track whether user ever opened this entry
    });

    // Update size tracking via memory manager and module-level tracker.
    // Only emit set() when the size changes by >=1MB to avoid 15+ re-renders/sec from pipeline.
    const newSize = currentSize + emailSize;
    _cacheCurrentSizeMB = newSize;
    _recordCacheSize(newSize);
    if (Math.abs(newSize - get().cacheCurrentSizeMB) >= 1) {
      set({ cacheCurrentSizeMB: newSize });
    }
  },

  // Get email from cache (updates timestamp for LRU)
  getFromCache: (cacheKey) => {
    const { emailCache } = get();
    const entry = emailCache.get(cacheKey);

    if (entry) {
      // Update timestamp in place — no Map copy needed
      entry.timestamp = Date.now();
      entry.prefetchOnly = false; // User opened this — promote from prefetch
      return entry.email;
    }

    return null;
  },
});
