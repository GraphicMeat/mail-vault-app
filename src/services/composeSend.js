// The durable half of compose sending. A queued undo-send must not close over
// a React editor: its serialized snapshot is all this module needs to retry.

import * as api from './api';
import * as db from './db';
import { ensureFreshToken } from './authUtils';
import { deleteLocalDraft } from './localDrafts';
import { markAnswered, markForwarded } from './workflows/messageMutations';
import { send } from './transport';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';
import { findSentMailboxPath } from '../utils/sentFolder';
import { extractInlineImages } from '../utils/inlineImages';
import { parseReferenceList, splitRecipients } from '../utils/emailParser';
import { useScheduledStore } from '../stores/scheduledStore';
import { zonedTimeToEpoch } from '../utils/scheduledTime';
import { t } from '../i18n/index.js';

const isTauri = () => window.__TAURI__?.core?.invoke;

// Sent-folder resolution is shared by immediate and scheduled sends. Keeping
// it here prevents the detached owner from falling back to a different folder.
export async function resolveSentMailboxForAccount(account) {
  const accountId = account.id;
  const { activeAccountId, mailboxes } = useMailStore.getState();
  let list = activeAccountId === accountId && mailboxes?.length ? mailboxes : null;
  if (!list) list = await db.getCachedMailboxes(accountId).catch(() => null);
  const localHit = findSentMailboxPath(list, account.sentFolderOverride || null);
  if (localHit) return { path: localHit, account };

  try {
    const path = await api.ensureSentMailbox(account);
    if (path) {
      const updated = { ...account, sentFolderOverride: path };
      await db.saveAccount(updated).catch(err => console.warn('[composeSend] failed to persist sentFolderOverride:', err));
      useMailStore.setState(state => ({
        accounts: (state.accounts || []).map(item => item.id === accountId ? { ...item, sentFolderOverride: path } : item),
      }));
      try {
        const freshBoxes = await api.fetchMailboxes(updated);
        if (Array.isArray(freshBoxes) && freshBoxes.length) {
          await db.saveMailboxes?.(accountId, freshBoxes).catch(() => {});
          useMailStore.setState(state => ({
            mailboxes: state.activeAccountId === accountId ? freshBoxes : state.mailboxes,
          }));
        }
      } catch (err) {
        console.warn('[composeSend] post-ensure mailbox refresh failed:', err);
      }
      return { path, account: updated };
    }
  } catch (err) {
    console.warn('[composeSend] ensureSentMailbox failed:', err);
  }
  return { path: null, account };
}

/** Build the mail bytes input from a serializable compose snapshot. */
export async function buildOutgoingPayload({ snapshot, account, settings = {} }) {
  // ComposeModal is lazy-loaded from App. Import its small serialization
  // helpers only when a queued send actually starts, or the detached-owner
  // bridge would pull the editor and TipTap into the initial App chunk.
  const { htmlToText, inlineComposeSpacing } = await import('../components/RichTextEditor');
  const displayName = settings.displayName || account.name || account.email;
  const fromAddress = snapshot._fromAddress || account.email;
  const sendAsEmail = fromAddress !== account.email ? fromAddress : '';
  const inline = extractInlineImages(snapshot.body || '');
  const attachments = snapshot.attachments || [];
  const emailAttachments = [
    ...attachments.map(att => ({
      filename: att.filename,
      content: att.content,
      encoding: 'base64',
      contentType: att.contentType,
    })),
    ...inline.attachments.map(att => ({
      filename: att.filename,
      content: att.content,
      encoding: 'base64',
      contentType: att.contentType,
      cid: att.cid,
    })),
  ];
  const quotedHtml = snapshot._quotedHtml || '';
  const composed = inlineComposeSpacing(inline.html);
  const fullHtml = quotedHtml ? `${composed}<hr><blockquote>${quotedHtml}</blockquote>` : composed;
  const fullText = quotedHtml
    ? `${htmlToText(snapshot.body)}\n\n-------- Original Message --------\n${htmlToText(quotedHtml)}`
    : htmlToText(snapshot.body);
  const isGraph = account.oauth2Transport === 'graph';
  const resolved = await resolveSentMailboxForAccount(account);
  const sentFolderPath = resolved.path;

  return {
    displayName,
    fromAddress,
    sendAsEmail,
    accountForSend: resolved.account,
    sentMailbox: isGraph ? null : sentFolderPath,
    sentFolderPath,
    bodyText: htmlToText(snapshot.body),
    outgoingPayload: {
      to: snapshot.to,
      cc: snapshot.cc || undefined,
      bcc: snapshot.bcc || undefined,
      subject: snapshot.subject,
      text: fullText,
      html: fullHtml,
      inReplyTo: snapshot.inReplyTo || undefined,
      references: snapshot.references || undefined,
      attachments: emailAttachments.length ? emailAttachments : undefined,
    },
  };
}

const parseAddresses = raw => splitRecipients(raw || '').map(address => ({ address, name: '' }));

function cleanupServerAppend({ freshAccount, sentFolderPath, localMailbox, pseudoUid, builtMime, allowCleanup }) {
  return async (event) => {
    const payload = event.payload || {};
    if (payload.accountId !== freshAccount.email && payload.accountId !== freshAccount.id) return;
    await allowCleanup;
    if (payload.ok && isTauri()) {
      try {
        await send('maildir_delete', { accountId: freshAccount.id, mailbox: localMailbox, uid: pseudoUid });
        await send('local_index_remove', { accountId: freshAccount.id, mailbox: localMailbox, uid: pseudoUid });
      } catch (err) {
        console.warn('[composeSend] local cleanup failed:', err);
      }
      useMailStore.setState(state => ({
        sentEmails: (state.sentEmails || []).filter(item => !(item.uid === pseudoUid && item._accountId === freshAccount.id)),
        emails: (state.emails || []).filter(item => !(item.uid === pseudoUid && item._accountId === freshAccount.id)),
        localEmails: (state.localEmails || []).filter(item => !(item.uid === pseudoUid && item._accountId === freshAccount.id)),
      }));
    }

    const state = useMailStore.getState();
    try { await state.loadSentHeaders?.(freshAccount.id); } catch (err) { console.warn('[composeSend] refresh Sent failed:', err); }
    if (sentFolderPath && state.activeAccountId === freshAccount.id && state.activeMailbox === sentFolderPath) {
      try { await state.activateAccount?.(freshAccount.id, sentFolderPath, { _backgroundRefresh: true }); } catch (err) { console.warn('[composeSend] refresh active Sent failed:', err); }
    }
    if (builtMime?.messageId) {
      const sent = useMailStore.getState().sentEmails || [];
      console.log('[composeSend] server append reconciled', { messageId: builtMime.messageId, found: sent.some(item => !item._optimistic && item.messageId === builtMime.messageId) });
    }
  };
}

/**
 * Make the function kept by queueSend/retryOutbox. The returned closure holds
 * the one MIME/uid identity for all retries, while its input is plain data that
 * can cross a detached compose-window boundary.
 */
export function createComposeSend({ snapshot, mode, replyTo, account, settings = {} }) {
  let staged = null;

  return async function sendCompose() {
    const freshAccount = await ensureFreshToken(account);
    if (!freshAccount) throw new Error(t('errors.composeRefreshAccount'));
    const { displayName, fromAddress, sendAsEmail, accountForSend, sentMailbox, sentFolderPath, bodyText, outgoingPayload } =
      await buildOutgoingPayload({ snapshot, account: freshAccount, settings });
    const pseudoUid = staged ? staged.uid : Math.floor(Date.now() / 1000);
    const localMailbox = sentFolderPath || 'Sent';
    let builtMime = staged?.mime;

    if (!builtMime) {
      try {
        builtMime = await api.buildOutgoingMime(
          { ...accountForSend, name: displayName, fromEmail: sendAsEmail || undefined }, outgoingPayload,
        );
      } catch (err) {
        throw new Error(t('errors.composeBuildOutgoingMime', { error: err?.message || err }));
      }
    }
    staged = { uid: pseudoUid, mime: builtMime };

    if (isTauri() && builtMime?.rawBase64) {
      try {
        await send('maildir_store', {
          accountId: freshAccount.id, mailbox: localMailbox, uid: pseudoUid,
          rawSourceBase64: builtMime.rawBase64, flags: ['draft', 'seen'],
        });
      } catch (err) {
        throw new Error(t('errors.composeArchiveOutgoing', { error: err?.message || err }));
      }
    }

    const indexBase = {
      uid: pseudoUid,
      from: { address: fromAddress, name: displayName },
      to: parseAddresses(snapshot.to),
      subject: snapshot.subject,
      date: new Date().toISOString(),
      has_attachments: (snapshot.attachments || []).length > 0,
      message_id: builtMime?.messageId || null,
      in_reply_to: snapshot.inReplyTo || null,
      references: parseReferenceList(snapshot.references).length ? parseReferenceList(snapshot.references) : null,
      snippet: bodyText.slice(0, 200),
    };
    if (isTauri()) {
      try {
        await api.appendLocalIndex(freshAccount.id, localMailbox, [{ ...indexBase, flags: ['draft', 'seen'], source: 'local_draft' }]);
      } catch (err) {
        console.warn('[composeSend] draft index failed:', err);
      }
    }

    let unlistenAppend = null;
    let markLocalStageDone;
    const localStageDone = new Promise(resolve => { markLocalStageDone = resolve; });
    try {
      const { listen } = await import('@tauri-apps/api/event');
      let handled = false;
      const handler = cleanupServerAppend({ freshAccount, sentFolderPath, localMailbox, pseudoUid, builtMime, allowCleanup: localStageDone });
      unlistenAppend = await listen('send-server-append-complete', async event => {
        if (handled) return;
        const payload = event.payload || {};
        if (payload.accountId !== freshAccount.email && payload.accountId !== freshAccount.id) return;
        handled = true;
        try { await handler(event); } finally { try { unlistenAppend?.(); } catch {} }
      });
    } catch (err) {
      console.warn('[composeSend] append event subscription failed:', err);
      setTimeout(() => useMailStore.getState().loadSentHeaders?.(freshAccount.id), 8000);
    }

    try {
      await api.sendEmail(
        { ...accountForSend, name: displayName, fromEmail: sendAsEmail || undefined }, outgoingPayload, sentMailbox,
      );
      const original = snapshot._replyTo || replyTo;
      if (mode === 'reply' || mode === 'replyAll') markAnswered(original).catch(err => console.warn('[composeSend] \\Answered not set:', err));
      else if (mode === 'forward') markForwarded(original).catch(err => console.warn('[composeSend] $Forwarded not set:', err));
      useSettingsStore.getState().setLastComposeIdentity(freshAccount.id, fromAddress);
      if (snapshot._draftUid && snapshot._draftMailbox) {
        await deleteLocalDraft({ accountId: snapshot._draftAccountId || snapshot._accountId || freshAccount.id, mailbox: snapshot._draftMailbox, uid: snapshot._draftUid });
      }
      setTimeout(() => { try { unlistenAppend?.(); } catch {} }, 30000);
    } catch (err) {
      try { unlistenAppend?.(); } catch {}
      markLocalStageDone();
      throw err;
    }

    if (isTauri() && builtMime?.rawBase64) {
      try {
        await send('maildir_store', {
          accountId: freshAccount.id, mailbox: localMailbox, uid: pseudoUid,
          rawSourceBase64: builtMime.rawBase64, flags: ['archived', 'seen'],
        });
        await api.appendLocalIndex(freshAccount.id, localMailbox, [{ ...indexBase, flags: ['archived', 'seen'], source: 'local_sent' }]);
      } catch (err) {
        console.warn('[composeSend] sent local archive failed:', err);
      }
    }

    const optimistic = {
      ...indexBase,
      cc: parseAddresses(snapshot.cc), bcc: parseAddresses(snapshot.bcc),
      internal_date: indexBase.date, internalDate: indexBase.date, messageId: indexBase.message_id,
      inReplyTo: indexBase.in_reply_to, hasAttachments: indexBase.has_attachments,
      read: true, flags: ['\\Seen'], _accountId: freshAccount.id, _optimistic: true, _localStaged: true,
    };
    useMailStore.setState(state => {
      const dedupById = list => optimistic.messageId ? (list || []).filter(item => item.messageId !== optimistic.messageId) : (list || []);
      const update = { sentEmails: [optimistic, ...dedupById(state.sentEmails)] };
      if (sentFolderPath && state.activeAccountId === freshAccount.id && state.activeMailbox === sentFolderPath) {
        update.emails = [optimistic, ...dedupById(state.emails)];
        update.totalEmails = (state.totalEmails || 0) + 1;
      }
      return update;
    });
    useMailStore.getState().updateSortedEmails?.();
    markLocalStageDone();
  };
}

/** Create a daemon schedule from the same frozen snapshot used by immediate send. */
export async function scheduleCompose({ snapshot, account, settings = {} }) {
  const schedule = snapshot._scheduleDraft;
  if (!schedule?.localTime || !schedule?.tz) throw new Error(t('errors.composeMissingSchedule'));
  const freshAccount = await ensureFreshToken(account);
  if (!freshAccount) throw new Error(t('errors.composeRefreshAccount'));
  const { displayName, sendAsEmail, accountForSend, sentMailbox, outgoingPayload } =
    await buildOutgoingPayload({ snapshot, account: freshAccount, settings });
  await useScheduledStore.getState().create({
    accountId: freshAccount.id,
    account: { ...accountForSend, name: displayName, fromEmail: sendAsEmail || undefined },
    email: outgoingPayload,
    localTime: schedule.localTime,
    tz: schedule.tz,
    fireAt: zonedTimeToEpoch(schedule.localTime, schedule.tz),
    sentMailbox,
  });
  if (snapshot._draftUid && snapshot._draftMailbox) {
    await deleteLocalDraft({ accountId: snapshot._draftAccountId || snapshot._accountId || freshAccount.id, mailbox: snapshot._draftMailbox, uid: snapshot._draftUid });
  }
}
