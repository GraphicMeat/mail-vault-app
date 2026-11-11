import React from 'react';
import { Star, UserCheck } from 'lucide-react';
import { Avatar } from '../ui/Avatar';

/** One person line: avatar, name over address, optional star, saved mark and count. */
export function ContactRow({ name, address, count, favorite = false, saved = false, badge = null, selected = false, onClick, style, testId }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      aria-current={selected}
      style={style}
      className={`flex items-center gap-3 px-3 text-left ${selected ? 'bg-mail-accent-tint' : ''}`}
    >
      <Avatar name={name || address} size={32} />
      <span className="flex-1 min-w-0">
        <span className="block truncate">{name || address}</span>
        <span className="block truncate text-xs text-mail-text-secondary">{address}</span>
      </span>
      {badge}
      {favorite && <Star size={14} fill="currentColor" data-testid="row-favorite" aria-hidden="true" />}
      {saved && <UserCheck size={14} data-testid="row-saved" aria-hidden="true" />}
      {count != null && <span className="text-xs text-mail-text-secondary tabular-nums">{count}</span>}
    </button>
  );
}
