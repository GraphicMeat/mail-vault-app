// An mbox import re-filed after a Graph->IMAP switch gets a uid in the import
// range (`mailvault_core::message_store::is_import_uid`, uid >= 0xC000_0000):
// a local-only copy no server holds, so a server action on it has nothing to
// act on (Outlook answers BAD "message set is invalid").
export const IMPORT_UID_BASE = 0xC000_0000;

export function isImportUid(uid) {
  const n = Number(uid);
  return Number.isInteger(n) && n >= IMPORT_UID_BASE;
}
