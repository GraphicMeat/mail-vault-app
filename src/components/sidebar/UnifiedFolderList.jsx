import React from 'react';
import { Inbox, Send, File, Trash2, Archive } from 'lucide-react';
import { useAccountStore } from '../../stores/accountStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { folderIconColor } from '../../utils/folderIconColor';
import { t as tr } from '../../i18n/index.js';

const UNIFIED_FOLDERS = () => ([
  { id: 'INBOX', name: tr('sidebar.inbox'), icon: Inbox, path: 'INBOX' },
  { id: tr('list.sent'), name: tr('list.sent'), icon: Send, specialUse: '\\Sent' },
  { id: tr('sidebar.drafts'), name: tr('sidebar.drafts'), icon: File, specialUse: '\\Drafts' },
  { id: tr('settings.storage.trash'), name: tr('settings.storage.trash'), icon: Trash2, specialUse: '\\Trash' },
  { id: tr('common.archive'), name: tr('common.archive'), icon: Archive, specialUse: '\\Archive' },
]);

/** Same role colours as an account's tree; per-account picks don't apply across accounts. */
function UnifiedIcon({ folder, ...props }) {
  const style = useSettingsStore(s => s.folderIconStyle);
  const Icon = folder.icon;
  return <Icon {...props} style={{ color: folderIconColor(folder, { style }) }} />;
}

export function UnifiedFolderList({ tagCloud = false, compact = false, onOpenMail, mailHidden = false, searchQuery = '' }) {
  // A full page over the mail view leaves no folder looking selected.
  const current = useAccountStore(s => s.unifiedFolder);
  const unifiedFolder = mailHidden ? null : current;
  const activateUnifiedFolder = useAccountStore(s => s.switchUnifiedFolder);
  const switchUnifiedFolder = folder => { onOpenMail?.(); return activateUnifiedFolder(folder); };
  const query = searchQuery.trim().toLocaleLowerCase();
  const folders = UNIFIED_FOLDERS().filter(folder => !query || folder.name.toLocaleLowerCase().includes(query));
  if (!folders.length) return <p role="status" className="px-2 py-3 text-xs text-mail-text-muted">{tr('sidebar.noFoldersFound')}</p>;

  if (compact) {
    return (
      <div className="sidebar-collapsed-folders flex-1 min-h-0 overflow-y-auto w-full py-2">
        {folders.map(folder => {
            return (
            <button key={folder.id} type="button" title={folder.name} aria-label={folder.name}
              aria-current={unifiedFolder === folder.id ? 'true' : undefined}
              onClick={() => switchUnifiedFolder(folder.id)}
              className={`flex items-center justify-center w-10 h-8 mx-auto mb-1 rounded-lg transition-colors ${unifiedFolder === folder.id ? 'bg-mail-accent-tint text-mail-accent-text' : 'text-mail-text-muted hover:bg-mail-surface-hover'}`}>
              <UnifiedIcon folder={folder} size={16} />
            </button>
          );
        })}
      </div>
    );
  }

  if (tagCloud) {
    return (
      <div>
        <div className="sidebar-folder-bubbles flex flex-wrap gap-1.5">
          {folders.map(folder => {
            const isActive = unifiedFolder === folder.id;
                return (
              <button
                key={folder.id}
                aria-current={isActive ? 'true' : undefined}
                onClick={() => switchUnifiedFolder(folder.id)}
                className={`sidebar-folder-chip inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs transition-colors border
                           ${isActive
                             ? 'bg-mail-accent-tint text-mail-accent-text border-mail-accent'
                             : 'text-mail-text border-mail-border hover:bg-mail-surface-hover'}`}
                title={folder.name}
              >
                <UnifiedIcon folder={folder} size={12} />
                <span className="truncate max-w-[140px]">{folder.name}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div>
      {folders.map(folder => {
        const isActive = unifiedFolder === folder.id;
        return (
          <div
            key={folder.id}
            role="button" tabIndex={0} aria-current={isActive ? 'true' : undefined}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchUnifiedFolder(folder.id); } }}
            className={`sidebar-folder-row flex items-center gap-2 px-2 py-1.5 mb-1 rounded-lg cursor-pointer transition-colors
                       ${isActive ? 'bg-mail-accent/10 text-mail-accent-text' : 'text-mail-text hover:bg-mail-surface-hover'}`}
            onClick={() => switchUnifiedFolder(folder.id)}
          >
            <div className="w-5 shrink-0" aria-hidden="true" />
            <UnifiedIcon folder={folder} size={16} />
            <span className="text-sm truncate">{folder.name}</span>
          </div>
        );
      })}
    </div>
  );
}
