import React from 'react';
import { Bookmark, Star, Paperclip, Reply, Inbox } from 'lucide-react';

export const VIEW_ICON_PRESETS = ['reply', 'inbox', 'paperclip', 'tag', 'star'];

const ICONS = { reply: Reply, inbox: Inbox, paperclip: Paperclip, tag: Bookmark, star: Star };

export function ViewIcon({ icon, size = 14 }) {
  if (icon?.startsWith('emoji:')) {
    return <span className="view-emoji-icon" style={{ fontSize: size }} aria-hidden="true">{icon.slice(6)}</span>;
  }
  const Icon = ICONS[icon] || Bookmark;
  return <Icon size={size} aria-hidden="true" />;
}
