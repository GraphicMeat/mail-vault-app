// ── selectionSlice — email selection, viewer, and bulk operations ──

import * as db from '../../services/db';
import * as api from '../../services/api';
import { useSettingsStore } from '../settingsStore';
import { ensureFreshToken } from '../../services/authUtils';
import { hasRealAttachments } from '../../services/attachmentUtils';
import { buildThreads } from '../../utils/emailParser';
import { isGraphAccount, normalizeGraphFolderName, graphMessageToEmail } from '../../services/graphConfig';
import { setGraphIdMap as _setGraphIdMap, getGraphMessageId } from '../../services/cacheManager';
import { _resolveUnifiedContext, _selKey, _parseSelKey } from './unifiedHelpers';
import { _shouldPrefetch, getCacheCurrentSizeMB } from './cacheSlice';

// Module-level mark-as-read timer
let _markAsReadTimer = null;

export const createSelectionSlice = (set, get) => ({
  selectedEmailId: null,
  selectedEmail: null,
  selectedEmailSource: null, // 'server' | 'local' | 'local-only'
  selectedThread: null, // thread object from buildThreads, or null for single email
  loadingEmail: false,

  // Selection for bulk actions
  selectedEmailIds: new Set(),

  // Select a thread (shows all emails in the thread in the viewer)
  selectThread: (thread) => {
    set({
      selectedThread: thread,
      selectedEmailId: thread.lastEmail.uid,
      selectedEmail: null,
      selectedEmailSource: null,
      loadingEmail: false,
    });
  },

  // Pre-fetch adjacent email bodies for instant navigation
  _prefetchAdjacentEmails: async (currentUid) => {
    const { sortedEmails, activeAccountId, activeMailbox, emailCache } = get();
    const isUnified = activeMailbox === 'UNIFIED';
    const cacheLimitMB = useSettingsStore.getState().cacheLimitMB;

    // Pressure-aware prefetch: skip entirely outside normal, reduce depth at elevated
    if (!_shouldPrefetch()) {
      console.log('[prefetch] Skipping — cache pressure: %.0fMB', getCacheCurrentSizeMB());
      return;
    }

    const currentIndex = sortedEmails.findIndex(e => e.uid === currentUid);
    if (currentIndex < 0) return;

    for (let i = 1; i <= 3; i++) {
      const nextEmail = sortedEmails[currentIndex + i];
      if (!nextEmail) break;

      // In unified mode, resolve per-email account context
      const prefetchAccountId = (isUnified && nextEmail._accountId) ? nextEmail._accountId : activeAccountId;
      const prefetchMailbox = isUnified ? 'INBOX' : activeMailbox;
      const cacheKey = `${prefetchAccountId}-${prefetchMailbox}-${nextEmail.uid}`;
      if (emailCache.has(cacheKey)) continue; // Already cached

      try {
        // Try Maildir first (fast, local disk)
        const localEmail = await db.getLocalEmailLight(prefetchAccountId, prefetchMailbox, nextEmail.uid);
        if (localEmail && localEmail.html !== undefined) {
          get().addToCache(cacheKey, localEmail, cacheLimitMB, { prefetch: true });
          continue;
        }

        // Fallback to server fetch
        const account = get().accounts.find(a => a.id === prefetchAccountId);
        if (!account) break;

        if (isGraphAccount(account)) {
          // Graph API: fetch full message
          const graphId = getGraphMessageId(prefetchAccountId, prefetchMailbox, nextEmail.uid);
          if (!graphId) continue;
          const freshAccount = await ensureFreshToken(account);
          const graphMsg = await api.graphGetMessage(freshAccount.oauth2AccessToken, graphId);
          const email = graphMessageToEmail(graphMsg, nextEmail.uid);
          get().addToCache(cacheKey, email, cacheLimitMB, { prefetch: true });
        } else {
          // IMAP (auto-persists .eml)
          const email = await api.fetchEmailLight(account, nextEmail.uid, prefetchMailbox, prefetchAccountId);
          get().addToCache(cacheKey, email, cacheLimitMB, { prefetch: true });
        }
      } catch (e) {
        // Stop prefetch on network errors — don't waste bandwidth
        break;
      }
    }
  },

  // Select email
  selectEmail: async (uid, source = 'server', mailboxOverride = null) => {
    const state = get();
    const isUnified = state.activeMailbox === 'UNIFIED';
    const unified = isUnified ? _resolveUnifiedContext(uid, state) : null;
    const accountId = unified?.accountId || state.activeAccountId;
    // Never pass 'UNIFIED' to IMAP — it's a virtual client-side mailbox
    const rawMailbox = mailboxOverride || unified?.mailbox || state.activeMailbox;
    const mailbox = rawMailbox === 'UNIFIED' ? 'INBOX' : rawMailbox;
    let account = unified?.account || state.accounts.find(a => a.id === accountId);
    account = await ensureFreshToken(account);
    const cacheKey = `${accountId}-${mailbox}-${uid}`;
    const cacheLimitMB = useSettingsStore.getState().cacheLimitMB;

    // Cancel any pending delayed mark-as-read from previous email
    if (_markAsReadTimer) { clearTimeout(_markAsReadTimer); _markAsReadTimer = null; }

    // Use compound key in unified inbox to avoid cross-account UID collisions
    const selectedEmailId = isUnified ? `${accountId}:${uid}` : uid;
    set({ selectedThread: null, selectedEmailId, loadingEmail: true, selectedEmail: null, selectedEmailSource: source });

    try {
      let email;
      let actualSource = source;

      // 1. Check in-memory cache first (also updates LRU timestamp)
      const cachedEmail = get().getFromCache(cacheKey);
      if (cachedEmail) {
        set({ selectedEmail: cachedEmail, selectedEmailSource: source, loadingEmail: false });
        return;
      }

      // 2. Check Maildir for cached .eml file (light — no attachment binaries or rawSource)
      const localEmail = await db.getLocalEmailLight(accountId, mailbox, uid);

      if (source === 'local-only' || (localEmail && localEmail.html !== undefined)) {
        email = localEmail;
        actualSource = source === 'local-only' ? 'local-only' : 'local';
        get().addToCache(cacheKey, email, cacheLimitMB);
      } else if (account && isGraphAccount(account)) {
        // 3a. Graph API: fetch full message by Graph message ID
        const freshAccount = await ensureFreshToken(account);
        const token = freshAccount.oauth2AccessToken;
        let graphId = getGraphMessageId(accountId, mailbox, uid);

        // If graphIdMap is stale (e.g. after app restart), rebuild it by re-fetching headers
        if (!graphId) {
          console.log('[selectEmail] Graph ID not found for UID', uid, '— rebuilding map');
          try {
            const folders = await api.graphListFolders(token);
            const folder = folders.find(f => {
              const normalized = normalizeGraphFolderName(f.displayName);
              return normalized === mailbox || f.displayName === mailbox;
            });
            if (folder) {
              const { graphMessageIds } = await api.graphListMessages(token, folder.id, 200, 0);
              const uidMap = new Map();
              graphMessageIds.forEach((gid, i) => uidMap.set(i + 1, gid));
              _setGraphIdMap(accountId, mailbox, uidMap);
              graphId = uidMap.get(uid);
            }
          } catch (e) {
            console.warn('[selectEmail] Failed to rebuild Graph ID map:', e);
          }
        }

        if (graphId) {
          // Fast path: fetch JSON body from Graph API (instant display)
          const graphMsg = await api.graphGetMessage(token, graphId);
          email = graphMessageToEmail(graphMsg, uid);
          actualSource = 'server';
          get().addToCache(cacheKey, email, cacheLimitMB);

          // Background: download full MIME and save .eml to disk for offline access
          api.graphCacheMime(token, graphId, accountId, mailbox, uid)
            .catch(e => console.warn('[selectEmail] Background MIME cache failed:', e));

          // Mark as read on server
          const markAsReadMode = useSettingsStore.getState().markAsReadMode;
          if (markAsReadMode !== 'manual' && !email.flags?.includes('\\Seen')) {
            const doMark = async () => {
              try {
                await api.graphSetRead(token, graphId, true);
                // Update the selected email's flags in state
                set(state => {
                  const sel = state.selectedEmail;
                  if (sel && sel.uid === uid && !sel.flags?.includes('\\Seen')) {
                    return { selectedEmail: { ...sel, flags: [...(sel.flags || []), '\\Seen'] } };
                  }
                  return {};
                });
              } catch (e) {
                console.warn('[selectEmail] Graph mark as read failed:', e);
              }
            };
            if (markAsReadMode === 'delay') {
              const delay = useSettingsStore.getState().markAsReadDelay || 3;
              if (_markAsReadTimer) clearTimeout(_markAsReadTimer);
              _markAsReadTimer = setTimeout(doMark, delay * 1000);
            } else {
              await doMark();
              email = { ...email, flags: [...(email.flags || []), '\\Seen'] };
            }
          }
        } else {
          console.warn('[selectEmail] No Graph message ID found for UID', uid);
        }
      } else if (account) {
        // 3b. IMAP: Fetch from server (light — saves full .eml to Maildir in Rust background)
        email = await api.fetchEmailLight(account, uid, mailbox, accountId);
        actualSource = 'server';
        get().addToCache(cacheKey, email, cacheLimitMB);

        // Update saved IDs (the light IMAP fetch auto-persists to Maildir in Rust)
        try {
          const savedEmailIds = await db.getSavedEmailIds(accountId, mailbox);
          set({ savedEmailIds });
        } catch (e) {
          console.warn('[selectEmail] Failed to update saved IDs:', e);
        }

        // Mark as read on server
        const markAsReadMode = useSettingsStore.getState().markAsReadMode;
        if (markAsReadMode !== 'manual' && !email.flags?.includes('\\Seen')) {
          const doMark = async () => {
            try {
              await api.updateEmailFlags(account, uid, ['\\Seen'], 'add', mailbox);
              // Update the selected email's flags in state
              set(state => {
                const sel = state.selectedEmail;
                if (sel && sel.uid === uid && !sel.flags?.includes('\\Seen')) {
                  return { selectedEmail: { ...sel, flags: [...(sel.flags || []), '\\Seen'] } };
                }
                return {};
              });
            } catch (e) {
              console.warn('Failed to mark as read:', e);
            }
          };
          if (markAsReadMode === 'delay') {
            const delay = useSettingsStore.getState().markAsReadDelay || 3;
            if (_markAsReadTimer) clearTimeout(_markAsReadTimer);
            _markAsReadTimer = setTimeout(doMark, delay * 1000);
          } else {
            await doMark();
            email = { ...email, flags: [...(email.flags || []), '\\Seen'] };
          }
        }
      }

      // Update hasAttachments on the list item based on real (non-inline) attachments
      const hasReal = hasRealAttachments(email);
      set(state => ({
        selectedEmail: email,
        selectedEmailSource: actualSource,
        emails: state.emails.map(e => e.uid === uid ? { ...e, hasAttachments: hasReal } : e),
      }));
    } catch (error) {
      console.error('[selectEmail] Failed to load email:', error);
      console.error('[selectEmail] Error details:', { name: error.name, message: error.message, status: error.status, stack: error.stack });
      // Fallback to Maildir if server fails
      try {
        const localEmail = await db.getLocalEmailLight(accountId, mailbox, uid);
        if (localEmail) {
          set({ selectedEmail: localEmail, selectedEmailSource: 'local-only' });
        } else {
          // Final fallback: show the header-only email so user sees something
          const headerEmail = get().emails.find(e => e.uid === uid);
          if (headerEmail) {
            set({ selectedEmail: { ...headerEmail, text: headerEmail.snippet || headerEmail.subject || '' }, selectedEmailSource: 'header-only' });
          } else {
            const detail = error.message || String(error);
            set({ error: `Failed to load email (UID ${uid}, ${mailbox}): ${detail}` });
          }
        }
      } catch (fallbackError) {
        console.error('[selectEmail] Fallback also failed:', fallbackError);
        // Final fallback: show header data
        const headerEmail = get().emails.find(e => e.uid === uid);
        if (headerEmail) {
          set({ selectedEmail: { ...headerEmail, text: headerEmail.snippet || headerEmail.subject || '' }, selectedEmailSource: 'header-only' });
        } else {
          const detail = error.message || String(error);
          set({ error: `Failed to load email (UID ${uid}, ${mailbox}): ${detail}` });
        }
      }
    } finally {
      set({ loadingEmail: false });

      // Pre-fetch adjacent email bodies in background for instant navigation
      get()._prefetchAdjacentEmails(uid);
    }
  },

  // Selection management
  toggleEmailSelection: (uid, accountId = null) => {
    set(state => {
      const isUnified = state.activeMailbox === 'UNIFIED';
      const key = isUnified && accountId ? `${accountId}:${uid}` : uid;
      const newSelection = new Set(state.selectedEmailIds);
      if (newSelection.has(key)) {
        newSelection.delete(key);
      } else {
        newSelection.add(key);
      }
      return { selectedEmailIds: newSelection };
    });
  },

  selectAllEmails: () => {
    const { sortedEmails, activeMailbox } = get();
    const isUnified = activeMailbox === 'UNIFIED';
    set({ selectedEmailIds: new Set(sortedEmails.map(e => isUnified ? _selKey(e) : e.uid)) });
  },

  clearSelection: () => {
    set({ selectedEmailIds: new Set() });
  },

  // Get selection summary — thread-aware counts
  getSelectionSummary: () => {
    const { selectedEmailIds, sortedEmails, activeMailbox } = get();
    if (selectedEmailIds.size === 0) return { threads: 0, emails: 0 };

    const isUnified = activeMailbox === 'UNIFIED';
    const threads = buildThreads(sortedEmails);
    let threadCount = 0;

    for (const [, thread] of threads) {
      const hasSelected = thread.emails.some(e => selectedEmailIds.has(isUnified ? _selKey(e) : e.uid));
      if (hasSelected) threadCount++;
    }

    return { threads: threadCount, emails: selectedEmailIds.size };
  },

  // Bulk mark as read — clears selection immediately, optimistic UI update
  markSelectedAsRead: async () => {
    const state = get();
    const { selectedEmailIds, accounts } = state;
    const isUnified = state.activeMailbox === 'UNIFIED';
    if (selectedEmailIds.size === 0) return;

    const keys = Array.from(selectedEmailIds);
    // Optimistic: update UI immediately + clear selection
    set(state => ({
      emails: state.emails.map(e => {
        const key = isUnified ? _selKey(e) : e.uid;
        return selectedEmailIds.has(key)
          ? { ...e, flags: [...(e.flags || []), '\\Seen'].filter((f, i, a) => a.indexOf(f) === i) }
          : e;
      }),
      selectedEmailIds: new Set()
    }));

    for (const key of keys) {
      try {
        const ctx = isUnified ? _resolveUnifiedContext(key, state) : null;
        const realUid = ctx?.uid ?? key;
        const accountId = ctx?.accountId || state.activeAccountId;
        const rawMailbox = ctx?.mailbox || state.activeMailbox;
        const mailbox = rawMailbox === 'UNIFIED' ? 'INBOX' : rawMailbox;
        let account = ctx?.account || accounts.find(a => a.id === accountId);
        account = await ensureFreshToken(account);
        await api.updateEmailFlags(account, realUid, ['\\Seen'], 'add', mailbox);
      } catch (e) {
        console.error(`Failed to mark email ${key} as read:`, e);
      }
    }
  },

  // Bulk mark as unread — clears selection immediately, optimistic UI update
  markSelectedAsUnread: async () => {
    const state = get();
    const { selectedEmailIds, accounts } = state;
    const isUnified = state.activeMailbox === 'UNIFIED';
    if (selectedEmailIds.size === 0) return;

    const keys = Array.from(selectedEmailIds);
    // Optimistic: update UI immediately + clear selection
    set(state => ({
      emails: state.emails.map(e => {
        const key = isUnified ? _selKey(e) : e.uid;
        return selectedEmailIds.has(key)
          ? { ...e, flags: (e.flags || []).filter(f => f !== '\\Seen') }
          : e;
      }),
      selectedEmailIds: new Set()
    }));

    for (const key of keys) {
      try {
        const ctx = isUnified ? _resolveUnifiedContext(key, state) : null;
        const realUid = ctx?.uid ?? key;
        const accountId = ctx?.accountId || state.activeAccountId;
        const rawMailbox = ctx?.mailbox || state.activeMailbox;
        const mailbox = rawMailbox === 'UNIFIED' ? 'INBOX' : rawMailbox;
        let account = ctx?.account || accounts.find(a => a.id === accountId);
        account = await ensureFreshToken(account);
        await api.updateEmailFlags(account, realUid, ['\\Seen'], 'remove', mailbox);
      } catch (e) {
        console.error(`Failed to mark email ${key} as unread:`, e);
      }
    }
  },

  // Bulk delete from server — clears selection immediately
  deleteSelectedFromServer: async () => {
    const state = get();
    const { selectedEmailIds, accounts } = state;
    const isUnified = state.activeMailbox === 'UNIFIED';
    if (selectedEmailIds.size === 0) return;

    const keys = Array.from(selectedEmailIds);
    set({ selectedEmailIds: new Set() });

    const sentPath = get().getSentMailboxPath();
    const allEmails = [...state.emails, ...state.sentEmails];
    // Build email lookup keyed by unified key in unified mode, raw uid otherwise
    const emailMap = new Map(allEmails.map(e => [isUnified ? _selKey(e) : e.uid, e]));

    // Track real uids for post-delete filtering
    const deletedRealUids = new Set();

    for (const key of keys) {
      try {
        const ctx = isUnified ? _resolveUnifiedContext(key, state) : null;
        const realUid = ctx?.uid ?? key;
        const accountId = ctx?.accountId || state.activeAccountId;
        const emailObj = emailMap.get(key);
        const rawMailbox = ctx?.mailbox || (emailObj?._fromSentFolder && sentPath ? sentPath : state.activeMailbox);
        const mailbox = rawMailbox === 'UNIFIED' ? 'INBOX' : rawMailbox;
        let account = ctx?.account || accounts.find(a => a.id === accountId);
        account = await ensureFreshToken(account);

        if (isGraphAccount(account)) {
          const graphId = getGraphMessageId(accountId, mailbox, realUid);
          if (graphId) {
            await api.graphDeleteMessage(account.oauth2AccessToken, graphId);
          } else {
            console.warn(`[deleteSelectedFromServer] No Graph ID for UID ${realUid}, skipping`);
          }
        } else {
          await api.deleteEmail(account, realUid, mailbox);
        }
        deletedRealUids.add(realUid);
      } catch (e) {
        console.error(`Failed to delete email ${key}:`, e);
      }
    }

    // Immediately remove deleted emails from the list so UI updates
    // In unified mode, match by composite key to avoid cross-account collisions
    const deletedKeySet = new Set(keys);
    const filteredEmails = get().emails.filter(e => {
      const k = isUnified ? _selKey(e) : e.uid;
      return !deletedKeySet.has(k);
    });
    const filteredSent = get().sentEmails.filter(e => {
      const k = isUnified ? _selKey(e) : e.uid;
      return !deletedKeySet.has(k);
    });
    set({
      emails: filteredEmails,
      sentEmails: filteredSent,
      totalEmails: Math.max(0, (get().totalEmails || 0) - keys.length),
      selectedEmailId: deletedRealUids.has(get().selectedEmailId) ? null : get().selectedEmailId,
      selectedEmail: deletedRealUids.has(get().selectedEmailId) ? null : get().selectedEmail,
    });
    get().updateSortedEmails();

    // Background refresh to sync with server
    if (!isUnified) get().loadEmails();
  },

  // Move emails to a different mailbox/folder
  moveEmails: async (uids, targetMailbox) => {
    const state = get();
    const isUnified = state.activeMailbox === 'UNIFIED';
    const selectedEmailId = state.selectedEmailId;
    const { activeAccountId, activeMailbox } = state;

    if (isUnified) {
      // In unified mode, group by account and move each group separately
      // uids may be composite keys (from selection) or raw uids (from single-email)
      const groups = new Map(); // accountId -> { account, uids, mailbox }
      for (const key of uids) {
        const ctx = _resolveUnifiedContext(key, state);
        if (!ctx) continue;
        if (!groups.has(ctx.accountId)) groups.set(ctx.accountId, { account: ctx.account, mailbox: ctx.mailbox, uids: [] });
        groups.get(ctx.accountId).uids.push(ctx.uid);
      }
      for (const [, group] of groups) {
        const freshAccount = await ensureFreshToken(group.account);
        await api.moveEmails(freshAccount, group.uids, group.mailbox, targetMailbox);
      }
    } else {
      const { accounts, mailboxes } = state;
      let account = accounts.find(a => a.id === activeAccountId);
      if (!account) return;
      account = await ensureFreshToken(account);

      if (isGraphAccount(account)) {
        const messageIds = uids
          .map(uid => getGraphMessageId(activeAccountId, activeMailbox, uid))
          .filter(Boolean);
        if (messageIds.length === 0) throw new Error('Cannot move: no Graph message IDs found for selected emails.');

        const targetFolder = mailboxes.find(m => m.path === targetMailbox || m.name === targetMailbox);
        if (!targetFolder || !targetFolder._graphFolderId) {
          throw new Error(`Cannot move: target folder "${targetMailbox}" not found.`);
        }

        await api.graphMoveEmails(account.oauth2AccessToken, messageIds, targetFolder._graphFolderId);
      } else {
        await api.moveEmails(account, uids, activeMailbox, targetMailbox);
      }
    }

    // Remove moved emails from current view
    // In unified mode, match by composite key to avoid cross-account collisions
    const keySet = new Set(uids); // uids may be composite keys in unified mode
    const filteredEmails = get().emails.filter(e => {
      const k = isUnified ? _selKey(e) : e.uid;
      return !keySet.has(k);
    });
    const newTotal = Math.max(0, (get().totalEmails || 0) - uids.length);
    const updates = {
      emails: filteredEmails,
      totalEmails: newTotal,
      selectedEmailIds: new Set(), // clear multi-selection
    };

    // Clear single-selection if the selected email was moved
    if (keySet.has(selectedEmailId)) {
      updates.selectedEmailId = null;
      updates.selectedEmail = null;
      updates.selectedEmailSource = null;
      updates.selectedThread = null;
    }
    set(updates);

    // Update cached headers on disk
    const { invalidateRestoreDescriptors: _invalidateRestore } = await import('../../services/cacheManager');
    await db.saveEmailHeaders(activeAccountId, activeMailbox, filteredEmails, newTotal);

    // Invalidate caches for both source and target mailboxes
    _invalidateRestore(activeAccountId);

    // Background refresh to sync with server
    get().loadEmails();
  },
});
