// One account's folders in the drawer, depth first as the engine lists them, each row a mailbox
// glyph in desktop's colour, the translated name and the unread count. A folder that cannot be
// opened (`noselect`) is a heading for its children. Holding a row (or the context menu where
// there is one) asks to colour that folder (`onHold(folder)`); the tap that ends a hold opens
// nothing. The account's Drafts folder (`draftsPath`) counts the phone's local drafts (`drafts`)
// in place of its unread count and carries `data-mv-drafts`: it is the one Drafts.
import React, { useRef } from 'react';
import { useT } from '../i18n.js';
import { folderLabel } from '../folders.js';
import { useLongPress } from '../gestures/useLongPress.js';
import { haptic } from '../haptics.js';
import FolderGlyph from './FolderGlyph.jsx';

function FolderRow({ folder, accountId, active, isDrafts = false, drafts = 0, onSelect, onHold }) {
  const t = useT();
  const ref = useRef(null);
  const held = useRef(false);
  const hold = () => {
    held.current = true;
    setTimeout(() => { held.current = false; }, 700);
    haptic.impact('medium');
    onHold(folder);
  };
  useLongPress(ref, { onFire: hold, enabled: Boolean(onHold) });
  const style = { paddingInlineStart: `calc(16px + ${Math.min(folder.depth || 0, 6) * 16}px)` };
  return (
    <li
      ref={ref}
      onContextMenu={onHold ? (e) => { e.preventDefault(); onHold(folder); } : undefined}
      onClickCapture={(e) => {
        if (!held.current) return;
        held.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <button
        type="button"
        className={active ? 'mv-folder mv-folder--active' : 'mv-folder'}
        style={style}
        aria-current={active ? 'true' : undefined}
        data-mv-drafts={isDrafts ? true : undefined}
        onClick={() => onSelect(folder.path)}
      >
        <FolderGlyph folder={folder} accountId={accountId} />
        <span className="mv-folder__name" dir="auto">{folderLabel(folder)}</span>
        {isDrafts && drafts > 0 ? (
          <span className="mv-folder__count" aria-label={t('mobile.drafts.count', { count: drafts })}>{drafts}</span>
        ) : folder.unseen > 0 && (
          <span className="mv-folder__count" aria-label={t('mobile.unreadCount', { count: folder.unseen })}>{folder.unseen}</span>
        )}
      </button>
    </li>
  );
}

export default function FolderList({ folders, accountId, activeFolder = null, draftsPath = null, drafts = 0, onSelect, onHold }) {
  return (
    <ul className="mv-folders">
      {folders.map((f) => {
        if (f.noselect) {
          const style = { paddingInlineStart: `calc(16px + ${Math.min(f.depth || 0, 6) * 16}px)` };
          return <li key={f.path} className="mv-folder mv-folder--heading" style={style} dir="auto">{folderLabel(f)}</li>;
        }
        return (
          <FolderRow key={f.path} folder={f} accountId={accountId} active={f.path === activeFolder} isDrafts={f.path === draftsPath} drafts={drafts} onSelect={onSelect} onHold={onHold} />
        );
      })}
    </ul>
  );
}
