import React from 'react';
import { Inbox, Send, File, Trash2, Archive } from 'lucide-react';
import { useAccountStore } from '../../stores/accountStore';
import { t as tr } from '../../i18n/index.js';

const UNIFIED_FOLDERS = () => ([
  { id: 'INBOX', name: tr('sidebar.inbox'), icon: Inbox },
  { id: tr('list.sent'), name: tr('list.sent'), icon: Send, specialUse: '\\Sent' },
  { id: tr('sidebar.drafts'), name: tr('sidebar.drafts'), icon: File, specialUse: '\\Drafts' },
  { id: tr('settings.storage.trash'), name: tr('settings.storage.trash'), icon: Trash2, specialUse: '\\Trash' },
  { id: tr('common.archive'), name: tr('common.archive'), icon: Archive, specialUse: '\\Archive' },
]);

export function UnifiedFolderList({ tagCloud = false, compact = false, onOpenMail, mailHidden = false }) {
  // A full page over the mail view leaves no folder looking selected.
  const current = useAccountStore(s => s.unifiedFolder);
  const unifiedFolder = mailHidden ? null : current;
  const activateUnifiedFolder = useAccountStore(s => s.switchUnifiedFolder);
  const switchUnifiedFolder = folder => { onOpenMail?.(); return activateUnifiedFolder(folder); };

  if (compact) {
    return (
      <div className="sidebar-collapsed-folders flex-1 min-h-0 overflow-y-auto w-full py-2">
        {UNIFIED_FOLDERS().map(folder => {
          const Icon = folder.icon;
          return (
            <button key={folder.id} type="button" title={folder.name} aria-label={folder.name}
              aria-current={unifiedFolder === folder.id ? 'true' : undefined}
              onClick={() => switchUnifiedFolder(folder.id)}
              className={`flex items-center justify-center w-10 h-8 mx-auto mb-1 rounded-lg transition-colors ${unifiedFolder === folder.id ? 'bg-mail-accent-tint text-mail-accent-text' : 'text-mail-text-muted hover:bg-mail-surface-hover'}`}>
              <Icon size={16} />
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
          {UNIFIED_FOLDERS().map(folder => {
            const isActive = unifiedFolder === folder.id;
            const Icon = folder.icon;
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
                <Icon size={12} />
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
      {UNIFIED_FOLDERS().map(folder => {
        const isActive = unifiedFolder === folder.id;
        const Icon = folder.icon;
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
            <Icon size={16} />
            <span className="text-sm truncate">{folder.name}</span>
          </div>
        );
      })}
    </div>
  );
}
