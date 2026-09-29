// ── sendAsSuggestions: compose identities, and the old "send mail as" chips ──
//
// composeIdentities / composeSenderName / resolveInitialComposeIdentity decide
// what compose's From row offers and sends as. Aliases themselves come from
// the daemon's `aliases.discover` (services/aliasDiscovery.js), which reads
// the provider's send-as list and the account's own mail.
//
// rankSendAsCandidates / suggestSendAsAddresses below are the chips under the
// old Settings "Send Mail As" field, and go with it: they mine the user's own
// cached Sent headers. Suggestions only, the SMTP server is the authority on
// what it will accept.
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
 * the account's default first (its default From, else the login), then the
 * login, then every alias (settingsStore `aliases`, which discovery fills from
 * the provider and from what the account has sent as). Case-insensitive
 * dedupe. `key` is what the From <select> carries; split on the first space.
 * `name` is the alias's own name, '' when it has none.
 *
 * @param {object[]} accounts
 * @param {Record<string, string>} sendAsAddresses per-account default From
 * @param {Record<string, {address: string, name?: string}[]>} aliasesByAccount
 * @returns {{ key: string, accountId: string, address: string, name: string }[]}
 */
export function composeIdentities(accounts, sendAsAddresses = {}, aliasesByAccount = {}) {
  const out = [];

  for (const account of accounts || []) {
    if (!account?.id) continue;
    const seen = new Set();
    const aliases = aliasesByAccount?.[account.id] || [];
    const defaultFrom = (sendAsAddresses?.[account.id] || '').trim();

    for (const address of [defaultFrom, account.email, ...aliases.map(alias => alias?.address)]) {
      const clean = (address || '').trim();
      if (!clean || seen.has(clean.toLowerCase())) continue;
      seen.add(clean.toLowerCase());
      out.push({ key: `${account.id} ${clean}`, accountId: account.id, address: clean, name: aliasName(aliases, clean) });
    }
  }

  return out;
}

function aliasName(aliases, address) {
  const k = (address || '').trim().toLowerCase();
  const alias = k && (aliases || []).find(a => (a?.address || '').trim().toLowerCase() === k);
  return (alias?.name || '').trim();
}

/**
 * The display name a message goes out under: the name of the alias it leaves
 * from, else the account's name (`displayName` from Settings, else the
 * account's own), else its login. The sender drops a name that is only an
 * address (smtp.rs), so the last resort never reaches the header.
 * `fromAddress` '' means the account's default From.
 */
export function composeSenderName({ account, fromAddress, displayName, aliases, sendAsAddress }) {
  const from = (fromAddress || sendAsAddress || account?.email || '').trim();
  return aliasName(aliases, from) || displayName || account?.name || account?.email || '';
}

/**
 * Which identity a compose window opens with. Precedence:
 * restored draft's saved identity → the replied-to message's account →
 * the mailbox being read → the active account.
 * `address: ''` means "the account's default From".
 *
 * A reply or forward never reaches the last-sent identity: it leaves from the
 * mailbox the message being answered is in, and the account being read is the
 * fallback when that message carries no provenance of its own.
 */
export function resolveInitialComposeIdentity({ replyTo, initialData, lastIdentity, accounts, activeAccountId, selectedAccountId }) {
  const exists = (id) => (accounts || []).some(a => a.id === id);
  if (initialData) {
    if (initialData._accountId && exists(initialData._accountId)) {
      return { accountId: initialData._accountId, address: initialData._fromAddress || '' };
    }
    // A mailto: prefill carries no saved identity: it is a fresh compose and
    // follows the same precedence as one opened from the Compose button.
    if (initialData._prefill) return resolveInitialComposeIdentity({ lastIdentity, accounts, activeAccountId, selectedAccountId });
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
  // A fresh compose sends from the mailbox the user is reading — the selected
  // account, or in the unified inbox the account of the last message opened
  // there. The last *sent* identity used to win here, so composing right after
  // switching account opened on the other account's address.
  const accountId = exists(selectedAccountId) ? selectedAccountId : activeAccountId;
  // The remembered identity is an address, not an account: it only carries over
  // when the account being read is the one that sent as it.
  const address = lastIdentity?.accountId === accountId ? (lastIdentity.address || '') : '';
  return { accountId, address };
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
