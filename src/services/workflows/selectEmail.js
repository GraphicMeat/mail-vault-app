// ── selectEmail workflow — email selection and prefetch ──

import * as db from '../db';
import * as api from '../api';
import { useSettingsStore } from '../../stores/settingsStore';
import { ensureFreshToken } from '../authUtils';
import { hasRealAttachments, hydrateInlineImages } from '../attachmentUtils';
import { isGraphAccount, graphMessageToEmail } from '../graphConfig';
import { getGraphMessageId, resolveGraphMessageId } from '../cacheManager';
import { _resolveUnifiedContext, bodyMatchesHeader } from '../../stores/slices/unifiedHelpers';
import { _shouldPrefetch, getCacheCurrentSizeMB } from '../../stores/slices/cacheSlice';
import { applySeenLocally, _setSeenOnServer, applyServerRemoval } from './messageMutations';
import { decodeImapUtf7 } from '../../utils/imapUtf7';
import { probeServerCopy } from './probeServerCopy';
import { t } from '../../i18n/index.js';

// Module-level mark-as-read timer
let _markAsReadTimer = null;


// ── vault read, verified against the row it was read for ──
//
// The vault Maildir is keyed (accountId, mailbox, uid) and carries no
// UIDVALIDITY stamp, so a uid it archived under one generation of a mailbox
// names a different message once the server reissues its UID space — a
// change-server migration, or a reissue the server does on its own. The read
// still lands on a real message, so nothing errors and nothing looks wrong:
// the viewer renders that message whole, header included, under the row the
// user clicked.
//
// A Message-ID that contradicts the row's is proof the copy is not this
// message. Missing on either side proves nothing, so it is allowed through —
// same contract as useChatBodyLoader, which has guarded its own vault read
// since the thread-view instance of this bug.
async function _readVerifiedLocal(accountId, mailbox, uid, headerRow) {
  const localEmail = await db.getLocalEmailLight(accountId, mailbox, uid);
  if (localEmail && !bodyMatchesHeader(headerRow, localEmail)) {
    console.warn('[selectEmail] Vault copy belongs to another message — discarding', {
      accountId, mailbox, uid,
      rowMessageId: headerRow?.messageId,
      vaultMessageId: localEmail?.messageId || localEmail?.message_id,
    });
    return undefined;
  }
  return localEmail;
}


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
      const localEmail = await _readVerifiedLocal(prefetchAccountId, prefetchMailbox, nextEmail.uid, nextEmail);
      if (localEmail && localEmail.html !== undefined) {
        get().addToCache(cacheKey, localEmail, cacheLimitMB, { prefetch: true });
        continue;
      }

      const account = get().accounts.find(a => a.id === prefetchAccountId);
      if (!account) break;

      if (isGraphAccount(account)) {
        // No relist here: a prefetch is speculative, and a miss just means the
        // body loads on click instead.
        const graphId = nextEmail._graphId || getGraphMessageId(prefetchAccountId, prefetchMailbox, nextEmail.uid);
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
  // A draft the user wrote here reopens in compose, not the viewer — before
  // the token refresh below, because continuing a local draft needs no server
  // at all. The index read that proves provenance is gated on the flag the
  // autosave writes (bare 'draft'; an IMAP draft carries '\Draft'), so
  // opening an ordinary message costs nothing extra. Imported here rather than
  // at the top for the same reason mailStore is: localDrafts reaches back into
  // the store this workflow is reached FROM.
  const clickedRow = state.emails.find(e => isUnified ? (e._accountId === accountId && e.uid === uid) : e.uid === uid)
    || state.sortedEmails.find(e => e.uid === uid);
  if (clickedRow?.flags?.includes('draft')) {
    const { openLocalDraft } = await import('../localDrafts');
    if (await openLocalDraft(accountId, mailbox, uid)) return;
  }

  let account = unified?.account || state.accounts.find(a => a.id === accountId);
  account = await ensureFreshToken(account);
  const cacheKey = `${accountId}-${mailbox}-${uid}`;
  const cacheLimitMB = useSettingsStore.getState().cacheLimitMB;

  // Cancel any pending delayed mark-as-read from previous email
  if (_markAsReadTimer) { clearTimeout(_markAsReadTimer); _markAsReadTimer = null; }

  // Which mailbox a message came from is not recoverable from the message: a
  // body fetched from the server carries no account, so reply/forward had to
  // guess. Stamp it here, where it is already resolved.
  const withAccount = (e) => (e && !e._accountId ? { ...e, _accountId: accountId } : e);

  const selectedEmailId = isUnified ? `${accountId}:${uid}` : uid;
  useMailStore.setState({ selectedThread: null, selectedEmailId, loadingEmail: true, selectedEmail: null, selectedEmailSource: source, lastSelectedAccountId: accountId });

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
      useMailStore.setState({ selectedEmail: withAccount(fresh), selectedEmailSource: source, loadingEmail: false });
      await _autoMarkRead(useMailStore, {
        email: fresh, accountId, mailbox, uid, isUnified,
        markOnServer: () => _setSeenOnServer(account, accountId, mailbox, uid, true),
      });
      return;
    }

    // 2. Check Maildir for cached .eml file
    const headerRow = get().emails.find(e => isUnified ? (e._accountId === accountId && e.uid === uid) : e.uid === uid)
      || get().sortedEmails.find(e => e.uid === uid);
    const localEmail = await _readVerifiedLocal(accountId, mailbox, uid, headerRow);

    if (localEmail && (source === 'local-only' || localEmail.html !== undefined)) {
      email = localEmail;
      actualSource = source === 'local-only' ? 'local-only' : 'local';
      get().addToCache(cacheKey, email, cacheLimitMB);
    } else if (source === 'local-only') {
      // Local-only means there is no server copy to fall back to, so a vault
      // copy that failed the check above leaves nothing to render. Throwing
      // hands the catch below its header-only path, which shows the row with
      // an explicit body error — the one honest option left.
      throw new Error(t('errors.noLocalCopyUidMismatch'));
    } else if (account && isGraphAccount(account)) {
      // 3a. Graph API: fetch full message by Graph message ID
      const freshAccount = await ensureFreshToken(account);
      const token = freshAccount.oauth2AccessToken;

      // Row `_graphId` first, then the positional map, then a relist — the
      // ladder now lives in cacheManager and is shared with the delete, move
      // and mark-read paths, which used to read the map raw.
      const graphId = await resolveGraphMessageId(accountId, mailbox, uid, { row: headerRow, token });

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
      selectedEmail: withAccount(email),
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
        useMailStore.setState({ error: decodeImapUtf7(`Failed to load email (UID ${uid}, ${mailbox}): ${detail}`) });
        return;
      }
      useMailStore.setState({
        selectedEmail: withAccount({ ...headerEmail, text: headerEmail.snippet || '', _bodyError: detail }),
        selectedEmailSource: 'header-only',
      });
    };

    try {
      // Same check as the primary read: a fallback is still a render, and the
      // wrong message is worse here than an honest "body did not load".
      const localEmail = await _readVerifiedLocal(accountId, mailbox, uid, get().emails.find(e => e.uid === uid));
      if (localEmail) {
        useMailStore.setState({ selectedEmail: withAccount(localEmail), selectedEmailSource: 'local-only' });
      } else {
        headerOnly();
      }
    } catch (fallbackError) {
      console.error('[selectEmail] Fallback also failed:', fallbackError);
      headerOnly();
    }

    // The server proved this uid is not in the mailbox (MessageGoneError is
    // thrown only after a tagged OK with no rows — see uid_still_present).
    // Deleting the message from another client used to leave the row behind
    // for good: it errored on every click and came back on every reload,
    // because the header sidecar still held it. Last, so the viewer keeps
    // whatever it just rendered — an archived copy, or the header with the
    // reason on it — and the row's disappearance is explained rather than
    // silent. `skipRefresh` because loadEmails() is a whole mailbox reload
    // and the caller only clicked a row.
    if (error?.messageGone) {
      try {
        await applyServerRemoval(uid, { accountId, mailbox, isUnified, skipRefresh: true, clearSelection: false });
      } catch (pruneError) {
        console.warn('[selectEmail] Could not prune the vanished row:', pruneError);
      }

      // This mailbox lost the message — which on its own is the most ordinary
      // event there is: an archive, a filter, a delete-to-Bin all look exactly
      // like this, and the message is alive under another folder. But it is
      // ALSO what it looks like when someone else deleted the mail for good,
      // and for an archived message that is the difference between a vault
      // holding a spare copy and a vault holding the only one. So ask: is this
      // Message-ID in ANY folder? The sweep writes its verdict to the vault
      // entry, so the row keeps it across reloads.
      //
      // Only for a message the vault actually holds — nothing rides on the
      // answer otherwise — and never awaited: it is a SELECT per folder, and
      // the click that started this is waiting on `loadingEmail`.
      if (get().archivedEmailIds?.has(uid)) {
        probeServerCopy(uid, { accountId, mailbox })
          .catch(probeError => console.warn('[selectEmail] Server-wide check failed:', probeError));
      }
    }
  } finally {
    useMailStore.setState({ loadingEmail: false });

    // Pre-fetch adjacent email bodies in background
    get()._prefetchAdjacentEmails(uid);
  }
}
