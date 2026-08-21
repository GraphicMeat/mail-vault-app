// ── sendAsSuggestions — candidate "send mail as" addresses from cached mail ──
//
// Discovering aliases from the provider needs credentials we don't hold
// (Fastmail JMAP is scoped separately from the IMAP app password; Gmail's
// settings.sendAs.list needs a restricted OAuth scope), so we mine the user's
// own cached headers instead. Suggestions only — the SMTP server is the
// authority on what it will accept.

import { findSentMailboxPath } from './sentFolder';

// An address seen in To/Cc of received mail is only a delivery address for
// this mailbox if it keeps showing up across DIFFERENT senders — otherwise it
// is just a co-recipient on one thread.
const MIN_DISTINCT_SENDERS = 3;
const HEADERS_PER_FOLDER = 300;
const MAX_SUGGESTIONS = 8;

function _norm(addr) {
  return (addr?.address || addr?.email || '').toLowerCase().trim();
}

function _inboxPaths(mailboxes, flat = []) {
  for (const box of mailboxes || []) {
    if (box?.path) flat.push(box);
    if (box?.children?.length) _inboxPaths(box.children, flat);
  }
  return flat
    .filter(b => b.specialUse === '\\Inbox' || /^inbox$/i.test(b.name || '') || /^inbox$/i.test(b.path || ''))
    .map(b => b.path);
}

/**
 * Rank alias candidates for one account.
 *
 * @param {{ sent?: object[], inbox?: object[] }} sources cached headers
 * @param {string} loginAddress the account's own login address, excluded
 * @returns {{ address: string, source: 'sent'|'inbox', count: number }[]}
 */
export function rankSendAsCandidates({ sent = [], inbox = [] }, loginAddress) {
  const own = (loginAddress || '').toLowerCase().trim();
  const out = new Map();

  // Source A — From addresses in Sent. Exact: the mailbox has demonstrably
  // sent as this address before.
  for (const email of sent) {
    const address = _norm(email?.from);
    if (!address || address === own || !address.includes('@')) continue;
    const entry = out.get(address) || { address, source: 'sent', count: 0, senders: new Set() };
    entry.count += 1;
    entry.source = 'sent';
    out.set(address, entry);
  }

  // Source B — To/Cc addresses on received mail, gated on distinct senders.
  for (const email of inbox) {
    const sender = _norm(email?.from);
    if (!sender || sender === own) continue;
    for (const addr of [...(email?.to || []), ...(email?.cc || [])]) {
      const address = _norm(addr);
      if (!address || address === own || !address.includes('@')) continue;
      const entry = out.get(address) || { address, source: 'inbox', count: 0, senders: new Set() };
      entry.count += 1;
      entry.senders.add(sender);
      out.set(address, entry);
    }
  }

  return [...out.values()]
    .filter(e => e.source === 'sent' || e.senders.size >= MIN_DISTINCT_SENDERS)
    .sort((a, b) => (a.source === b.source ? b.count - a.count : a.source === 'sent' ? -1 : 1))
    .slice(0, MAX_SUGGESTIONS)
    .map(({ address, source, count }) => ({ address, source, count }));
}

/** Read this account's cached Sent + INBOX headers and rank the candidates. */
export async function suggestSendAsAddresses(account) {
  if (!account?.id) return [];
  try {
    const db = await import('../services/db');
    const mailboxes = await db.getCachedMailboxes(account.id).catch(() => null);
    const sentPath = findSentMailboxPath(mailboxes);
    const inboxPath = _inboxPaths(mailboxes)[0] || 'INBOX';
    const read = (path) => (path
      ? db.getEmailHeadersPartial(account.id, path, HEADERS_PER_FOLDER).catch(() => null)
      : Promise.resolve(null));
    const [sentData, inboxData] = await Promise.all([read(sentPath), read(inboxPath)]);
    return rankSendAsCandidates(
      { sent: sentData?.emails || [], inbox: inboxData?.emails || [] },
      account.email
    );
  } catch (err) {
    console.warn('[sendAsSuggestions] failed:', err?.message || err);
    return [];
  }
}
