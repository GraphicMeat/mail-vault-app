// ── What a reply quotes ─────────────────────────────────────────────────────
//
// Two surfaces open a reply to a message that may not have its body yet: a
// click on a thread message the loader has not reached, and the row menu,
// which only ever holds the header. Both resolve the body the way the
// reading pane does, so the quote is the message — and fall back to the
// header alone rather than refusing to reply.

import { resolveMessageBody } from '../services/export/bodyResolver';
import { withoutSnippet } from './withoutSnippet';

/**
 * A snippet-only header or `loaded` counts as nothing loaded (withoutSnippet).
 * `loaded` when the caller already has the body; else the header merged
 * with what the resolver finds (the fetched copy wins every field it
 * carries, the header keeps the rest); else the header untouched.
 */
export async function replyTarget(header, loaded, store, selectedHtml = '') {
  header = withoutSnippet(header);
  if (loaded?._bodyLoading) loaded = null;
  if (loaded) return selectedHtml ? { ...loaded, _selectedQuoteHtml: selectedHtml } : loaded;
  let res = null;
  try { res = await resolveMessageBody(header, store); } catch { res = null; }
  const target = res?.ok ? { ...header, ...res.email } : header;
  return selectedHtml ? { ...target, _selectedQuoteHtml: selectedHtml } : target;
}

/**
 * App's compose state with a snippet stand-in (`_bodyLoading`) replaced by the
 * real body, resolved like any reply target; anything else as it came. Every
 * compose entry point reaches App's setComposeState, so this is the one place
 * a keyboard forward, a fallback reply or another view's hand-off is covered.
 */
export async function composeStateWithBody(state, store) {
  if (!state?.replyTo?._bodyLoading) return state;
  return { ...state, replyTo: await replyTarget(state.replyTo, null, store) };
}

/**
 * App's setComposeState for a compose to open: at once when `state` holds no
 * snippet stand-in, else once composeStateWithBody has the real body. A
 * promise then (settles after `openCompose` ran), else what `openCompose`
 * returned.
 */
export function openComposeResolved(state, openCompose, store) {
  if (!state?.replyTo?._bodyLoading) return openCompose(state);
  return composeStateWithBody(state, store).then(openCompose);
}
