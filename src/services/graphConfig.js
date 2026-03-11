// ── Graph transport configuration ─────────────────────────────────────────
// Single source of truth for Graph API constants and helpers.
// Previously duplicated in mailStore.js, AccountPipeline.js, EmailPipelineManager.js.

export function isGraphAccount(account) {
  return account?.oauth2Transport === 'graph';
}

// Map Graph API folder display names to IMAP-style names used by the app
export const GRAPH_FOLDER_NAME_MAP = {
  'Inbox': 'INBOX',
  'Sent Items': 'Sent',
  'Drafts': 'Drafts',
  'Deleted Items': 'Trash',
  'Junk Email': 'Junk',
  'Archive': 'Archive',
};

// Reverse map: app mailbox name → Graph display name (for folder ID lookup)
export const APP_TO_GRAPH_FOLDER_MAP = Object.fromEntries(
  Object.entries(GRAPH_FOLDER_NAME_MAP).map(([k, v]) => [v, k])
);

export function normalizeGraphFolderName(displayName) {
  return GRAPH_FOLDER_NAME_MAP[displayName] || displayName;
}

export function inferSpecialUse(displayName) {
  switch (displayName) {
    case 'Inbox': return '\\Inbox';
    case 'Sent Items': return '\\Sent';
    case 'Drafts': return '\\Drafts';
    case 'Deleted Items': return '\\Trash';
    case 'Junk Email': return '\\Junk';
    case 'Archive': return '\\Archive';
    default: return null;
  }
}

// Convert Graph folder objects to MailboxInfo format matching IMAP mailbox shape
export function graphFoldersToMailboxes(graphFolders) {
  return graphFolders.map(f => ({
    name: normalizeGraphFolderName(f.displayName),
    path: normalizeGraphFolderName(f.displayName),
    specialUse: inferSpecialUse(f.displayName),
    flags: [],
    delimiter: '/',
    noselect: false,
    children: [],
    _graphFolderId: f.id, // stash Graph folder ID for message fetching
  }));
}

// Convert a GraphMessage (from graphGetMessage) to the email object format the UI expects
export function graphMessageToEmail(graphMsg, uid) {
  const from = graphMsg.from
    ? { name: graphMsg.from.emailAddress?.name || null, address: graphMsg.from.emailAddress?.address || '' }
    : { name: 'Unknown', address: 'unknown@unknown.com' };

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
    bcc: [],
    date: graphMsg.receivedDateTime || null,
    flags,
    messageId: graphMsg.internetMessageId || null,
    hasAttachments: graphMsg.hasAttachments || false,
    html: bodyType === 'html' ? bodyContent : null,
    text: bodyType === 'text' ? bodyContent : (bodyType === 'html' ? null : bodyContent),
    attachments: [],
    source: 'server',
  };
}
