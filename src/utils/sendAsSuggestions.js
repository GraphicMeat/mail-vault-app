// ── sendAsSuggestions: the identities compose offers and sends as ──
//
// composeIdentities / composeSenderName / resolveInitialComposeIdentity decide
// what compose's From row offers and sends as. Aliases themselves come from
// the daemon's `aliases.discover` (services/aliasDiscovery.js), which reads
// the provider's send-as list and the account's own mail, and from what the
// user adds in Settings > Accounts > Aliases. The SMTP server stays the
// authority on what it will accept (that is what Verify there is for).

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
