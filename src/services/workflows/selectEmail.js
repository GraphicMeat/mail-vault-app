// ── selectEmail workflow — email selection and prefetch ──

import * as db from '../db';
import * as api from '../api';
import { useSettingsStore } from '../../stores/settingsStore';
import { ensureFreshToken } from '../authUtils';
import { hasRealAttachments, hydrateInlineImages } from '../attachmentUtils';
import { isGraphAccount, normalizeGraphFolderName, graphMessageToEmail } from '../graphConfig';
import { setGraphIdMap as _setGraphIdMap, getGraphMessageId } from '../cacheManager';
import { _resolveUnifiedContext } from '../../stores/slices/unifiedHelpers';
import { _shouldPrefetch, getCacheCurrentSizeMB } from '../../stores/slices/cacheSlice';
import { applySeenLocally, _setSeenOnServer } from './messageMutations';

// Module-level mark-as-read timer
let _markAsReadTimer = null;


// ── auto mark-as-read on open ──
//
// Runs for every path that opens a message, including the in-memory cache hit —
// that one used to skip it, so an email marked unread stayed unread forever
// once its body was cached, and the action bar kept offering "Mark read".
// Returns the email with \Seen applied when it marked right away, so the
// caller's copy matches what the list now holds.
async function _autoMarkRead(useMailStore, { email, accountId, mailbox, uid, isUnified, markOnServer }) {
  const { markAsReadMode, markAsReadDelay } = useSettingsStore.getState();
  if (markAsReadMode === 'manual' || email?.flags?.includes('\\Seen')) return email;

  const doMark = async () => {
    try {
      await markOnServer();
      applySeenLocally(useMailStore, { accountId, mailbox, uid, read: true, isUnified });
    } catch (e) {
      console.warn('[selectEmail] Mark as read failed:', e);
    }
  };

  if (markAsReadMode === 'delay') {
    if (_markAsReadTimer) clearTimeout(_markAsReadTimer);
    _markAsReadTimer = setTimeout(doMark, (markAsReadDelay || 3) * 1000);
    return email;
  }

  await doMark();
  return { ...email, flags: [...(email.flags || []), '\\Seen'] };
}


// ── _prefetchAdjacentEmails workflow ──

// selectedEmailId is `accountId:uid` in the unified inbox and a bare uid
// elsewhere — same shape selectEmail writes.
function _selectionIdFor(uid, state) {
  if (state.activeMailbox !== 'UNIFIED') return uid;
  const row = state.sortedEmails.find(e => e.uid === uid);
  return `${row?._accountId || state.activeAccountId}:${uid}`;
}

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
    // The user moved on — every remaining fetch here is for a row nobody is
    // looking at, and each one still costs a pool permit and a round trip.
    if (get().selectedEmailId !== _selectionIdFor(currentUid, get())) return;

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
        const email = await api.fetchEmailLight(account, nextEmail.uid, prefetchMailbox, prefetchAccountId, { background: true });
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
      const hydrated = await hydrateInlineImages(cachedEmail, accountId, mailbox);
      if (hydrated !== cachedEmail) get().addToCache(cacheKey, hydrated, cacheLimitMB);
      // The cached body is frozen at fetch time, but flags keep moving (mark
      // read/unread, sync, another client). The list row is the current copy.
      const row = get().emails.find(e => isUnified ? (e._accountId === accountId && e.uid === uid) : e.uid === uid);
      const fresh = row?.flags ? { ...hydrated, flags: row.flags } : hydrated;
      useMailStore.setState({ selectedEmail: fresh, selectedEmailSource: source, loadingEmail: false });
      await _autoMarkRead(useMailStore, {
        email: fresh, accountId, mailbox, uid, isUnified,
        markOnServer: () => _setSeenOnServer(account, accountId, mailbox, uid, true),
      });
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

      // Prefer _graphId embedded on the email header (stable across refreshes).
      // Fall back to the positional map, then rebuild as last resort.
      const emailHeader = get().emails.find(e => e.uid === uid)
        || get().sortedEmails.find(e => e.uid === uid);
      let graphId = emailHeader?._graphId || getGraphMessageId(accountId, mailbox, uid);

      if (!graphId) {
        console.log('[selectEmail] Graph ID not found for UID', uid, '— rebuilding map');
        try {
          const folders = await api.graphListFolders(token);
          const folder = folders.find(f => {
            const normalized = normalizeGraphFolderName(f.displayName);
            return normalized === mailbox || f.displayName === mailbox;
          });
          if (folder) {
            const { headers: rebuildHeaders, graphMessageIds } = await api.graphListMessages(token, folder.id, 200, 0);
            const uidMap = new Map();
            // Use headers' UIDs (not positional index) to match correctly
            rebuildHeaders.forEach((h, i) => {
              uidMap.set(h.uid, graphMessageIds[i]);
            });
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

        email = await _autoMarkRead(useMailStore, {
          email, accountId, mailbox, uid, isUnified,
          markOnServer: () => api.graphSetRead(token, graphId, true),
        });
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

      email = await _autoMarkRead(useMailStore, {
        email, accountId, mailbox, uid, isUnified,
        markOnServer: () => api.updateEmailFlags(account, uid, ['\\Seen'], 'add', mailbox),
      });
    }

    // Inline images live in the .eml the light fetch just cached — pull them in
    const withInline = await hydrateInlineImages(email, accountId, mailbox);
    if (withInline !== email) {
      email = withInline;
      get().addToCache(cacheKey, email, cacheLimitMB);
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
    const detail = error.message || String(error);

    // Header-only is a FAILURE, not a message with a short body: the row's own
    // subject used to be written into `text`, which the viewer then rendered as
    // if it were the body — a fetch that never returned looked exactly like an
    // email whose body is its subject. `_bodyError` is what makes the two
    // distinguishable downstream (EmailViewer shows it, with a retry).
    const headerOnly = () => {
      const headerEmail = get().emails.find(e => e.uid === uid);
      if (!headerEmail) {
        useMailStore.setState({ error: `Failed to load email (UID ${uid}, ${mailbox}): ${detail}` });
        return;
      }
      useMailStore.setState({
        selectedEmail: { ...headerEmail, text: headerEmail.snippet || '', _bodyError: detail },
        selectedEmailSource: 'header-only',
      });
    };

    try {
      const localEmail = await db.getLocalEmailLight(accountId, mailbox, uid);
      if (localEmail) {
        useMailStore.setState({ selectedEmail: localEmail, selectedEmailSource: 'local-only' });
      } else {
        headerOnly();
      }
    } catch (fallbackError) {
      console.error('[selectEmail] Fallback also failed:', fallbackError);
      headerOnly();
    }
  } finally {
    useMailStore.setState({ loadingEmail: false });

    // Pre-fetch adjacent email bodies in background
    get()._prefetchAdjacentEmails(uid);
  }
}
