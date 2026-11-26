// A mailbox's glyph, shared by desktop's folder tree (FolderTree.jsx re-exports it) and the phone's
// folder drawer. Pure: lucide only.
import { Inbox, Send, File, Trash2, Star, AlertCircle, Archive, Folder, HardDrive } from 'lucide-react';

export const MAILBOX_ICONS = {
  INBOX: Inbox,
  '\\Inbox': Inbox,
  '\\Sent': Send,
  '\\Drafts': File,
  '\\Trash': Trash2,
  '\\Junk': Trash2,
  '\\Starred': Star,
  '\\Important': AlertCircle,
  '\\Archive': Archive,
  '\\All': Archive,
};

/**
 * A folder with no special use is a folder. The fallback used to be Inbox,
 * which was invisible while the list was flat and mostly special folders — and
 * turned all 59 of a nested reader's folders into inboxes the moment it wasn't.
 */
export function getMailboxIcon(mailbox) {
  if (mailbox.local) return HardDrive;
  return MAILBOX_ICONS[mailbox.specialUse] || MAILBOX_ICONS[mailbox.path] || Folder;
}
