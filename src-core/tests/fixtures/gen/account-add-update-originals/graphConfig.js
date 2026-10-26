import { t } from '../i18n/index.js';
// ── Graph transport configuration ─────────────────────────────────────────
// Single source of truth for Graph API constants and helpers.
// Previously duplicated in mailStore.js, AccountPipeline.js, EmailPipelineManager.js.

export function isGraphAccount(account) {
  return account?.oauth2Transport === 'graph';
}

/**
 * Personal Microsoft domains that require Graph transport (IMAP XOAUTH2 is broken).
 * Shared source of truth — used by AccountModal, db.js auto-repair, and error handling.
 */
export const PERSONAL_MS_DOMAINS = [
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'outlook.co.uk', 'hotmail.co.uk', 'live.co.uk',
  'outlook.fr', 'hotmail.fr', 'live.fr',
  'outlook.de', 'hotmail.de', 'live.de',
  'outlook.jp', 'hotmail.co.jp', 'live.jp',
];

/**
 * Check if an email address belongs to a personal Microsoft domain.
 * These accounts must use Graph transport, not IMAP XOAUTH2.
 */
export function isPersonalMicrosoftEmail(email) {
  if (!email) return false;
  const domain = email.toLowerCase().split('@')[1];
  return domain ? PERSONAL_MS_DOMAINS.includes(domain) : false;
}

// ── Folder keys ───────────────────────────────────────────────────────────
// Rust's `list_folders` stamps every Graph folder with `storageKey` (the
// locale-independent word every store is keyed by: vault dir, sidecar dir and
// its uid ledger, index, mirror) and `wellKnownName` (Graph's own name for a
// default folder). Nothing here derives a key from a display name: Outlook
// names default folders in the MAILBOX's language, and the UI catalog once
// leaked into this key too (v2.11.0 through v2.13.1), which split one folder
// into two directories per language.
export const WELL_KNOWN = {
  inbox:        { specialUse: '\\Inbox',   labelKey: null },
  sentitems:    { specialUse: '\\Sent',    labelKey: 'list.sent' },
  drafts:       { specialUse: '\\Drafts',  labelKey: 'sidebar.drafts' },
  deleteditems: { specialUse: '\\Trash',   labelKey: 'settings.storage.trash' },
  junkemail:    { specialUse: '\\Junk',    labelKey: 'svc.graphConfig.junk' },
  archive:      { specialUse: '\\Archive', labelKey: 'common.archive' },
};

/** The storage key of a Graph folder object; a listing from an older binary
 *  has none and keys by display name, as it always did for custom folders. */
export const storageKeyOf = (f) => f.storageKey ?? f.displayName;

// Convert Graph folder objects to MailboxInfo format matching IMAP mailbox shape:
// `path` is the storage key, `name` the word the UI shows (INBOX stays INBOX,
// as it does for an IMAP account).
export function graphFoldersToMailboxes(graphFolders) {
  return graphFolders.map(f => {
    const known = f.wellKnownName ? WELL_KNOWN[f.wellKnownName] : null;
    const path = storageKeyOf(f);
    return {
      name: known ? (known.labelKey ? t(known.labelKey) : path) : f.displayName,
      path,
      specialUse: known?.specialUse ?? null,
      flags: [],
      delimiter: '/',
      noselect: false,
      children: [],
      _graphFolderId: f.id, // stash Graph folder ID for message fetching
    };
  });
}

// Convert a GraphMessage (from graphGetMessage) to the email object format the UI expects
export function graphMessageToEmail(graphMsg, uid) {
  const from = graphMsg.from
    ? { name: graphMsg.from.emailAddress?.name || null, address: graphMsg.from.emailAddress?.address || '' }
    : { name: t('settings.cleanup.unknown'), address: 'unknown@unknown.com' };

  const to = (graphMsg.toRecipients || []).map(r => ({
    name: r.emailAddress?.name || null,
    address: r.emailAddress?.address || '',
  }));

  const cc = (graphMsg.ccRecipients || []).map(r => ({
    name: r.emailAddress?.name || null,
    address: r.emailAddress?.address || '',
  }));

  const flags = [];
  if (graphMsg.isRead) flags.push('\\Seen');

  const bodyType = graphMsg.body?.contentType?.toLowerCase();
  const bodyContent = graphMsg.body?.content || '';

  return {
    uid,
    seq: uid,
    subject: graphMsg.subject || '',
    from,
    to,
    cc,
    bcc: (graphMsg.bccRecipients || []).map(r => ({
      name: r.emailAddress?.name || null,
      address: r.emailAddress?.address || '',
    })),
    date: graphMsg.receivedDateTime || null,
    receivedAt: graphMsg.receivedDateTime || null,
    sentAt: graphMsg.sentDateTime || null,
    // Keep the RFC Date distinct from Graph's receivedDateTime/legacy date.
    messageDate: graphMsg.internetMessageHeaders?.find(h => h.name?.toLowerCase() === 'date')?.value || null,
    flags,
    messageId: graphMsg.internetMessageId || null,
    hasAttachments: graphMsg.hasAttachments || false,
    html: bodyType === 'html' ? bodyContent : null,
    text: bodyType === 'text' ? bodyContent : (bodyType === 'html' ? null : bodyContent),
    attachments: [],
    source: 'server',
    provider: 'graph',
  };
}
