import React from 'react';
import { FolderInput, FolderPlus, Pencil, Trash2 } from 'lucide-react';
import { Popover, MenuItem } from './ui/Popover';
import { useT } from '../i18n/index.js';
import { FolderColorPalette } from './FolderColorPalette';
import { specialOrInbox, trashPathOf, folderDelimiter } from '../services/workflows/folderOps';

/**
 * Right-click menu for one folder. `menu` = { node, x, y } or null.
 *
 * INBOX and every special-use folder can take a subfolder but cannot be
 * renamed or deleted: the app addresses them by role, and a server that lost
 * its Sent folder has nowhere to file a sent message. A folder already under
 * Trash offers the permanent delete instead of another move into it.
 *
 * A local folder (an MBOX import kept on this computer) is on no server: it
 * takes no subfolder and no rename, and its delete is the confirmed one into
 * the deleted bin. Not while an import runs (`importRunning`): the progress
 * does not name its folder, and deleting the one being filled would leave the
 * rest of the import in a folder nothing lists.
 *
 * Move folder (`onMove`, when the caller can move folders) is for a custom
 * server folder only: it retires the original, which a folder addressed by
 * role cannot be, and a local folder is on no server to move from. Not while
 * an import runs either: the retire renames the original's vault folders,
 * which the import may be filling.
 */
export function FolderContextMenu({ menu, mailboxes, onClose, onNewSubfolder, onRename, onMove, onDelete, onSetColor, importRunning = false }) {
  const t = useT();
  if (!menu) return null;
  const { node, x, y } = menu;

  // Any folder, special or local, can take a colour: it is only a label.
  const colors = onSetColor && (
    <FolderColorPalette label={t('sidebar.folderIconColor')} resetLabel={t('sidebar.folderIconColorDefault')}
      onPick={color => { onClose(); onSetColor(node, color); }}
      className="px-3 py-2 border-t border-mail-border"
      swatchClassName="w-4 h-4 rounded-full border border-mail-border"
      resetClassName="mt-1.5 text-xs text-mail-accent-text hover:underline" />
  );

  if (node.local) return (
    <Popover open onClose={onClose} style={{ top: y, left: x }} role="menu" data-testid="folder-context-menu">
      <MenuItem tone="danger" disabled={importRunning} onClick={() => { onClose(); onDelete(node, { permanent: true }); }}>
        <Trash2 size={14} />{t('sidebar.deleteLocalFolder')}
      </MenuItem>
      {colors}
    </Popover>
  );

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
      {onMove && !locked && (
        <MenuItem disabled={importRunning} onClick={() => { onClose(); onMove(node); }}>
          <FolderInput size={14} />{t('sidebar.moveFolder')}
        </MenuItem>
      )}
      <MenuItem tone="danger" disabled={locked} onClick={() => { onClose(); onDelete(node, { permanent: underTrash }); }}>
        <Trash2 size={14} />{underTrash ? t('sidebar.deleteFolderForever') : t('sidebar.deleteFolder')}
      </MenuItem>
      {colors}
    </Popover>
  );
}
