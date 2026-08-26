import { Button } from './ui/Button';
import React, { useMemo, useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useSelectionStore } from '../stores/selectionStore';
import { useMessageListStore } from '../stores/messageListStore';
import {
  MailOpen, Mail, Trash2, Archive, ArchiveRestore, X, AlertTriangle, FolderSymlink, ShieldX
} from 'lucide-react';
import { MoveToFolderDropdown } from './MoveToFolderDropdown';
import { vaultClause } from '../utils/custodyCopy';

export function SelectionActionBar() {
  const selectedEmailIds = useSelectionStore(s => s.selectedEmailIds);
  const archivedEmailIds = useMessageListStore(s => s.archivedEmailIds);
  const clearSelection = useSelectionStore(s => s.clearSelection);
  const saveSelectedLocally = useSelectionStore(s => s.saveSelectedLocally);
  const markSelectedAsRead = useSelectionStore(s => s.markSelectedAsRead);
  const markSelectedAsUnread = useSelectionStore(s => s.markSelectedAsUnread);
  const deleteSelectedFromServer = useSelectionStore(s => s.deleteSelectedFromServer);
  const purgeSelectedEverywhere = useSelectionStore(s => s.purgeSelectedEverywhere);
  const removeLocalEmail = useSelectionStore(s => s.removeLocalEmail);
  const getSelectionSummary = useSelectionStore(s => s.getSelectionSummary);

  // Which delete was requested — 'server' or 'everywhere' — so a single
  // popover can show the right confirmation copy for whichever button
  // triggered it. null means the popover is closed.
  const [deleteMode, setDeleteMode] = useState(null);
  const [showMoveDropdown, setShowMoveDropdown] = useState(false);
  const moveButtonRef = useRef(null);

  const hasSelection = selectedEmailIds.size > 0;

  // Dismiss delete confirmation when selection changes
  useEffect(() => {
    setDeleteMode(null);
  }, [selectedEmailIds]);

  const summary = useMemo(() => {
    if (!hasSelection) return { threads: 0, emails: 0 };
    return getSelectionSummary();
  }, [hasSelection, selectedEmailIds, getSelectionSummary]);

  // Parse a selection key (may be "accountId:uid" in unified mode) to extract raw uid
  const parseKey = (key) => {
    const s = String(key);
    const i = s.indexOf(':');
    if (i > 0) {
      const raw = s.slice(i + 1);
      return /^\d+$/.test(raw) ? Number(raw) : raw;
    }
    return key;
  };

  // Determine archive state of selected emails. The counts, not just the
  // booleans: the delete confirmation says how many of them the vault
  // actually holds, and it must agree with what gates Archive/Unarchive.
  const { hasArchived, hasUnarchived, archivedCount, totalCount } = useMemo(() => {
    let archived = 0;
    let unarchived = 0;
    for (const key of selectedEmailIds) {
      if (archivedEmailIds.has(parseKey(key))) archived++;
      else unarchived++;
    }
    return {
      hasArchived: archived > 0,
      hasUnarchived: unarchived > 0,
      archivedCount: archived,
      totalCount: archived + unarchived,
    };
  }, [selectedEmailIds, archivedEmailIds]);

  const handleAction = async (action) => {
    try {
      await action();
    } catch (e) {
      console.error('Selection action failed:', e);
    }
  };

  const handleDelete = () => {
    setDeleteMode('server');
  };

  const handleDeleteEverywhere = () => {
    setDeleteMode('everywhere');
  };

  const confirmDelete = () => {
    const mode = deleteMode;
    setDeleteMode(null);
    handleAction(mode === 'everywhere' ? purgeSelectedEverywhere : deleteSelectedFromServer);
  };

  const handleUnarchive = async () => {
    const uids = Array.from(selectedEmailIds)
      .map(parseKey)
      .filter(uid => archivedEmailIds.has(uid));
    clearSelection();
    for (const uid of uids) {
      try {
        await removeLocalEmail(uid);
      } catch (e) {
        console.error(`Failed to unarchive email ${uid}:`, e);
      }
    }
  };

  // Lead with the message count, not the conversation count: every button on
  // this bar acts per message, and so does the bulk modal — which reads "65
  // emails selected" off the same selection. Leading with threads made the two
  // disagree on screen ("52 selected (65 emails)") about a run that touches 65.
  const selectionLabel = summary.threads === summary.emails
    ? `${summary.emails} selected`
    : `${summary.emails} selected (${summary.threads} conversations)`;

  // What the confirmation is about to destroy, in the same two units as the
  // label above. A conversation row is one checkbox over several messages, so
  // a bare message count reads as wrong to whoever ticked two boxes — say both
  // numbers whenever they differ.
  const deleteScope = summary.threads === summary.emails
    ? `${summary.emails} email${summary.emails !== 1 ? 's' : ''}`
    : `${summary.emails} emails in ${summary.threads} conversation${summary.threads !== 1 ? 's' : ''}`;

  return (
    <AnimatePresence>
      {hasSelection && (
        <motion.div
          key="selection-bar"
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="fixed inset-x-0 bottom-4 sm:bottom-6 z-40 flex justify-center px-3 pointer-events-none"
        >
          <div className="flex items-center gap-1 px-2 py-1.5 bg-mail-surface border border-mail-strong
                         rounded-xl
                         max-w-[calc(100vw-1.5rem)] overflow-x-auto pointer-events-auto">
            {/* Selection count */}
            <span className="text-sm font-medium text-mail-text px-3 whitespace-nowrap">
              {selectionLabel}
            </span>

            <div className="w-px h-6 bg-mail-border" />

            {/* Actions */}
            <Button variant="ghost" icon size="md"
              onClick={() => handleAction(markSelectedAsRead)}
              title="Mark as read"
            >
              <MailOpen size={16} className="text-mail-text-muted" />
            </Button>
            <Button variant="ghost" icon size="md"
              onClick={() => handleAction(markSelectedAsUnread)}
              title="Mark as unread"
            >
              <Mail size={16} className="text-mail-text-muted" />
            </Button>

            <div className="w-px h-6 bg-mail-border" />

            {/* Archive — show when any unarchived emails selected */}
            {hasUnarchived && (
              <button
                onClick={() => handleAction(saveSelectedLocally)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors text-mail-local"
                onMouseEnter={e => e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--mail-local) 10%, transparent)'}
                onMouseLeave={e => e.currentTarget.style.backgroundColor = ''}
                title="Archive selected"
              >
                <Archive size={15} />
                <span className="text-xs font-medium">Archive</span>
              </button>
            )}
            {/* Unarchive — show when any archived emails selected */}
            {hasArchived && (
              <button
                onClick={handleUnarchive}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors text-mail-warning"
                onMouseEnter={e => e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--mail-warning) 10%, transparent)'}
                onMouseLeave={e => e.currentTarget.style.backgroundColor = ''}
                title="Unarchive selected"
              >
                <ArchiveRestore size={15} />
                <span className="text-xs font-medium">Unarchive</span>
              </button>
            )}
            <div className="relative">
              <button
                ref={moveButtonRef}
                onClick={() => setShowMoveDropdown(v => !v)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors text-mail-text-muted hover:bg-mail-surface-hover"
                title="Move to folder"
              >
                <FolderSymlink size={15} />
                <span className="text-xs font-medium">Move</span>
              </button>
              {showMoveDropdown && (
                <div className="absolute bottom-full mb-2 left-0">
                  <MoveToFolderDropdown
                    uids={[...selectedEmailIds]}
                    onClose={() => setShowMoveDropdown(false)}
                    anchorRect={null}
                  />
                </div>
              )}
            </div>
            <button
              onClick={handleDelete}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors text-mail-danger"
              onMouseEnter={e => e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--mail-danger) 10%, transparent)'}
              onMouseLeave={e => e.currentTarget.style.backgroundColor = ''}
              title="Delete from server"
            >
              <Trash2 size={15} />
              <span className="text-xs font-medium">Delete</span>
            </button>
            <button
              onClick={handleDeleteEverywhere}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors text-mail-danger"
              onMouseEnter={e => e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--mail-danger) 10%, transparent)'}
              onMouseLeave={e => e.currentTarget.style.backgroundColor = ''}
              title="Delete everywhere"
            >
              <ShieldX size={15} />
              <span className="text-xs font-medium">Delete everywhere</span>
            </button>

            <div className="w-px h-6 bg-mail-border" />

            {/* Clear */}
            <Button variant="ghost" icon size="md"
              onClick={clearSelection}
              title="Clear selection"
            >
              <X size={16} className="text-mail-text-muted" />
            </Button>
          </div>

          {/* Delete confirmation popover — shared by both delete buttons, copy
              branches on which one was requested */}
          <AnimatePresence>
            {deleteMode !== null && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-mail-bg border border-mail-strong
                          rounded-xl p-4 min-w-[280px] pointer-events-auto"
              >
                <div className="flex items-start gap-2 mb-3">
                  <AlertTriangle size={16} className="text-mail-danger flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-mail-text">
                    {deleteMode === 'everywhere'
                      ? `Delete ${deleteScope} from the server, your vault, and your backup drive? No copy will be left anywhere. This cannot be undone.`
                      : `Delete ${deleteScope} from the server? ${vaultClause(totalCount, archivedCount)}`}
                  </p>
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setDeleteMode(null)}
                    className="px-3 py-1.5 text-xs text-mail-text-muted hover:bg-mail-border rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmDelete}
                    className="px-3 py-1.5 text-xs font-medium bg-mail-danger text-white rounded-lg
                              hover:bg-mail-danger/90 transition-colors"
                  >
                    {deleteMode === 'everywhere' ? 'Delete everywhere' : 'Delete from server'}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
