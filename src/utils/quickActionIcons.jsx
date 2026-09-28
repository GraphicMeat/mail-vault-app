import React from 'react';
import {
  AlarmClock, Archive, ArchiveRestore, Code, ExternalLink, FileText, FolderInput, Forward, ImageDown,
  Mail, MailOpen, MailPlus, MailX, Moon, Reply, ReplyAll, ShieldAlert, ShieldX, Star, Sun, Tag, Trash2,
} from 'lucide-react';

// The list row's own star draws a starred message this way too.
export const FilledStar = props => <Star {...props} fill="currentColor" />;

// One glyph per action type, on every surface and in Settings.
export const QUICK_ACTION_ICONS = {
  archive: Archive, unarchive: ArchiveRestore, delete: Trash2, deleteServer: Trash2,
  deleteEverywhere: ShieldX, toggleRead: MailOpen, markRead: MailOpen, markUnread: Mail,
  star: Star, unstar: FilledStar, tag: Tag, move: FolderInput, spam: ShieldAlert,
  reply: Reply, replyAll: ReplyAll, forward: Forward, replyTemplate: FileText,
  export: ImageDown, newMessage: MailPlus, open: ExternalLink, source: Code, theme: Moon,
  snooze: AlarmClock, unsubscribe: MailX,
};

// The glyph for one action on a target in this state. A toggling star or
// archive shows the state the message is in (filled once starred, restore
// once archived); read and theme show the direction they take, like their
// labels.
export function quickActionIcon(action, { flagged = false, read = false, archived = false, dark = false } = {}) {
  if (action === 'toggleRead') return read ? Mail : MailOpen;
  if (action === 'star' && flagged) return FilledStar;
  if (action === 'archive' && archived) return ArchiveRestore;
  if (action === 'theme') return dark ? Sun : Moon;
  return QUICK_ACTION_ICONS[action];
}
