// The durable half of compose sending. A queued undo-send must not close over
// a React editor: its serialized snapshot is all this module needs to retry.

import * as api from './api';
import * as db from './db';
import { deleteLocalDraft } from './localDrafts';
import { markAnswered, markForwarded } from './workflows/messageMutations';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore, hasPremiumAccess } from '../stores/settingsStore';
import { findSentMailboxPath } from '../utils/sentFolder';
import { extractInlineImages } from '../utils/inlineImages';
import { withAttachmentBytes } from './attachmentUtils';
import { splitRecipients } from '../utils/emailParser';
import { useScheduledStore } from '../stores/scheduledStore';
import { zonedTimeToEpoch } from '../utils/scheduledTime';
import { serverSavesSent } from './providerKind.js';
import { ownAddresses } from '../utils/ownAddresses';
import { t } from '../i18n/index.js';

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
  const attachments = await withAttachmentBytes(snapshot.attachments || []);
  const emailAttachments = [
    ...attachments.map(att => ({
      filename: att.filename,
      content: att.content,
      encoding: 'base64',
      contentType: att.contentType,
      cid: att.cid,
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
  const { replyWireHtml } = await import('../utils/replyQuote');
  const fullHtml = replyWireHtml(composed, quotedHtml, snapshot._forward);
  const fullText = quotedHtml
    ? `${htmlToText(snapshot.body)}\n\n-------- Original Message --------\n${htmlToText(quotedHtml)}`
    : htmlToText(snapshot.body);
  const resolved = await resolveSentMailboxForAccount(account);
  const sentFolderPath = resolved.path;

  return {
    displayName,
    fromAddress,
    sendAsEmail,
    accountForSend: resolved.account,
    // Graph and JMAP servers file their own Sent copy: the daemon must not
    // append a second one.
    sentMailbox: serverSavesSent(account) ? null : sentFolderPath,
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

/// The follow-up reminder this send asked for, in days, or 0 without
/// Premium. The daemon records it once the message is out, and never on a
/// Graph account, whose replies it cannot look for (compose.send, and the
/// scheduled worker for a scheduled send).
function remindDaysFor(snapshot) {
  const days = Number(snapshot._remindDays) || 0;
  if (days <= 0) return 0;
  return hasPremiumAccess(useSettingsStore.getState().billingProfile) ? days : 0;
}

/// The account's own addresses: the login, the default From and every alias.
/// A message from any of them is the user's own, never the reply a reminder
/// waits for. The daemon adds the From the message went out under.
function ownAddressesOf(account) {
  const { aliases, sendAsAddresses } = useSettingsStore.getState() || {};
  return ownAddresses({ account, aliases: aliases?.[account.id], sendAsAddress: sendAsAddresses?.[account.id] });
}

const parseAddresses = raw => splitRecipients(raw || '').map(address => ({ address, name: '' }));
const bareMessageId = id => (id || '').trim().replace(/^</, '').replace(/>$/, '');

// compose.stage refuses with a daemon code, or with untagged text (a
// malformed payload, a lost worker, the daemon away); the user reads any of
// it in the words compose always used. Text already in them stays as it is.
function stageError(err) {
  const message = err?.message || String(err);
  const match = /^E_COMPOSE_(BUILD|STAGE):\s*([\s\S]*)$/.exec(message);
  if (match) {
    const key = match[1] === 'BUILD' ? 'errors.composeBuildOutgoingMime' : 'errors.composeArchiveOutgoing';
    return new Error(t(key, { error: match[2] }));
  }
  const wrapped = ['errors.composeBuildOutgoingMime', 'errors.composeArchiveOutgoing']
    .some(key => message.startsWith(t(key, { error: '' })));
  return wrapped ? err : new Error(t('errors.composeBuildOutgoingMime', { error: message }));
}

// The daemon reports the server's Sent copy within 60 s (the APPEND) plus
// 15 s (asking the server whether a failed APPEND landed anyway). The
// listener outlives both so the list hears it; the staged copy itself is the
// daemon's to remove, listener or not.
const APPEND_LISTEN_MS = 90_000;

/// The list's side of the server's Sent copy: once the server holds it, the
/// optimistic row goes (the daemon already removed the staged copy), and the
/// account's Sent is reloaded either way.
function refreshOnServerCopy({ freshAccount, sentFolderPath, pseudoUid, messageId, allowCleanup }) {
  return async (event) => {
    const payload = event.payload || {};
    await allowCleanup;
    if (payload.ok) {
      const other = item => !(item.uid === pseudoUid && item._accountId === freshAccount.id);
      useMailStore.setState(state => ({
        sentEmails: (state.sentEmails || []).filter(other),
        emails: (state.emails || []).filter(other),
        localEmails: (state.localEmails || []).filter(other),
      }));
    }

    const state = useMailStore.getState();
    try { await state.loadSentHeaders?.(freshAccount.id); } catch (err) { console.warn('[composeSend] refresh Sent failed:', err); }
    if (sentFolderPath && state.activeAccountId === freshAccount.id && state.activeMailbox === sentFolderPath) {
      try { await state.activateAccount?.(freshAccount.id, sentFolderPath, { _backgroundRefresh: true }); } catch (err) { console.warn('[composeSend] refresh active Sent failed:', err); }
    }
    if (messageId) {
      const sent = useMailStore.getState().sentEmails || [];
      console.log('[composeSend] server append reconciled', { messageId, found: sent.some(item => !item._optimistic && item.messageId === messageId) });
    }
  };
}

// The longest send delay compose offers (5 min) plus a minute of slack.
const EDITED_ROW_DUE_MARGIN_MS = 6 * 60 * 1000;

/**
 * Make the function kept by queueSend/retryOutbox. The returned closure holds
 * the one MIME/uid identity for all retries, while its input is plain data that
 * can cross a detached compose-window boundary.
 */
export function createComposeSend({ snapshot, mode, replyTo, account, settings = {} }) {
  let staged = null;

  // This runs at hand-off, before the undo window. An edited scheduled email
  // whose row falls due before the longest send delay (5 min) runs out would
  // fire from the row while this copy still waits to go: the recipient gets
  // both. So such a row goes now, and the pending send holds the message.
  // Undo reopens compose from this same snapshot, so the edit markers go too:
  // it is a new email from here, and a later Schedule creates a row instead
  // of being refused for replacing a cancelled one. So does its baseline:
  // with the row's copy deleted, the reopened window (Undo, or outbox
  // Dismiss) is the only one, and must read as unsaved work that asks before
  // closing and autosaves to Drafts. A row due later stays queued until the
  // send is out (below), where it survives a quit.
  // ponytail: a quit inside the undo window loses this send, like any other
  // queued send; a durable pending-send queue would cover both.
  const edited = snapshot._editScheduledRow;
  if (snapshot._editScheduledId && edited?.localTime && edited?.tz
      && zonedTimeToEpoch(edited.localTime, edited.tz) <= Date.now() + EDITED_ROW_DUE_MARGIN_MS) {
    useScheduledStore.getState().cancel(snapshot._editScheduledId)
      .catch(err => console.warn('[composeSend] could not cancel the edited scheduled send:', err));
    delete snapshot._editScheduledId;
    delete snapshot._editScheduledRow;
    snapshot._baseline = null;
  }

  return async function sendCompose() {
    const freshAccount = account;
    if (!freshAccount) throw new Error(t('errors.composeRefreshAccount'));
    const { displayName, fromAddress, sendAsEmail, accountForSend, sentMailbox, sentFolderPath, bodyText, outgoingPayload } =
      await buildOutgoingPayload({ snapshot, account: freshAccount, settings });
    const sendAccount = { ...accountForSend, name: displayName, fromEmail: sendAsEmail || undefined };
    // What the Sent row says that the bytes do not: the text written, without
    // the quote, and whether anything was attached (not an inline picture).
    const rowHints = { snippet: bodyText.slice(0, 200), hasAttachments: (snapshot.attachments || []).length > 0 };

    // The daemon writes the copy before anything goes. Once, so a retry is
    // the same message under the same uid.
    if (!staged) {
      try {
        staged = await api.stageOutgoing(sendAccount, outgoingPayload, {
          accountId: freshAccount.id, mailbox: sentFolderPath || 'Sent', ...rowHints,
        });
      } catch (err) {
        throw stageError(err);
      }
    }
    const { uid: pseudoUid, mailbox: localMailbox, messageId } = staged;

    // Subscribed before the send: a Graph or JMAP server files its own Sent
    // copy, and the daemon says so before compose.send answers.
    let unlistenAppend = null;
    let markLocalStageDone;
    const localStageDone = new Promise(resolve => { markLocalStageDone = resolve; });
    try {
      const { listen } = await import('@tauri-apps/api/event');
      let handled = false;
      const handler = refreshOnServerCopy({ freshAccount, sentFolderPath, pseudoUid, messageId, allowCleanup: localStageDone });
      const ownId = bareMessageId(messageId);
      unlistenAppend = await listen('send-server-append-complete', async event => {
        if (handled) return;
        const payload = event.payload || {};
        if (payload.accountId !== freshAccount.email && payload.accountId !== freshAccount.id) return;
        // Only this message's: another send from the same account (a
        // scheduled one) says nothing about this copy.
        if (ownId && bareMessageId(payload.messageIdHeader) !== ownId) return;
        handled = true;
        try { await handler(event); } finally { try { unlistenAppend?.(); } catch {} }
      });
    } catch (err) {
      console.warn('[composeSend] append event subscription failed:', err);
      setTimeout(() => useMailStore.getState().loadSentHeaders?.(freshAccount.id), 8000);
    }

    let sent;
    try {
      // Sent under the staged copy's Message-ID. The daemon then cancels an
      // edited scheduled row this replaces, records the reminder, marks the
      // copy sent and removes it once the server holds its own. None of that
      // fails a send that went out.
      sent = await api.sendStaged(sendAccount, outgoingPayload, {
        accountId: freshAccount.id, mailbox: localMailbox, uid: pseudoUid, messageId, sentMailbox, ...rowHints,
        remindDays: remindDaysFor(snapshot), ownAddresses: ownAddressesOf(freshAccount),
        cancelScheduledId: snapshot._editScheduledId || null,
      });
      const original = snapshot._replyTo || replyTo;
      if (mode === 'reply' || mode === 'replyAll') markAnswered(original).catch(err => console.warn('[composeSend] \\Answered not set:', err));
      else if (mode === 'forward') markForwarded(original).catch(err => console.warn('[composeSend] $Forwarded not set:', err));
      useSettingsStore.getState().setLastComposeIdentity(freshAccount.id, fromAddress);
      if (snapshot._draftUid && snapshot._draftMailbox) {
        await deleteLocalDraft({ accountId: snapshot._draftAccountId || snapshot._accountId || freshAccount.id, mailbox: snapshot._draftMailbox, uid: snapshot._draftUid });
      }
      setTimeout(() => { try { unlistenAppend?.(); } catch {} }, APPEND_LISTEN_MS);
    } catch (err) {
      try { unlistenAppend?.(); } catch {}
      markLocalStageDone();
      throw err;
    }

    // eslint-disable-next-line no-unused-vars
    const { flags: _flags, source: _source, ...indexBase } = sent?.entry || staged.entry || {};
    const optimistic = {
      ...indexBase,
      cc: parseAddresses(snapshot.cc), bcc: parseAddresses(snapshot.bcc),
      internal_date: indexBase.date, internalDate: indexBase.date, messageId: indexBase.message_id,
      inReplyTo: indexBase.in_reply_to, hasAttachments: indexBase.has_attachments,
      read: true, flags: ['\\Seen'], _accountId: freshAccount.id, _optimistic: true, _localStaged: true,
      // Where the staged copy lives. Unstamped, the INBOX merge guessed the
      // ACTIVE account's Sent path, which is the wrong folder for a reply sent
      // from another account in All inboxes. (`_fromSentFolder` is the merge's
      // to stamp: this same row is also a plain row of an open Sent folder.)
      _accountEmail: freshAccount.email, _mailbox: localMailbox,
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

/**
 * Create a daemon schedule from the same frozen snapshot used by immediate
 * send, or save an edited scheduled email (`_editScheduledId`) over its row.
 */
export async function scheduleCompose({ snapshot, account, settings = {} }) {
  // Scheduling at a set time is Premium. Compose shows a free user a locked
  // panel instead of the picker; this is the one place both the in-window and
  // the detached Schedule land, so a stale panel cannot get past it. What is
  // already queued keeps sending: the daemon's worker is never gated.
  if (!hasPremiumAccess(useSettingsStore.getState().billingProfile)) throw new Error(t('errors.composeSchedulePremium'));
  const schedule = snapshot._scheduleDraft;
  if (!schedule?.localTime || !schedule?.tz) throw new Error(t('errors.composeMissingSchedule'));
  const freshAccount = account;
  if (!freshAccount) throw new Error(t('errors.composeRefreshAccount'));
  const { displayName, sendAsEmail, accountForSend, sentMailbox, outgoingPayload } =
    await buildOutgoingPayload({ snapshot, account: freshAccount, settings });
  const fields = {
    account: { ...accountForSend, name: displayName, fromEmail: sendAsEmail || undefined },
    email: outgoingPayload,
    localTime: schedule.localTime,
    tz: schedule.tz,
    fireAt: zonedTimeToEpoch(schedule.localTime, schedule.tz),
    sentMailbox,
    // The daemon records the reminder once the frozen message goes out.
    remindDays: remindDaysFor(snapshot),
    ownAddresses: ownAddressesOf(freshAccount),
  };
  const store = useScheduledStore.getState();
  const editId = snapshot._editScheduledId;
  if (editId && snapshot._editScheduledRow?.accountId === freshAccount.id) {
    // Replaced in place, so the old message holds its slot until the new one
    // is saved. The daemon refuses once the row has fired (a catalog-keyed
    // E_ code), which leaves the compose window open with everything in it.
    await store.replace(editId, fields);
  } else {
    // A row belongs to the account whose vault holds its .eml, so an edit
    // moved to another From account is a new row. The old one is cancelled
    // first, and that cancel is checked: the daemon refuses a row it is
    // sending or has sent, and a new row beside it would send the email
    // twice. A refusal, or a create that fails after the cancel, leaves the
    // window open with the message (ComposeModal handleSchedule), and a
    // retry comes back here: cancelling a cancelled row is a no-op.
    if (editId) await store.cancel(editId);
    await store.create({ accountId: freshAccount.id, ...fields });
  }
  if (snapshot._draftUid && snapshot._draftMailbox) {
    await deleteLocalDraft({ accountId: snapshot._draftAccountId || snapshot._accountId || freshAccount.id, mailbox: snapshot._draftMailbox, uid: snapshot._draftUid });
  }
}
