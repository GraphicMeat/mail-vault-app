import React from 'react';
import { Popover, MenuItem } from '../ui/Popover';
import { useT } from '../../i18n';

/**
 * Right-click menu for one account chip on the Notes to Self board.
 * `menu` = { id, x, y } or null. Each item hands `onApply` which accounts end
 * up off, as a test on an account id; the board applies it to its bar.
 */
export default function AccountChipMenu({ menu, onClose, onApply }) {
  const t = useT();
  if (!menu) return null;
  const items = [
    ['notes-menu-select-all-except', t('notes.selectAllExcept'), id => id === menu.id],
    ['notes-menu-deselect-all-except', t('notes.deselectAllExcept'), id => id !== menu.id],
    ['notes-menu-select-all', t('notes.selectAll'), () => false],
    ['notes-menu-deselect-all', t('notes.deselectAll'), () => true],
  ];
  return (
    <Popover open onClose={onClose} style={{ top: menu.y, left: menu.x }} role="menu" data-testid="notes-account-menu">
      {items.map(([testId, label, isOff]) => <MenuItem key={testId} data-testid={testId}
        onClick={() => { onClose(); onApply(isOff); }}>{label}</MenuItem>)}
    </Popover>
  );
}
