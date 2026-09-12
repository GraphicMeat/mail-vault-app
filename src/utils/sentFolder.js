// Resolve the Sent mailbox path from a mailbox tree.
// Priority: explicit account override → IMAP SPECIAL-USE `\Sent` → localized
// name fallback for servers that do not advertise SPECIAL-USE.
const SENT_NAME_RE = /^(sent|sent items|sent mail|sent messages|outbox|gesendet|gesendete elemente|gesendete objekte|envoy[eé]s|messages envoy[eé]s|enviados|elementos enviados|correo enviado|inviati|posta inviata|verzonden|verzonden items|skickat|skickade objekt|sendt|sendte elementer|l[äa]hetetyt|wyslane|wys[lł]ane|отправленные|已发送|已寄出|送信済み|보낸 편지함)$/i;

/**
 * Does this mailbox PATH name an outgoing folder?
 *
 * By name, not by the account's resolved Sent path: a unified view mixes
 * accounts whose Sent folders are `Sent`, `[Gmail]/Sent Mail` and `INBOX.Sent`,
 * and one `getSentMailboxPath()` (the active account's) cannot answer for them.
 * Only the LAST segment counts, under either delimiter — `Sentinel` is not Sent.
 */
export function isOutgoingMailboxName(path) {
  if (!path) return false;
  const leaf = String(path).split(/[/.]/).pop().trim();
  return SENT_NAME_RE.test(leaf);
}

/**
 * Does this list row show a message you SENT?
 *
 * Three sources, because no single one covers every view: the flag the
 * INBOX+Sent merge stamps on the copies it threads in, the row's own folder
 * (the unified views stamp it), and — for the paths that stamp neither — the
 * folder the list is currently showing. `state` is the mail store's state.
 */
export function isOutgoingRow(email, state) {
  if (!email) return false;
  if (email._fromSentFolder === true) return true;
  return isOutgoingMailboxName(email._mailbox || state?.activeMailbox);
}

function _pathExists(mailboxes, path) {
  for (const box of mailboxes || []) {
    if (box.path === path) return true;
    if (box.children?.length && _pathExists(box.children, path)) return true;
  }
  return false;
}

export function findSentMailboxPath(mailboxes, override = null) {
  if (!mailboxes || !mailboxes.length) return null;
  if (override && _pathExists(mailboxes, override)) return override;
  const bySpecial = (boxes) => {
    for (const box of boxes || []) {
      if (box.specialUse === '\\Sent') return box.path;
      const hit = bySpecial(box.children);
      if (hit) return hit;
    }
    return null;
  };
  const byName = (boxes) => {
    for (const box of boxes || []) {
      const name = (box.name || '').trim();
      if (SENT_NAME_RE.test(name)) return box.path;
      const hit = byName(box.children);
      if (hit) return hit;
    }
    return null;
  };
  return bySpecial(mailboxes) || byName(mailboxes);
}

/**
 * Resolve the Sent path once the real folder list is known.
 *
 * On a cold profile `mailboxes` starts as the INBOX placeholder and the server
 * list lands a beat later. Callers that read the path once at boot got null and
 * never looked again, so Sent never merged into the INBOX threads for the whole
 * session. Resolves with the path, or null once the folder list has arrived
 * without a Sent folder (or on timeout).
 *
 * `store` is the zustand mail store (getState + subscribe).
 */
export function waitForSentMailboxPath(store, timeoutMs = 20000) {
  const read = () => {
    const state = store.getState();
    const path = state.getSentMailboxPath();
    if (path) return { done: true, path };
    // Folder list already fetched and it has no Sent folder — don't wait.
    return state.mailboxesFetchedAt ? { done: true, path: null } : { done: false };
  };

  const now = read();
  if (now.done) return Promise.resolve(now.path);

  return new Promise((resolve) => {
    let unsub = null;
    const finish = (path) => {
      clearTimeout(timer);
      unsub?.();
      resolve(path);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    unsub = store.subscribe(() => {
      const next = read();
      if (next.done) finish(next.path);
    });
  });
}
