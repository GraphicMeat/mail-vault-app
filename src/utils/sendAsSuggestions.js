// ── sendAsSuggestions — candidate "send mail as" addresses from cached mail ──
//
// Discovering aliases from the provider needs credentials we don't hold
// (Fastmail JMAP is scoped separately from the IMAP app password; Gmail's
// settings.sendAs.list needs a restricted OAuth scope), so we mine the user's
// own cached headers instead. Suggestions only — the SMTP server is the
// authority on what it will accept.
//
// Sent `From` is the ONLY source. We used to also mine To/Cc of received mail,
// gated on the address turning up from 3+ distinct senders, and it offered a
// logistics user his counterparties' staff: To/Cc membership says a person was
// on the thread, never that mail addressed to them lands in this mailbox, and
// no frequency gate separates the two (a shared crew is Cc'd by many senders,
// so the gate is free). Only Delivered-To / X-Original-To carries that fact and
// we don't fetch those headers — capture them first if received-only aliases
// need to be discoverable.

import { findSentMailboxPath } from './sentFolder';

const SENT_HEADERS = 300;
const MAX_SUGGESTIONS = 8;

function _norm(addr) {
  return (addr?.address || addr?.email || '').toLowerCase().trim();
}

/**
 * Rank alias candidates for one account: addresses this mailbox has provably
 * sent as before, most-used first.
 *
 * @param {object[]} sent cached Sent headers
 * @param {string} loginAddress the account's own login address, excluded
 * @returns {{ address: string, count: number }[]}
 */
export function rankSendAsCandidates(sent, loginAddress) {
  const own = (loginAddress || '').toLowerCase().trim();
  const out = new Map();

  for (const email of sent || []) {
    const address = _norm(email?.from);
    if (!address || address === own || !address.includes('@')) continue;
    const entry = out.get(address) || { address, count: 0 };
    entry.count += 1;
    out.set(address, entry);
  }

  return [...out.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_SUGGESTIONS);
}

/** Read this account's cached Sent headers and rank the candidates. */
export async function suggestSendAsAddresses(account) {
  if (!account?.id) return [];
  try {
    const db = await import('../services/db');
    const mailboxes = await db.getCachedMailboxes(account.id).catch(() => null);
    const sentPath = findSentMailboxPath(mailboxes);
    if (!sentPath) return [];
    const sentData = await db
      .getEmailHeadersPartial(account.id, sentPath, SENT_HEADERS)
      .catch(() => null);
    return rankSendAsCandidates(sentData?.emails || [], account.email);
  } catch (err) {
    console.warn('[sendAsSuggestions] failed:', err?.message || err);
    return [];
  }
}
