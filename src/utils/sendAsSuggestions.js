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
import { t } from '../i18n/index.js';

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

/**
 * Every address compose may send from, one entry per (account, address):
 * the account's default first (its send-as override, else the login), then
 * the login, then addresses it has provably sent as. Case-insensitive dedupe.
 * `key` is what the From <select> carries; split on the first space.
 *
 * @param {object[]} accounts
 * @param {Record<string, string>} sendAsAddresses per-account From override
 * @param {Record<string, {address: string}[]>} sentAsByAccount mined candidates
 * @returns {{ key: string, accountId: string, address: string }[]}
 */
export function composeIdentities(accounts, sendAsAddresses = {}, sentAsByAccount = {}) {
  const out = [];

  for (const account of accounts || []) {
    if (!account?.id) continue;
    const seen = new Set();
    const override = (sendAsAddresses[account.id] || '').trim();
    const mined = (sentAsByAccount[account.id] || []).map(entry => entry.address);

    for (const address of [override, account.email, ...mined]) {
      const clean = (address || '').trim();
      if (!clean || seen.has(clean.toLowerCase())) continue;
      seen.add(clean.toLowerCase());
      out.push({ key: `${account.id} ${clean}`, accountId: account.id, address: clean });
    }
  }

  return out;
}

/**
 * Which identity a compose window opens with. Precedence:
 * restored draft's saved identity → the replied-to message's account →
 * the identity that sent the last message → the active account.
 * `address: ''` means "the account's default From".
 *
 * A reply or forward never reaches the last-sent identity: it leaves from the
 * mailbox the message being answered is in, and the account being read is the
 * fallback when that message carries no provenance of its own.
 */
export function resolveInitialComposeIdentity({ replyTo, initialData, lastIdentity, accounts, activeAccountId }) {
  const exists = (id) => (accounts || []).some(a => a.id === id);
  if (initialData) {
    if (initialData._accountId && exists(initialData._accountId)) {
      return { accountId: initialData._accountId, address: initialData._fromAddress || '' };
    }
    // A mailto: prefill carries no saved identity: it is a fresh compose and
    // follows the same precedence as one opened from the Compose button.
    if (initialData._prefill) return resolveInitialComposeIdentity({ lastIdentity, accounts, activeAccountId });
    // Draft saved before identities were persisted — keep the old behavior.
    return { accountId: activeAccountId, address: '' };
  }
  if (replyTo) {
    // Provenance is often missing here — a body fetched from the server carries
    // no `_accountId`, and a row click forwards a bare uid — and then the
    // mailbox being read is the honest answer. The identity that last SENT is
    // not: it belongs to whatever mailbox the user was in before this one.
    const source = replyTo._accountId || replyTo._srcAccountId;
    return { accountId: exists(source) ? source : activeAccountId, address: '' };
  }
  if (lastIdentity && exists(lastIdentity.accountId)) {
    return { accountId: lastIdentity.accountId, address: lastIdentity.address || '' };
  }
  return { accountId: activeAccountId, address: '' };
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
