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

/** The chevron that opens a folder with folders inside — same in both styles. */
function FolderToggle({ node, isOpen, onToggle, size = 14 }) {
  const t = useT();
  return (
    <button
      type="button"
      data-testid="folder-toggle"
      data-path={node.path}
      aria-label={isOpen ? t('sidebar.collapseFolder') : t('sidebar.expandFolder')}
      className="p-0.5 shrink-0"
      onClick={(e) => { e.stopPropagation(); onToggle(node.path); }}
    >
      {isOpen ? <ChevronDown size={size} /> : <ChevronRight size={size} />}
    </button>
  );
}

/** Click a folder: select it, or open it when the server says it holds nothing. */
function activate(node, onToggle, onSelect) {
  if (node.noselect) { if (node.children.length) onToggle(node.path); }
  else onSelect(node.path);
}

function FolderRow({ node, activeMailbox, expanded, onToggle, onSelect, compact }) {
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
        onClick={() => activate(node, onToggle, onSelect)}
      >
        {hasChildren ? (
          <FolderToggle node={node} isOpen={isOpen} onToggle={onToggle} />
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

function FolderChip({ node, trail, activeMailbox, expanded, onToggle, onSelect }) {
  const Icon = getMailboxIcon(node);
  const hasChildren = node.children.length > 0;
  const isActive = !node.noselect && activeMailbox === node.path;
  const label = mailboxLabel(node.name);

  return (
    <div
      data-testid="folder-row"
      data-path={node.path}
      data-depth={node.depth}
      aria-current={isActive ? 'true' : undefined}
      title={[...trail, label].join(' › ')}
      className={`inline-flex items-center gap-1 pl-2.5 py-1 rounded-full text-xs transition-colors border
                 ${hasChildren ? 'pr-1' : 'pr-2.5'}
                 ${node.noselect && !hasChildren ? 'cursor-default' : 'cursor-pointer'}
                 ${isActive
                   ? 'bg-mail-accent-fill text-white border-mail-accent'
                   : 'text-mail-text border-mail-border hover:bg-mail-surface-hover'}`}
      onClick={() => activate(node, onToggle, onSelect)}
    >
      <Icon size={12} />
      <span className="truncate max-w-[180px]">{label}</span>
      {hasChildren && (
        <FolderToggle node={node} isOpen={expanded.has(node.path)} onToggle={onToggle} size={12} />
      )}
    </div>
  );
}

function BubbleLevel({ nodes, trail, ...rest }) {
  // A wrapped row per run of siblings. An open parent ends its run so its
  // children can hang beneath it; the siblings after it start a fresh row,
  // which is what keeps two open parents from pooling their children.
  const runs = [];
  let chips = [];
  for (const n of nodes) {
    chips.push(n);
    if (n.children.length && rest.expanded.has(n.path)) { runs.push({ chips, open: n }); chips = []; }
  }
  if (chips.length) runs.push({ chips, open: null });

  return runs.map(({ chips, open }, i) => (
    <React.Fragment key={open ? open.path : `run-${i}`}>
      <div className="flex flex-wrap gap-1.5">
        {chips.map(n => <FolderChip key={n.path} node={n} trail={trail} {...rest} />)}
      </div>
      {open && (
        <div className="ml-2 pl-2 border-l border-mail-border flex flex-col gap-1.5">
          <BubbleLevel nodes={open.children} trail={[...trail, mailboxLabel(open.name)]} {...rest} />
        </div>
      )}
    </React.Fragment>
  ));
}

/**
 * The same tree as chips: the tag-cloud sidebar style.
 *
 * A chip carries only its own name — the breadcrumb chips this replaced
 * ("Telefonie › NFon AG") read as unrelated folders — and a parent gets the
 * tree's chevron, with its children indented beneath it while open.
 */
export function FolderBubbles({ mailboxes, activeMailbox, expanded, onToggle, onSelect }) {
  const tree = useMemo(() => buildMailboxTree(mailboxes), [mailboxes]);

  return (
    <div className="flex flex-col gap-1.5">
      <BubbleLevel
        nodes={tree}
        trail={[]}
        activeMailbox={activeMailbox}
        expanded={expanded}
        onToggle={onToggle}
        onSelect={onSelect}
      />
    </div>
  );
}
