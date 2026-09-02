import React, { useMemo } from 'react';
import {
  ChevronDown, ChevronRight, Inbox, Send, File, Trash2, Star, AlertCircle,
  Archive, Folder,
} from 'lucide-react';
import { buildMailboxTree } from '../services/workflows/mailboxTree';
import { mailboxLabel } from '../utils/imapUtf7';
import { useT } from '../i18n/index.js';

const MAILBOX_ICONS = {
  INBOX: Inbox,
  '\\Inbox': Inbox,
  '\\Sent': Send,
  '\\Drafts': File,
  '\\Trash': Trash2,
  '\\Junk': Trash2,
  '\\Starred': Star,
  '\\Important': AlertCircle,
  '\\Archive': Archive,
  '\\All': Archive,
};

/**
 * A folder with no special use is a folder. The fallback used to be Inbox,
 * which was invisible while the list was flat and mostly special folders — and
 * turned all 59 of a nested reader's folders into inboxes the moment it wasn't.
 */
export function getMailboxIcon(mailbox) {
  return MAILBOX_ICONS[mailbox.specialUse] || MAILBOX_ICONS[mailbox.path] || Folder;
}

const INDENT = 12;

function FolderRow({ node, activeMailbox, expanded, onToggle, onSelect, compact }) {
  const t = useT();
  const Icon = getMailboxIcon(node);
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.path);
  const isActive = !node.noselect && activeMailbox === node.path;
  const label = mailboxLabel(node.name);

  return (
    <>
      <div
        data-testid="folder-row"
        data-path={node.path}
        data-depth={node.depth}
        aria-current={isActive ? 'true' : undefined}
        title={label}
        style={{ paddingLeft: 8 + node.depth * (compact ? INDENT / 2 : INDENT) }}
        className={`flex items-center gap-2 pr-2 py-1.5 mb-1 rounded-lg transition-colors
                   ${node.noselect && !hasChildren ? 'cursor-default' : 'cursor-pointer'}
                   ${isActive
                     ? 'bg-mail-accent/10 text-mail-accent-text'
                     : 'text-mail-text hover:bg-mail-surface-hover'}`}
        onClick={() => {
          if (node.noselect) { if (hasChildren) onToggle(node.path); }
          else onSelect(node.path);
        }}
      >
        {hasChildren ? (
          <button
            type="button"
            data-testid="folder-toggle"
            data-path={node.path}
            aria-label={isOpen ? t('sidebar.collapseFolder') : t('sidebar.expandFolder')}
            className="p-0.5 shrink-0"
            onClick={(e) => { e.stopPropagation(); onToggle(node.path); }}
          >
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <div className="w-5 shrink-0" />
        )}
        <Icon size={compact ? 14 : 16} className="shrink-0" />
        {!compact && <span className="text-sm flex-1 truncate">{label}</span>}
      </div>

      {hasChildren && isOpen && node.children.map(child => (
        <FolderRow
          key={child.path}
          node={child}
          activeMailbox={activeMailbox}
          expanded={expanded}
          onToggle={onToggle}
          onSelect={onSelect}
          compact={compact}
        />
      ))}
    </>
  );
}

/**
 * The account's folders, drawn the way the server files them.
 *
 * Takes the FLAT mailbox list the store holds and derives the hierarchy here —
 * see mailboxTree.js for why the stored list must stay flat.
 */
export function FolderTree({
  mailboxes, activeMailbox, expanded, onToggle, onSelect, compact = false,
}) {
  const tree = useMemo(() => buildMailboxTree(mailboxes), [mailboxes]);

  return tree.map(node => (
    <FolderRow
      key={node.path}
      node={node}
      activeMailbox={activeMailbox}
      expanded={expanded}
      onToggle={onToggle}
      onSelect={onSelect}
      compact={compact}
    />
  ));
}
