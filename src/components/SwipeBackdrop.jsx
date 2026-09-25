import React from 'react';
import { AlarmClock, Archive, FolderInput, MailOpen, Star, Trash2 } from 'lucide-react';
import { useT } from '../i18n/index.js';

/** The label of each swipe option (settingsStore's SWIPE_ACTIONS). */
export const SWIPE_ACTION_LABELS = {
  archive: 'common.archive',
  delete: 'common.delete',
  toggleRead: 'settings.behavior.swipe.toggleRead',
  star: 'settings.behavior.swipe.star',
  snooze: 'snooze.action',
  move: 'rowMenu.moveFolder',
  none: 'settings.behavior.swipe.none',
};
const ICONS = { archive: Archive, delete: Trash2, toggleRead: MailOpen, star: Star, snooze: AlarmClock, move: FolderInput };

/**
 * What a swiped row uncovers: the side's action, on its colour, on the side
 * the row is moving away from. Sits behind the row (before it in the DOM,
 * `height` = the row's), inside the row's list wrapper.
 */
export function SwipeBackdrop({ side, action, height }) {
  const t = useT();
  const Icon = ICONS[action];
  if (!Icon) return null;
  return (
    <div
      aria-hidden="true"
      data-testid="swipe-backdrop"
      data-action={action}
      className={`absolute inset-x-0 bottom-0 flex items-center gap-2 px-6 text-sm font-medium text-white ${side === 'left' ? 'justify-end' : 'justify-start'}`}
      style={{ height, background: `var(--swipe-${action})` }}
    >
      <Icon size={18} aria-hidden="true" />
      <span>{t(SWIPE_ACTION_LABELS[action])}</span>
    </div>
  );
}
