import React from 'react';
import { Star, UserCheck } from 'lucide-react';
import { useT } from '../../i18n';
import { Avatar } from '../ui/Avatar';

/** One person line: avatar, name over address, optional star, saved mark and count. */
export function ContactRow({ name, address, count, favorite = false, saved = false, badge = null, selected = false, onClick, style, testId }) {
  const t = useT();
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
      {favorite && <span data-testid="row-favorite" title={t('contacts.vip')} aria-label={t('contacts.vip')}><Star size={14} fill="currentColor" /></span>}
      {saved && <span data-testid="row-saved" title={t('contacts.saved')} aria-label={t('contacts.saved')}><UserCheck size={14} /></span>}
      {count != null && <span className="text-xs text-mail-text-secondary tabular-nums">{count}</span>}
    </button>
  );
}
