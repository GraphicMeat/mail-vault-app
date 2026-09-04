// ── What a reply quotes ─────────────────────────────────────────────────────
//
// Two surfaces open a reply to a message that may not have its body yet: a
// click on a thread message the loader has not reached, and the row menu,
// which only ever holds the header. Both resolve the body the way the
// reading pane does, so the quote is the message — and fall back to the
// header alone rather than refusing to reply.

import { resolveMessageBody } from '../services/export/bodyResolver';

/**
 * `loaded` when the caller already has the body; else the header merged
 * with what the resolver finds (the fetched copy wins every field it
 * carries, the header keeps the rest); else the header untouched.
 */
export async function replyTarget(header, loaded, store) {
  if (loaded) return loaded;
  let res = null;
  try { res = await resolveMessageBody(header, store); } catch { res = null; }
  return res?.ok ? { ...header, ...res.email } : header;
}
