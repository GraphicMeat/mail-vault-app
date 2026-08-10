import React, { useState } from 'react';
import { MailOpen, Mail, Archive, ArchiveRestore, FolderSymlink, Trash2, ShieldX } from 'lucide-react';
import { useMailStore } from '../stores/mailStore';
import { _selKey } from '../stores/slices/unifiedHelpers';
import { MoveToFolderDropdown } from './MoveToFolderDropdown';

/**
 * Contents of a row's 3-dot menu.
 *
 * One component, four consumers (EmailRow, CompactEmailRow, ThreadRow,
 * CompactThreadRow). They used to carry their own copies and had drifted to
 * two items while the selection bar offered six — the same drift that has
 * bitten email indicators before. Gating here matches SelectionActionBar
 * exactly.
 */
export function RowActionMenuItems({ email, actions, onRequestDelete, onClose }) {
  const { saveEmailLocally, removeLocalEmail, deleteEmailFromServer } = actions;
  const setSelection = useMailStore(s => s.setSelection);
  const markSelectedAsRead = useMailStore(s => s.markSelectedAsRead);
  const markSelectedAsUnread = useMailStore(s => s.markSelectedAsUnread);
  const purgeSelectedEverywhere = useMailStore(s => s.purgeSelectedEverywhere);
  const isUnified = useMailStore(s => s.activeMailbox === 'UNIFIED');
  const [showMove, setShowMove] = useState(false);

  const isRead = email.flags?.includes('\\Seen');
  const isLocalOnly = email.source === 'local-only';

  // The bulk workflows (mark read/unread, purge everywhere) read
  // selectedEmailIds and expect the same key shape selectAllEmails/toggle
  // selection use: "accountId:uid" in unified inbox (cross-account uid
  // collisions), plain uid otherwise. A raw email.uid here would silently
  // miss this row once the store is in unified mode.
  const selectionKey = isUnified ? _selKey(email) : email.uid;

  // The flag and purge workflows act on `selectedEmailIds`. Scoping the
  // selection to this one row reuses them without a parallel single-uid path.
  const runOnThisRow = async (fn) => {
    setSelection([selectionKey]);
    try { await fn(); } finally { onClose(); }
  };

  const item = 'w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover flex items-center gap-2';

  return (
    <>
      {isRead ? (
        <button className={`${item} text-mail-text`} onClick={(e) => { e.stopPropagation(); runOnThisRow(markSelectedAsUnread); }}>
          <Mail size={14} />
          Mark as unread
        </button>
      ) : (
        <button className={`${item} text-mail-text`} onClick={(e) => { e.stopPropagation(); runOnThisRow(markSelectedAsRead); }}>
          <MailOpen size={14} />
          Mark as read
        </button>
      )}

      {!email.isArchived && (
        <button
          className={`${item} text-mail-text`}
          onClick={async (e) => { e.stopPropagation(); await saveEmailLocally(email.uid); onClose(); }}
        >
          <Archive size={14} />
          Archive
        </button>
      )}
      {email.isArchived && (
        <button
          className={`${item} text-mail-text`}
          onClick={async (e) => { e.stopPropagation(); await removeLocalEmail(email.uid); onClose(); }}
        >
          <ArchiveRestore size={14} />
          Unarchive
        </button>
      )}

      <div className="relative">
        <button className={`${item} text-mail-text`} onClick={(e) => { e.stopPropagation(); setShowMove(v => !v); }}>
          <FolderSymlink size={14} />
          Move to folder
        </button>
        {showMove && (
          <div className="absolute left-full top-0 ml-1">
            <MoveToFolderDropdown uids={[selectionKey]} onClose={() => { setShowMove(false); onClose(); }} anchorRect={null} />
          </div>
        )}
      </div>

      {!isLocalOnly && (
        <button
          className={`${item} text-mail-danger`}
          onClick={(e) => {
            e.stopPropagation();
            onRequestDelete(
              () => deleteEmailFromServer(email.uid),
              'This email will be permanently deleted from the server. This cannot be undone.'
            );
          }}
        >
          <Trash2 size={14} />
          Delete from server
        </button>
      )}

      {(email.isArchived || !isLocalOnly) && (
        <button
          className={`${item} text-mail-danger`}
          onClick={(e) => {
            e.stopPropagation();
            onRequestDelete(
              () => { setSelection([selectionKey]); return purgeSelectedEverywhere(); },
              'This email will be removed from the server, this computer, and your external backup. No copy will be left anywhere. This cannot be undone.'
            );
          }}
        >
          <ShieldX size={14} />
          Delete everywhere
        </button>
      )}
    </>
  );
}
