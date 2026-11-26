// A folder's glyph (desktop's mailbox icon) in its colour, for every list of folders on the phone.
import React from 'react';
import { getMailboxIcon } from '../../utils/mailboxIcon.js';
import { iconMailbox } from '../folders.js';
import { useMobileStore } from '../store.js';
import { phoneFolderColor } from './folderColor.js';

export default function FolderGlyph({ folder, accountId, size = 16 }) {
  const prefs = useMobileStore((s) => s.prefs);
  const Icon = getMailboxIcon(iconMailbox(folder));
  return (
    <span className="mv-folder__icon">
      <Icon size={size} aria-hidden="true" style={{ color: phoneFolderColor(folder, accountId, prefs) }} />
    </span>
  );
}
