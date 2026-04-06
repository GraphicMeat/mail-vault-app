// ── selectEmail workflow — email selection and prefetch ──

import * as db from '../db';
import * as api from '../api';
import { useSettingsStore } from '../../stores/settingsStore';
import { ensureFreshToken } from '../authUtils';
import { hasRealAttachments } from '../attachmentUtils';
import { isGraphAccount, normalizeGraphFolderName, graphMessageToEmail } from '../graphConfig';
import { setGraphIdMap as _setGraphIdMap, getGraphMessageId } from '../cacheManager';
import { _resolveUnifiedContext } from '../../stores/slices/unifiedHelpers';
import { _shouldPrefetch, getCacheCurrentSizeMB } from '../../stores/slices/cacheSlice';

// Module-level mark-as-read timer
let _markAsReadTimer = null;


// ── _prefetchAdjacentEmails workflow ──

export async function _prefetchAdjacentEmails(currentUid) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const { sortedEmails, activeAccountId, activeMailbox, emailCache } = get();
  const isUnified = activeMailbox === 'UNIFIED';
  const cacheLimitMB = useSettingsStore.getState().cacheLimitMB;

  if (!_shouldPrefetch()) {
    console.log('[prefetch] Skipping — cache pressure: %.0fMB', getCacheCurrentSizeMB());
    return;
  }

  const currentIndex = sortedEmails.findIndex(e => e.uid === currentUid);
  if (currentIndex < 0) return;

  for (let i = 1; i <= 3; i++) {
    const nextEmail = sortedEmails[currentIndex + i];
    if (!nextEmail) break;

    const prefetchAccountId = (isUnified && nextEmail._accountId) ? nextEmail._accountId : activeAccountId;
    const prefetchMailbox = isUnified ? 'INBOX' : activeMailbox;
    const cacheKey = `${prefetchAccountId}-${prefetchMailbox}-${nextEmail.uid}`;
    if (emailCache.has(cacheKey)) continue;

    try {
      const localEmail = await db.getLocalEmailLight(prefetchAccountId, prefetchMailbox, nextEmail.uid);
      if (localEmail && localEmail.html !== undefined) {
        get().addToCache(cacheKey, localEmail, cacheLimitMB, { prefetch: true });
        continue;
      }

      const account = get().accounts.find(a => a.id === prefetchAccountId);
      if (!account) break;

      if (isGraphAccount(account)) {
        const graphId = getGraphMessageId(prefetchAccountId, prefetchMailbox, nextEmail.uid);
        if (!graphId) continue;
        const freshAccount = await ensureFreshToken(account);
        const graphMsg = await api.graphGetMessage(freshAccount.oauth2AccessToken, graphId);
        const email = graphMessageToEmail(graphMsg, nextEmail.uid);
        get().addToCache(cacheKey, email, cacheLimitMB, { prefetch: true });
      } else {
        const email = await api.fetchEmailLight(account, nextEmail.uid, prefetchMailbox, prefetchAccountId);
        get().addToCache(cacheKey, email, cacheLimitMB, { prefetch: true });
      }
    } catch (e) {
      break;
    }
  }
}


// ── selectEmail workflow ──

export async function selectEmail(uid, source = 'server', mailboxOverride = null) {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const state = get();
  const isUnified = state.activeMailbox === 'UNIFIED';
  const unified = isUnified ? _resolveUnifiedContext(uid, state) : null;
  const accountId = unified?.accountId || state.activeAccountId;
  const rawMailbox = mailboxOverride || unified?.mailbox || state.activeMailbox;
  const mailbox = rawMailbox === 'UNIFIED' ? 'INBOX' : rawMailbox;
  let account = unified?.account || state.accounts.find(a => a.id === accountId);
  account = await ensureFreshToken(account);
  const cacheKey = `${accountId}-${mailbox}-${uid}`;
  const cacheLimitMB = useSettingsStore.getState().cacheLimitMB;

  // Cancel any pending delayed mark-as-read from previous email
  if (_markAsReadTimer) { clearTimeout(_markAsReadTimer); _markAsReadTimer = null; }

  const selectedEmailId = isUnified ? `${accountId}:${uid}` : uid;
  useMailStore.setState({ selectedThread: null, selectedEmailId, loadingEmail: true, selectedEmail: null, selectedEmailSource: source });

  try {
    let email;
    let actualSource = source;

    // 1. Check in-memory cache first
    const cachedEmail = get().getFromCache(cacheKey);
    if (cachedEmail) {
      useMailStore.setState({ selectedEmail: cachedEmail, selectedEmailSource: source, loadingEmail: false });
      return;
    }

    // 2. Check Maildir for cached .eml file
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
        const graphMsg = await api.graphGetMessage(token, graphId);
        email = graphMessageToEmail(graphMsg, uid);
        actualSource = 'server';
        get().addToCache(cacheKey, email, cacheLimitMB);

        api.graphCacheMime(token, graphId, accountId, mailbox, uid)
          .catch(e => console.warn('[selectEmail] Background MIME cache failed:', e));

        const markAsReadMode = useSettingsStore.getState().markAsReadMode;
        if (markAsReadMode !== 'manual' && !email.flags?.includes('\\Seen')) {
          const doMark = async () => {
            try {
              await api.graphSetRead(token, graphId, true);
              useMailStore.setState(state => {
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
      // 3b. IMAP
      email = await api.fetchEmailLight(account, uid, mailbox, accountId);
      actualSource = 'server';
      get().addToCache(cacheKey, email, cacheLimitMB);

      try {
        const savedEmailIds = await db.getSavedEmailIds(accountId, mailbox);
        useMailStore.setState({ savedEmailIds });
      } catch (e) {
        console.warn('[selectEmail] Failed to update saved IDs:', e);
      }

      const markAsReadMode = useSettingsStore.getState().markAsReadMode;
      if (markAsReadMode !== 'manual' && !email.flags?.includes('\\Seen')) {
        const doMark = async () => {
          try {
            await api.updateEmailFlags(account, uid, ['\\Seen'], 'add', mailbox);
            useMailStore.setState(state => {
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

    // Update hasAttachments on the list item
    const hasReal = hasRealAttachments(email);
    useMailStore.setState(state => ({
      selectedEmail: email,
      selectedEmailSource: actualSource,
      emails: state.emails.map(e => e.uid === uid ? { ...e, hasAttachments: hasReal } : e),
    }));
  } catch (error) {
    console.error('[selectEmail] Failed to load email:', error);
    console.error('[selectEmail] Error details:', { name: error.name, message: error.message, status: error.status, stack: error.stack });
    try {
      const localEmail = await db.getLocalEmailLight(accountId, mailbox, uid);
      if (localEmail) {
        useMailStore.setState({ selectedEmail: localEmail, selectedEmailSource: 'local-only' });
      } else {
        const headerEmail = get().emails.find(e => e.uid === uid);
        if (headerEmail) {
          useMailStore.setState({ selectedEmail: { ...headerEmail, text: headerEmail.snippet || headerEmail.subject || '' }, selectedEmailSource: 'header-only' });
        } else {
          const detail = error.message || String(error);
          useMailStore.setState({ error: `Failed to load email (UID ${uid}, ${mailbox}): ${detail}` });
        }
      }
    } catch (fallbackError) {
      console.error('[selectEmail] Fallback also failed:', fallbackError);
      const headerEmail = get().emails.find(e => e.uid === uid);
      if (headerEmail) {
        useMailStore.setState({ selectedEmail: { ...headerEmail, text: headerEmail.snippet || headerEmail.subject || '' }, selectedEmailSource: 'header-only' });
      } else {
        const detail = error.message || String(error);
        useMailStore.setState({ error: `Failed to load email (UID ${uid}, ${mailbox}): ${detail}` });
      }
    }
  } finally {
    useMailStore.setState({ loadingEmail: false });

    // Pre-fetch adjacent email bodies in background
    get()._prefetchAdjacentEmails(uid);
  }
}
