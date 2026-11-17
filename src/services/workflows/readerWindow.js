// A list row opens its message in a window through the reader that shows it:
// the reader owns what the window has to match (the body scan, the theme, the
// alternate renderer), so it registers an opener for the message it shows and
// the row asks for that one. Keyed by emailScopeKey, the key the reader and
// every row already agree on.
import { useMailStore } from '../../stores/mailStore';
import { emailScopeKey, rowKey, spansMailboxes } from '../../stores/slices/unifiedHelpers';

let reader = null;
const watchers = new Set();

/** The reader shows `key` and can open it in a window. Returns the unregister. */
export function registerReaderWindow(entry) {
  reader = entry;
  watchers.forEach(watch => watch());
  return () => { if (reader === entry) reader = null; };
}

// What a row click does: the same selection, by the same key.
function selectRow(email) {
  const state = useMailStore.getState();
  return state.selectEmail(rowKey(email, spansMailboxes(state)), email.source, email._mailbox, null, email);
}

/**
 * Open `email` in its own window: select it first when the reader does not
 * show it yet, then wait (up to `timeoutMs`) for the reader to have its body.
 * Resolves whether a window was asked for; never opens another message.
 */
export async function openEmailInWindow(email, select = () => selectRow(email), timeoutMs = 5000) {
  const key = emailScopeKey(email, useMailStore.getState());
  if (!key) return false;
  if (reader?.key !== key) await select();
  if (reader?.key !== key) {
    await new Promise(resolve => {
      const watch = () => { if (reader?.key === key) done(); };
      const timer = setTimeout(done, timeoutMs);
      function done() { clearTimeout(timer); watchers.delete(watch); resolve(); }
      watchers.add(watch);
    });
  }
  if (reader?.key !== key) return false;
  await reader.open();
  return true;
}
