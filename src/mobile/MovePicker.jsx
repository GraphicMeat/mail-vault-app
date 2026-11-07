// The folder picker for a move: a bottom sheet over the viewer listing the account's folders,
// depth first as the engine lists them, without the folder the message is in. A folder that
// cannot hold mail (`noselect`) shows as a heading for its children.
import React from 'react';
import Sheet from './Sheet.jsx';
import { useT } from './i18n.js';
import { folderLabel } from './folders.js';

export default function MovePicker({ folders, current, onPick, onClose }) {
  const t = useT();
  const shown = (folders || []).filter((f) => f.path !== current);
  const any = shown.some((f) => !f.noselect);
  return (
    <Sheet kind="sheet" label={t('mobile.actions.moveTitle')} onClose={onClose}>
      <div className="mv-sheet__grip" aria-hidden="true" />
      <h2 className="mv-sheet__title">{t('mobile.actions.moveTitle')}</h2>
      {!any ? (
        <p className="mv-drawer__empty">{t('mobile.actions.noFolders')}</p>
      ) : (
        <ul className="mv-folders">
          {shown.map((f) => {
            const style = { paddingInlineStart: `calc(16px + ${Math.min(f.depth || 0, 6) * 16}px)` };
            if (f.noselect) {
              return <li key={f.path} className="mv-folder mv-folder--heading" style={style} dir="auto">{folderLabel(f)}</li>;
            }
            return (
              <li key={f.path}>
                <button type="button" className="mv-folder" style={style} onClick={() => onPick(f.path)}>
                  <span className="mv-folder__name" dir="auto">{folderLabel(f)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}
