import React, { useEffect, useState } from 'react';
import { Cloud, HardDrive, Layers, Plus, Search } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import { useUiStore } from '../../stores/uiStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { Button } from '../ui/Button';
import { FolderBubbles, FolderTree } from '../FolderTree';
import { UnifiedFolderList } from './UnifiedFolderList';

const SOURCES = [
  { id: 'all', icon: Layers, label: 'sidebar.allMail' },
  { id: 'server', icon: Cloud, label: 'sidebar.viewServer' },
  { id: 'local', icon: HardDrive, label: 'sidebar.viewVault' },
];

/**
 * Folder selection: mail source, folder search and the folder list of the
 * account on screen (or All Inboxes). The sidebar mounts it in its own Folders
 * section (`heading`), or right under the selected account row, where New
 * folder sits on that row instead.
 */
export function FolderSelector({
  heading = false, unifiedInbox = false, mailHidden = false, onOpenMail, onNewFolder,
  accountId, mailboxes, activeMailbox, expanded, onToggle, onSelect, counts, onContextMenu, flash, onFlashEnd,
}) {
  const t = useT();
  const viewMode = useUiStore(s => s.viewMode);
  const setViewMode = useUiStore(s => s.setViewMode);
  const tagCloud = useSettingsStore(s => s.sidebarStyle) === 'tagcloud';
  const [query, setQuery] = useState('');
  useEffect(() => { setQuery(''); }, [accountId, unifiedInbox]);
  const Folders = tagCloud ? FolderBubbles : FolderTree;

  const body = <>
    <div className="sidebar-source-filter" role="group" aria-label={t('sidebar.mailSource')}>
      {SOURCES.map(mode => (
        <button key={mode.id} type="button" onClick={() => { onOpenMail?.(); setViewMode(mode.id); }} aria-pressed={viewMode === mode.id}
          title={t(`workspace.sourceHint.${mode.id}`)}>
          <mode.icon size={13} aria-hidden="true" /><span>{t(mode.label)}</span>
        </button>
      ))}
    </div>
    <label className="sidebar-find-field">
      <Search size={14} aria-hidden="true" />
      <input type="search" value={query} onChange={event => setQuery(event.target.value)}
        aria-label={t('sidebar.findFolder')} placeholder={t('sidebar.findFolder')} />
    </label>
    <div className="sidebar-folder-list" data-testid="sidebar-folder-list">
      {unifiedInbox ? <UnifiedFolderList tagCloud={tagCloud} onOpenMail={onOpenMail} mailHidden={mailHidden} searchQuery={query} /> : (
        <Folders accountId={accountId} mailboxes={mailboxes} activeMailbox={activeMailbox} expanded={expanded}
          onToggle={onToggle} onSelect={onSelect} counts={counts}
          onContextMenu={onContextMenu} searchQuery={query}
          flash={flash} onFlashEnd={onFlashEnd} />
      )}
    </div>
  </>;

  if (!heading) return <div className="sidebar-folder-selector sidebar-folder-selector-nested" data-testid="folder-selector">{body}</div>;
  return <section className="sidebar-folder-section" aria-label={t('sidebar.folders')} data-testid="folder-selector">
    <div className="sidebar-section-heading">
      <h2>{t('sidebar.folders')}</h2>
      {!unifiedInbox && <NewFolderButton onClick={onNewFolder} />}
    </div>
    {body}
  </section>;
}

export function NewFolderButton({ onClick }) {
  const t = useT();
  return <Button variant="ghost" icon size="xs" data-testid="new-folder-btn" aria-label={t('sidebar.newFolder')}
    title={t('sidebar.newFolder')} onClick={onClick}><Plus size={14} /></Button>;
}
