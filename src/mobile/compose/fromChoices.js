// Pure helpers of Compose's From: the choices the sheet lists (every account with its aliases
// under it) and the signature swap when a compose moves to another account.
import { identitiesOf } from '../compose.js';

/**
 * Every account with the addresses it sends from: `[{ account, identities }]`. `identities` is
 * `identitiesOf` (the login first, then its aliases and `sendAs`); `loaded` maps an account id to
 * its settings, and an account not loaded yet shows just its own address.
 */
export function fromGroups(accounts, loaded) {
  return accounts.map((account) => ({ account, identities: identitiesOf(account.email, loaded.get(account.id) ?? null) }));
}

/**
 * `text` with the signature block of the account it came from (`oldBlock`) replaced by the new
 * account's (`newBlock`; '' for none), so what the user typed stays. The last copy is the one the
 * screen added. With no old block the new one goes above the quote (`quote`, put under the body by
 * a reply or forward), else at the end, unless it is already there. A signature the user deleted
 * is not put back.
 */
export function swapSignature(text, oldBlock, newBlock, { quote = '' } = {}) {
  if (oldBlock) {
    const at = text.lastIndexOf(oldBlock);
    if (at < 0) return text;
    return text.slice(0, at) + newBlock + text.slice(at + oldBlock.length);
  }
  if (!newBlock || text.includes(newBlock)) return text;
  const tail = quote ? `\n\n${quote}` : '';
  if (tail && text.endsWith(tail)) return text.slice(0, -tail.length) + newBlock + tail;
  return text + newBlock;
}
