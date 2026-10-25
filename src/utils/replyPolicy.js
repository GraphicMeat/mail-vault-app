import { ownAddressSet, isOwnAddress } from './ownAddresses.js';

export function normalizeMessageId(id) {
  if (!id) return null;
  const bare = String(id).trim().replace(/^<+|>+$/g, '').trim();
  return bare ? `<${bare}>` : null;
}

/**
 * Message-IDs inside a References / In-Reply-To value, oldest ancestor first.
 *
 * Accepts the array the IMAP and Maildir parsers produce AND the raw header
 * string the local index writes for a locally-sent message; indexing a string
 * gave `refs[0] === '<'`, which made every such message share one bogus thread.
 */
export function parseReferenceList(value) {
  if (!value) return [];
  const parts = Array.isArray(value) ? value : [value];
  const ids = [];
  for (const part of parts) {
    for (const token of String(part).split(/\s+/)) {
      const id = normalizeMessageId(token);
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}


export function buildReplyHeaders(parent) {
  if (!parent) return { inReplyTo: '', references: '' };
  const parentId = normalizeMessageId(parent.messageId || parent.message_id);
  const chain = parseReferenceList(parent.references);
  if (parentId && !chain.includes(parentId)) chain.push(parentId);
  return { inReplyTo: parentId || '', references: chain.join(' ') };
}


export function computeReplyRecipients(replyTo, mode, ownAddresses = []) {
  const own = ownAddressSet(ownAddresses);
  const isOwn = a => isOwnAddress(a || '', own);
  const sender = replyTo?.replyTo?.[0]?.address || replyTo?.from?.address || '';
  const toList = (replyTo?.to || []).map(t => t.address).filter(Boolean);
  const ccList = (replyTo?.cc || []).map(c => c.address).filter(Boolean);

  const dedupe = (list) => {
    const seen = new Set();
    return list.filter(a => {
      const key = (a || '').toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  if (mode === 'reply') {
    if (isOwn(sender)) {
      const others = dedupe(toList.filter(a => !isOwn(a)));
      return { to: (others.length ? others : [sender]).join(', '), cc: '' };
    }
    return { to: sender, cc: '' };
  }

  // replyAll
  const to = dedupe([sender, ...toList].filter(a => a && !isOwn(a)));
  const cc = dedupe(ccList.filter(a => !isOwn(a)));
  if (!to.length) to.push(sender); // every participant was me; note to self
  return { to: to.join(', '), cc: cc.join(', ') };
}
