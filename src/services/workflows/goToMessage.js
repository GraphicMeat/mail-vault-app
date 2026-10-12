// ── Go to a message's own mailbox ───────────────────────────────────────────
//
// A search hit or an All inboxes row is a message seen out of place. This takes
// the reader to where it lives: the hit's account and folder on screen, the
// message open, and when threads are on, its whole conversation with the
// message itself expanded and scrolled to.

import { buildThreads } from '../../utils/emailParser';
import { mergesSentIntoThreads } from '../../utils/sentFolder';
import { useSettingsStore } from '../../stores/settingsStore';
import { emailKey, resolveEmailLocation, sameMessage } from '../../stores/slices/unifiedHelpers';

// How long the freshly opened folder gets to show the message's thread before
// the message opens on its own. An old message beyond the loaded window never
// appears in the list, and must not keep the reader waiting.
const THREAD_WAIT_MS = 1500;

function threadOf(target, state) {
  if (useSettingsStore.getState().threadMode === 'flat') return null;
  const pool = mergesSentIntoThreads(state) && state.getChatEmails ? state.getChatEmails() : state.sortedEmails;
  if (!pool?.some(row => sameMessage(row, target, state))) return null;
  for (const thread of buildThreads(pool).values()) {
    const member = thread.emails.find(row => sameMessage(row, target, state));
    if (member) return { thread, focusKey: emailKey(member) };
  }
  return null;
}

// Resolves with `read()` as soon as it is truthy, or null after `ms`.
function waitFor(store, read, ms) {
  const now = read();
  if (now) return Promise.resolve(now);
  return new Promise(resolve => {
    let timer = null;
    const unsubscribe = store.subscribe(() => {
      const value = read();
      if (value) { clearTimeout(timer); unsubscribe(); resolve(value); }
    });
    timer = setTimeout(() => { unsubscribe(); resolve(null); }, ms);
  });
}

/**
 * Opens `email` in its own mailbox. Resolves true once the message is opened
 * (or its thread, anchored on it), false when it cannot be placed or another
 * navigation took the view while the folder loaded.
 */
export async function goToMessage(email, { threadWaitMs = THREAD_WAIT_MS } = {}) {
  const { useMailStore } = await import('../../stores/mailStore');
  const { useSearchStore } = await import('../../stores/searchStore');
  const { useViewStore } = await import('../../stores/viewStore');

  const state = useMailStore.getState();
  const location = resolveEmailLocation(email, state);
  if (!location || !state.accounts?.some(account => account.id === location.accountId)) return false;
  const target = { ...location, uid: email.uid };

  // A saved view or a search stays up across a folder switch and re-runs in
  // the new scope; leaving it first is what puts the folder on screen.
  if (useViewStore.getState().activeViewId) useViewStore.getState().closeView();
  useSearchStore.getState().clearSearch();

  // Reactivating the folder already on screen would wipe the list the message is in.
  const onScreen = state.activeAccountId === location.accountId && state.activeMailbox === location.mailbox
    && !state.unifiedInbox && !state.mailboxScope;
  if (!onScreen) await state.activateAccount(location.accountId, location.mailbox);

  const stillHere = () => {
    const live = useMailStore.getState();
    return live.activeAccountId === location.accountId && live.activeMailbox === location.mailbox
      && !live.unifiedInbox && !live.mailboxScope;
  };
  if (!stillHere()) return false;

  const found = await waitFor(useMailStore, () => threadOf(target, useMailStore.getState()), threadWaitMs);
  if (!stillHere()) return false;
  const live = useMailStore.getState();
  if (found && found.thread.emails.length > 1) {
    live.selectThread(found.thread, found.focusKey);
  } else {
    await live.selectEmail(email.uid, email.source, location.mailbox);
  }
  return true;
}
