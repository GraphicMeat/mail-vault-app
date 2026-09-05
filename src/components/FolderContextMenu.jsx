import React from 'react';
import { FolderPlus, Pencil, Trash2 } from 'lucide-react';
import { Popover, MenuItem } from './ui/Popover';
import { useT } from '../i18n/index.js';
import { specialOrInbox, trashPathOf, folderDelimiter } from '../services/workflows/folderOps';

/**
 * Right-click menu for one folder. `menu` = { node, x, y } or null.
 *
 * INBOX and every special-use folder can take a subfolder but cannot be
 * renamed or deleted: the app addresses them by role, and a server that lost
 * its Sent folder has nowhere to file a sent message. A folder already under
 * Trash offers the permanent delete instead of another move into it.
 */
export function FolderContextMenu({ menu, mailboxes, onClose, onNewSubfolder, onRename, onDelete }) {
  const t = useT();
  if (!menu) return null;
  const { node, x, y } = menu;
  const locked = specialOrInbox(node);
  const trash = trashPathOf(mailboxes);
  const d = folderDelimiter(mailboxes);
  const underTrash = !!trash && (node.path === trash || node.path.startsWith(trash + d));

  return (
    <Popover open onClose={onClose} style={{ top: y, left: x }} role="menu" data-testid="folder-context-menu">
      <MenuItem onClick={() => { onClose(); onNewSubfolder(node); }}>
        <FolderPlus size={14} />{t('sidebar.newSubfolder')}
      </MenuItem>
      <MenuItem disabled={locked} onClick={() => { onClose(); onRename(node); }}>
        <Pencil size={14} />{t('sidebar.renameFolder')}
      </MenuItem>
      <MenuItem tone="danger" disabled={locked} onClick={() => { onClose(); onDelete(node, { permanent: underTrash }); }}>
        <Trash2 size={14} />{underTrash ? t('sidebar.deleteFolderForever') : t('sidebar.deleteFolder')}
      </MenuItem>
    </Popover>
  );
}
