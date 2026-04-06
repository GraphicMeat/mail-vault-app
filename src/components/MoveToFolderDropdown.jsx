import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { useSelectionStore } from '../stores/selectionStore';
import { FolderSymlink, Search, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';

/**
 * Flatten a mailbox tree into a flat list, skipping noselect folders.
 */
function flattenMailboxes(mailboxes, depth = 0) {
  const result = [];
  for (const mb of mailboxes) {
    if (!mb.noselect) {
      result.push({ ...mb, depth });
    }
    if (mb.children?.length > 0) {
      result.push(...flattenMailboxes(mb.children, depth + 1));
    }
  }
  return result;
}

export function MoveToFolderDropdown({ uids, onClose, anchorRect }) {
  const mailboxes = useAccountStore(s => s.mailboxes);
  const activeMailbox = useAccountStore(s => s.activeMailbox);
  const moveEmails = useSelectionStore(s => s.moveEmails);

  const [filter, setFilter] = useState('');
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const dropdownRef = useRef(null);

  // Auto-focus search input
  useEffect(() => {
    // Small delay so the dropdown renders first
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        onClose();
      }
    };
    // Delay listener to avoid immediate close from the click that opened the dropdown
    const t = setTimeout(() => document.addEventListener('mousedown', handleClickOutside), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  const folders = useMemo(() => {
    const flat = flattenMailboxes(mailboxes);
    // Filter out the current mailbox
    const filtered = flat.filter(mb => mb.path !== activeMailbox);
    if (!filter.trim()) return filtered;
    const q = filter.toLowerCase();
    return filtered.filter(mb => mb.name.toLowerCase().includes(q) || mb.path.toLowerCase().includes(q));
  }, [mailboxes, activeMailbox, filter]);

  const handleMove = async (targetPath) => {
    if (moving) return;
    setMoving(true);
    setError(null);
    try {
      await moveEmails(uids, targetPath);
      onClose();
    } catch (err) {
      console.error('Move failed:', err);
      setError(err.message || 'Failed to move emails');
      setMoving(false);
    }
  };

  // Position the dropdown below the anchor
  const style = {};
  if (anchorRect) {
    style.position = 'fixed';
    style.top = anchorRect.bottom + 4;
    style.left = anchorRect.left;
    style.zIndex = 9999;
  }

  return (
    <motion.div
      ref={dropdownRef}
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.15 }}
      data-testid="move-to-folder-dropdown"
      className="bg-mail-bg border border-mail-border rounded-xl shadow-2xl overflow-hidden w-64"
      style={style}
    >
      {/* Search input */}
      <div className="p-2 border-b border-mail-border">
        <div className="flex items-center gap-2 px-2 py-1.5 bg-mail-surface rounded-lg">
          <Search size={14} className="text-mail-text-muted flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            data-testid="move-folder-search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search folders..."
            className="bg-transparent text-sm text-mail-text placeholder:text-mail-text-muted outline-none w-full"
          />
        </div>
      </div>

      {/* Folder list */}
      <div className="max-h-64 overflow-y-auto py-1">
        {folders.length === 0 ? (
          <div className="px-4 py-3 text-sm text-mail-text-muted text-center">
            No folders found
          </div>
        ) : (
          folders.map((folder) => (
            <button
              key={folder.path}
              onClick={() => handleMove(folder.path)}
              disabled={moving}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-mail-text
                        hover:bg-mail-surface-hover transition-colors disabled:opacity-50 text-left"
              style={{ paddingLeft: `${12 + folder.depth * 16}px` }}
            >
              <FolderSymlink size={14} className="text-mail-text-muted flex-shrink-0" />
              <span className="truncate">{folder.name}</span>
            </button>
          ))
        )}
      </div>

      {/* Moving indicator */}
      {moving && (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-mail-border text-sm text-mail-text-muted">
          <Loader2 size={14} className="animate-spin" />
          Moving...
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="px-3 py-2 border-t border-mail-border text-xs text-mail-danger">
          {error}
        </div>
      )}
    </motion.div>
  );
}
