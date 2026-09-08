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

/**
 * Right-click a folder: report the node and where the pointer was, so the
 * caller can open its menu there. Without a handler the browser's own menu
 * still comes up — that is the honest default for a build with no folder ops.
 */
const contextMenuHandler = (node, onContextMenu) => onContextMenu
  ? (e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(node, { x: e.clientX, y: e.clientY }); }
  : undefined;

/** Click a folder: select it, or open it when the server says it holds nothing. */
function activate(node, onToggle, onSelect) {
  if (node.noselect) { if (node.children.length) onToggle(node.path); }
  else onSelect(node.path);
}

function FolderRow({ node, activeMailbox, expanded, onToggle, onSelect, compact, counts, onContextMenu }) {
  const Icon = getMailboxIcon(node);
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.path);
  const isActive = !node.noselect && activeMailbox === node.path;
  const label = mailboxLabel(node.name);
  // The open folder's own list is the live count; STATUS is for the rest.
  const unseen = counts?.[node.path]?.unseen || 0;
  const showCount = unseen > 0 && !isActive;

  return (
    <>
      <div
        role="button" tabIndex={node.noselect && !hasChildren ? undefined : 0}
        onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); activate(node, onToggle, onSelect); } }}
        data-testid="folder-row"
        data-path={node.path}
        data-depth={node.depth}
        aria-current={isActive ? 'true' : undefined}
        title={label}
        style={{ paddingLeft: compact ? (hasChildren ? 2 : 20) : 8 + node.depth * INDENT }}
        className={`relative flex items-center gap-2 pr-2 py-1.5 mb-1 rounded-lg transition-colors
                   ${node.noselect && !hasChildren ? 'cursor-default' : 'cursor-pointer'}
                   ${isActive
                     ? 'bg-mail-accent/10 text-mail-accent-text'
                     : 'text-mail-text hover:bg-mail-surface-hover'}`}
        onClick={() => activate(node, onToggle, onSelect)}
        onContextMenu={contextMenuHandler(node, onContextMenu)}
      >
        {hasChildren ? (
          <FolderToggle node={node} isOpen={isOpen} onToggle={onToggle} />
        ) : (
          !compact && <div className="w-5 shrink-0" />
        )}
        <Icon size={compact ? 14 : 16} className="shrink-0" />
        {!compact && <span className="text-sm flex-1 truncate">{label}</span>}
        {showCount && (
          <span
            data-testid="folder-unseen"
            className={compact
              // `right-0`, not `-right-0.5`: the compact strip already sits
              // 1 px into its own overflow, and a badge hanging 2 px further
              // clipped against the edge.
              ? 'absolute -top-0.5 right-0 min-w-[14px] h-3.5 px-0.5 rounded-full bg-mail-danger-fill text-[11px] font-bold text-white leading-none flex items-center justify-center'
              : 'ml-auto text-xs tabular-nums text-mail-text-muted'}
          >
            {unseen > 99 ? '99+' : unseen}
          </span>
        )}
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
          counts={counts}
          onContextMenu={onContextMenu}
        />
      ))}
    </>
  );
}

// Search keeps the original nodes and server paths. Its temporary result list
// never changes which branches the user has expanded in the normal tree.
const searchText = value => String(value).normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();

function FolderSearchResults({ tree, query, activeMailbox, onSelect, counts, onContextMenu }) {
  const t = useT();
  const matches = useMemo(() => {
    const words = searchText(query.trim()).split(/\s+/);
    const results = [];
    const visit = (nodes, trail = []) => {
      for (const node of nodes) {
        const label = mailboxLabel(node.name);
        const fullPath = [...trail, label].join(' › ');
        const searchable = searchText(`${fullPath} ${mailboxLabel(node.path)}`);
        if (!node.noselect && words.every(word => searchable.includes(word))) {
          results.push({ node, label, trail: trail.join(' › '), fullPath });
        }
        visit(node.children, [...trail, label]);
      }
    };
    visit(tree);
    return results;
  }, [tree, query]);

  if (!matches.length) return <p role="status" className="px-2 py-3 text-xs text-mail-text-muted">{t('sidebar.noFoldersFound')}</p>;

  return matches.map(({ node, label, trail, fullPath }) => {
    const Icon = getMailboxIcon(node);
    const active = activeMailbox === node.path;
    const unseen = counts?.[node.path]?.unseen || 0;
    return <button type="button" key={node.path} data-testid="folder-row" data-path={node.path}
      aria-label={fullPath} aria-current={active ? 'true' : undefined} title={fullPath}
      onClick={() => onSelect(node.path)}
      onContextMenu={contextMenuHandler(node, onContextMenu)}
      className={`w-full min-w-0 flex items-center gap-2 px-2 py-2 mb-1 rounded-lg text-left ${active
        ? 'bg-mail-accent-tint text-mail-accent-text'
        : 'text-mail-text hover:bg-mail-surface-hover'}`}>
      <Icon size={16} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{label}</span>
        {trail && <span className={`block truncate text-[11px] ${active ? 'text-mail-accent-text' : 'text-mail-text-muted'}`}>{trail}</span>}
      </span>
      {unseen > 0 && !active && <span data-testid="folder-unseen" className="shrink-0 text-xs tabular-nums text-mail-text-muted">{unseen > 99 ? '99+' : unseen}</span>}
    </button>;
  });
}

/**
 * The account's folders, drawn the way the server files them.
 *
 * Takes the FLAT mailbox list the store holds and derives the hierarchy here —
 * see mailboxTree.js for why the stored list must stay flat.
 */
export function FolderTree({
  mailboxes, activeMailbox, expanded, onToggle, onSelect, compact = false, counts, onContextMenu, searchQuery = '',
}) {
  const tree = useMemo(() => buildMailboxTree(mailboxes), [mailboxes]);

  if (searchQuery.trim()) return <FolderSearchResults tree={tree} query={searchQuery}
    activeMailbox={activeMailbox} onSelect={onSelect} counts={counts} onContextMenu={onContextMenu} />;

  return tree.map(node => (
    <FolderRow
      key={node.path}
      node={node}
      activeMailbox={activeMailbox}
      expanded={expanded}
      onToggle={onToggle}
      onSelect={onSelect}
      compact={compact}
      counts={counts}
      onContextMenu={onContextMenu}
    />
  ));
}

function FolderChip({ node, trail, activeMailbox, expanded, onToggle, onSelect, counts, onContextMenu }) {
  const Icon = getMailboxIcon(node);
  const hasChildren = node.children.length > 0;
  const isActive = !node.noselect && activeMailbox === node.path;
  const label = mailboxLabel(node.name);
  // Same rule as the row: the open folder's own list is the live count.
  const unseen = counts?.[node.path]?.unseen || 0;
  const showCount = unseen > 0 && !isActive;

  return (
    <div
      role="button" tabIndex={node.noselect && !hasChildren ? undefined : 0}
      onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); activate(node, onToggle, onSelect); } }}
      data-testid="folder-row"
      data-path={node.path}
      data-depth={node.depth}
      aria-current={isActive ? 'true' : undefined}
      title={[...trail, label].join(' › ')}
      className={`max-w-full min-w-0 inline-flex items-center gap-1.5 pl-2.5 py-1.5 rounded-full text-xs transition-colors border
                 ${hasChildren ? 'pr-1' : 'pr-2.5'}
                 ${node.noselect && !hasChildren ? 'cursor-default' : 'cursor-pointer'}
                 ${isActive
                   ? 'bg-mail-accent-tint text-mail-accent-text border-mail-accent'
                   : 'text-mail-text border-mail-border hover:bg-mail-surface-hover'}`}
      onClick={() => activate(node, onToggle, onSelect)}
      onContextMenu={contextMenuHandler(node, onContextMenu)}
    >
      <Icon size={12} className="shrink-0" />
      <span className="truncate max-w-[180px]">{label}</span>
      {showCount && (
        <span data-testid="folder-unseen" className="ml-1 text-[11px] tabular-nums opacity-80">
          {unseen > 99 ? '99+' : unseen}
        </span>
      )}
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
export function FolderBubbles({ mailboxes, activeMailbox, expanded, onToggle, onSelect, counts, onContextMenu, searchQuery = '' }) {
  const tree = useMemo(() => buildMailboxTree(mailboxes), [mailboxes]);

  if (searchQuery.trim()) return <FolderSearchResults tree={tree} query={searchQuery}
    activeMailbox={activeMailbox} onSelect={onSelect} counts={counts} onContextMenu={onContextMenu} />;

  return (
    <div className="flex flex-col gap-1.5">
      <BubbleLevel
        nodes={tree}
        trail={[]}
        activeMailbox={activeMailbox}
        expanded={expanded}
        onToggle={onToggle}
        onSelect={onSelect}
        counts={counts}
        onContextMenu={onContextMenu}
      />
    </div>
  );
}
