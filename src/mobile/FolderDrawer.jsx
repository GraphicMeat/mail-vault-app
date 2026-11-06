// The folder drawer: the active account's folders, depth first as the engine lists them, with
// unread counts. Special-use folders get their translated name; a folder that cannot be opened
// (`noselect`) is shown as a heading for its children. Names come from `folders.js`.
import React from 'react';
import Sheet from './Sheet.jsx';
import { useT } from './i18n.js';
import { folderLabel } from './folders.js';

export default function FolderDrawer({ account, folders, activeFolder, onSelect, onClose }) {
  const t = useT();
  return (
    <Sheet kind="drawer" label={t('mobile.drawer.title')} onClose={onClose}>
      <div className="mv-drawer__head">
        <h2 className="mv-drawer__title">{t('mobile.drawer.title')}</h2>
        {account && <p className="mv-drawer__account" dir="auto">{account.email}</p>}
      </div>
      {folders.length === 0 ? (
        <p className="mv-drawer__empty">{t('mobile.drawer.empty')}</p>
      ) : (
        <ul className="mv-folders">
          {folders.map((f) => {
            const style = { paddingInlineStart: `calc(16px + ${Math.min(f.depth || 0, 6) * 16}px)` };
            if (f.noselect) {
              return (
                <li key={f.path} className="mv-folder mv-folder--heading" style={style} dir="auto">{folderLabel(f)}</li>
              );
            }
            const active = f.path === activeFolder;
            return (
              <li key={f.path}>
                <button
                  type="button"
                  className={active ? 'mv-folder mv-folder--active' : 'mv-folder'}
                  style={style}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => onSelect(f.path)}
                >
                  <span className="mv-folder__name" dir="auto">{folderLabel(f)}</span>
                  {f.unseen > 0 && (
                    <span className="mv-folder__count" aria-label={t('mobile.unreadCount', { count: f.unseen })}>{f.unseen}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}
