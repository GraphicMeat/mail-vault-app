// Resolve the Sent mailbox path from a mailbox tree.
// Priority: explicit account override → IMAP SPECIAL-USE `\Sent` → localized
// name fallback for servers that do not advertise SPECIAL-USE.
const SENT_NAME_RE = /^(sent|sent items|sent mail|sent messages|outbox|gesendet|gesendete elemente|gesendete objekte|envoy[eé]s|messages envoy[eé]s|enviados|elementos enviados|correo enviado|inviati|posta inviata|verzonden|verzonden items|skickat|skickade objekt|sendt|sendte elementer|l[äa]hetetyt|wyslane|wys[lł]ane|отправленные|已发送|已寄出|送信済み|보낸 편지함)$/i;

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
