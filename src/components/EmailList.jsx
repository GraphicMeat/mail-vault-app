import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useMailStore } from '../stores/mailStore';
import { motion, AnimatePresence } from 'framer-motion';
import { format, isToday, isYesterday, isThisWeek } from 'date-fns';
import { SearchBar } from './SearchBar';
import {
  RefreshCw,
  HardDrive,
  Cloud,
  Paperclip,
  Star,
  MoreHorizontal,
  Trash2,
  CheckSquare,
  Square,
  Save,
  X,
  Layers,
  ChevronDown,
  Mail,
  MailOpen,
  Search
} from 'lucide-react';

const ROW_HEIGHT = 56;
const BUFFER_SIZE = 10;

// Simple placeholder row for emails not yet loaded
function PlaceholderRow({ style, isLoading }) {
  return (
    <div
      style={style}
      className={`flex items-center gap-3 px-4 border-b border-mail-border ${isLoading ? 'animate-pulse' : ''}`}
    >
      <div className="w-4 h-4 bg-mail-border/50 rounded" />
      <div className="w-5 h-4 bg-mail-border/30 rounded" />
      <div className="w-4 h-4 bg-mail-border/30 rounded" />
      <div className="w-48 h-4 bg-mail-border/40 rounded" />
      <div className="flex-1 h-4 bg-mail-border/30 rounded max-w-md" />
      <div className="w-16 h-4 bg-mail-border/30 rounded" />
    </div>
  );
}

function formatEmailDate(dateStr) {
  const date = new Date(dateStr);
  if (isToday(date)) return format(date, 'h:mm a');
  if (isYesterday(date)) return 'Yesterday';
  if (isThisWeek(date)) return format(date, 'EEEE');
  return format(date, 'MMM d');
}

function EmailRow({ email, isSelected, onSelect, onToggleSelection, isChecked, style }) {
  const { saveEmailLocally, removeLocalEmail, deleteEmailFromServer } = useMailStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleSave = async (e) => {
    e.stopPropagation();
    setSaving(true);
    try {
      await saveEmailLocally(email.uid);
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveLocal = async (e) => {
    e.stopPropagation();
    await removeLocalEmail(email.uid);
    setMenuOpen(false);
  };

  const handleDeleteServer = async (e) => {
    e.stopPropagation();
    if (confirm('Delete this email from the server?')) {
      await deleteEmailFromServer(email.uid);
    }
    setMenuOpen(false);
  };

  const isUnread = !email.flags?.includes('\\Seen');
  const isStarred = email.flags?.includes('\\Flagged');

  return (
    <div
      style={style}
      className={`group flex items-center gap-3 px-4 border-b border-mail-border
                 cursor-pointer transition-colors
                 ${isSelected ? 'bg-mail-accent/10' : 'hover:bg-mail-surface-hover'}
                 ${isUnread ? 'bg-mail-surface' : ''}`}
      onClick={() => onSelect(email.uid, email.source)}
    >
      <div onClick={(e) => { e.stopPropagation(); onToggleSelection(email.uid); }}>
        <input
          type="checkbox"
          checked={isChecked}
          onChange={() => {}}
          className="custom-checkbox"
        />
      </div>

      <div className="w-5 flex items-center justify-center">
        {email.isLocal ? (
          <div className="relative" title="Saved locally">
            <HardDrive size={14} className="text-mail-local" />
            {email.source === 'local-only' && (
              <div className="absolute -top-1 -right-1 w-2 h-2 bg-mail-warning rounded-full" />
            )}
          </div>
        ) : (
          <Cloud size={14} className="text-mail-server opacity-50" />
        )}
      </div>

      <button
        onClick={(e) => e.stopPropagation()}
        className={`transition-colors ${isStarred ? 'text-yellow-400' : 'text-mail-border hover:text-yellow-400'}`}
      >
        <Star size={16} fill={isStarred ? 'currentColor' : 'none'} />
      </button>

      <div className={`w-48 truncate ${isUnread ? 'font-semibold text-mail-text' : 'text-mail-text-muted'}`}>
        {email.from?.name || email.from?.address || 'Unknown'}
      </div>

      <div className="flex-1 min-w-0 flex items-center gap-2">
        <span className={`truncate ${isUnread ? 'font-semibold text-mail-text' : 'text-mail-text'}`}>
          {email.subject}
        </span>
        {email.hasAttachments && (
          <Paperclip size={14} className="text-mail-text-muted flex-shrink-0" />
        )}
      </div>

      <div className="text-sm text-mail-text-muted whitespace-nowrap">
        {formatEmailDate(email.date)}
      </div>

      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {!email.isLocal && (
          <button
            onClick={handleSave}
            disabled={saving}
            className="p-1.5 hover:bg-mail-border rounded transition-colors"
            title="Save locally"
          >
            {saving ? (
              <RefreshCw size={14} className="animate-spin text-mail-accent" />
            ) : (
              <Save size={14} className="text-mail-text-muted hover:text-mail-local" />
            )}
          </button>
        )}

        <div className="relative">
          <button
            onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
            className="p-1.5 hover:bg-mail-border rounded transition-colors"
          >
            <MoreHorizontal size={14} className="text-mail-text-muted" />
          </button>

          <AnimatePresence>
            {menuOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); }}
                />
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="absolute right-0 top-full mt-1 bg-mail-bg border border-mail-border
                            rounded-lg shadow-lg z-50 py-1 min-w-[160px]"
                  onClick={(e) => e.stopPropagation()}
                >
                  {email.isLocal && (
                    <button
                      onClick={handleRemoveLocal}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover
                                flex items-center gap-2 text-mail-text"
                    >
                      <X size={14} />
                      Remove from local
                    </button>
                  )}
                  {email.source !== 'local-only' && (
                    <button
                      onClick={handleDeleteServer}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover
                                flex items-center gap-2 text-mail-danger"
                    >
                      <Trash2 size={14} />
                      Delete from server
                    </button>
                  )}
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

export function EmailList({ layoutMode = 'three-column' }) {
  const {
    loading,
    loadingMore,
    activeMailbox,
    viewMode,
    selectedEmailId,
    selectedEmailIds,
    emails,
    localEmails,
    loadEmails,
    loadMoreEmails,
    hasMoreEmails,
    selectEmail,
    toggleEmailSelection,
    selectAllEmails,
    clearSelection,
    saveSelectedLocally,
    markSelectedAsRead,
    markSelectedAsUnread,
    deleteSelectedFromServer,
    searchActive,
    searchResults,
    clearSearch,
    totalEmails,
    savedEmailIds
  } = useMailStore();

  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [actionInProgress, setActionInProgress] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const scrollContainerRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);

  // Use search results when searching, otherwise filter based on viewMode
  const displayEmails = useMemo(() => {
    if (searchActive) return searchResults;

    if (viewMode === 'local') {
      // Show only locally saved emails
      return localEmails.map(e => ({
        ...e,
        isLocal: true,
        source: 'local'
      }));
    }

    if (viewMode === 'server') {
      // Show only server emails (with local flag)
      return emails.map(e => ({
        ...e,
        isLocal: savedEmailIds.has(e.uid),
        source: 'server'
      }));
    }

    // viewMode === 'all': Combine server emails + local-only emails
    const serverUids = new Set(emails.map(e => e.uid));
    const combinedEmails = emails.map(e => ({
      ...e,
      isLocal: savedEmailIds.has(e.uid),
      source: 'server'
    }));

    // Add local-only emails (deleted from server but saved locally)
    for (const localEmail of localEmails) {
      if (!serverUids.has(localEmail.uid)) {
        combinedEmails.push({
          ...localEmail,
          isLocal: true,
          source: 'local-only'
        });
      }
    }

    // Sort by date descending
    combinedEmails.sort((a, b) => {
      const dateA = new Date(a.date || a.internalDate || 0);
      const dateB = new Date(b.date || b.internalDate || 0);
      return dateB - dateA;
    });

    return combinedEmails;
  }, [searchActive, searchResults, emails, localEmails, savedEmailIds, viewMode]);

  // Create a map for quick lookup by index
  const emailsByIndex = useMemo(() => {
    const map = new Map();
    displayEmails.forEach((email, index) => {
      map.set(index, email);
    });
    return map;
  }, [displayEmails]);

  const hasSelection = selectedEmailIds.size > 0;
  const allSelected = displayEmails.length > 0 && selectedEmailIds.size === displayEmails.length;

  // Virtual scroll calculations - use totalEmails for stable scrollbar (only in 'all' or 'server' mode)
  const rowCount = useMemo(() => {
    if (searchActive) return displayEmails.length;
    if (viewMode === 'local') return displayEmails.length; // Local emails are all loaded
    // For server/all mode, use totalEmails for stable scrollbar
    return totalEmails || displayEmails.length;
  }, [searchActive, viewMode, displayEmails.length, totalEmails]);
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_SIZE);
  const visibleCount = Math.ceil(containerHeight / ROW_HEIGHT) + 2 * BUFFER_SIZE;
  const endIndex = Math.min(rowCount, startIndex + visibleCount);

  // Track container height
  useEffect(() => {
    if (!scrollContainerRef.current) return;
    const updateHeight = () => {
      if (scrollContainerRef.current) {
        const height = scrollContainerRef.current.clientHeight;
        if (height > 0) setContainerHeight(height);
      }
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(scrollContainerRef.current);
    return () => observer.disconnect();
  }, []);

  // Auto-load when placeholders are visible and loading has stopped
  useEffect(() => {
    // Don't auto-load in local mode or search mode
    if (searchActive || loadingMore || !hasMoreEmails || viewMode === 'local') return;

    // Check if current view has placeholders
    const visibleStart = Math.floor(scrollTop / ROW_HEIGHT);
    const visibleEnd = visibleStart + Math.ceil(containerHeight / ROW_HEIGHT);

    if (visibleEnd > displayEmails.length) {
      // Placeholders are visible, trigger loading
      const timer = setTimeout(() => {
        loadMoreEmails();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [scrollTop, containerHeight, displayEmails.length, hasMoreEmails, loadingMore, searchActive, viewMode, loadMoreEmails]);

  // Handle scroll - load more when viewing unloaded areas
  const handleScroll = useCallback((e) => {
    const { scrollTop } = e.target;
    setScrollTop(scrollTop);

    // Calculate visible range - don't load more in local mode
    if (!searchActive && hasMoreEmails && !loadingMore && viewMode !== 'local') {
      const visibleStart = Math.floor(scrollTop / ROW_HEIGHT);
      const visibleEnd = visibleStart + Math.ceil(containerHeight / ROW_HEIGHT);

      // Check if any visible rows are placeholders (not loaded yet)
      const hasPlaceholdersVisible = visibleEnd > displayEmails.length;

      // Also load if approaching end of loaded emails
      const approachingEnd = visibleEnd >= displayEmails.length - 20;

      if (hasPlaceholdersVisible || approachingEnd) {
        loadMoreEmails();
      }
    }
  }, [searchActive, hasMoreEmails, loadingMore, loadMoreEmails, containerHeight, displayEmails.length, viewMode]);

  const handleAction = async (action) => {
    setActionInProgress(true);
    setActionsMenuOpen(false);
    try {
      await action();
    } finally {
      setActionInProgress(false);
    }
  };

  // Generate visible rows - show placeholder for unloaded positions
  const visibleRows = useMemo(() => {
    const rows = [];
    for (let i = startIndex; i < endIndex; i++) {
      const email = emailsByIndex.get(i);
      rows.push({
        index: i,
        email: email || null,
        top: i * ROW_HEIGHT,
        isPlaceholder: !email
      });
    }
    return rows;
  }, [startIndex, endIndex, emailsByIndex]);

  // Total height based on total email count for stable scrollbar
  const totalHeight = rowCount * ROW_HEIGHT;

  return (
    <div className={`flex flex-col h-full min-h-0 overflow-hidden ${layoutMode === 'three-column' ? 'border-r border-mail-border' : 'border-b border-mail-border'}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-mail-border bg-mail-surface flex-shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => allSelected ? clearSelection() : selectAllEmails()}
            className="p-1 hover:bg-mail-border rounded transition-colors"
          >
            {allSelected ? (
              <CheckSquare size={18} className="text-mail-accent" />
            ) : (
              <Square size={18} className="text-mail-text-muted" />
            )}
          </button>

          {searchActive ? (
            <div className="flex items-center gap-2">
              <Search size={16} className="text-mail-accent" />
              <span className="text-lg font-semibold text-mail-text">Search Results</span>
              <span className="text-sm text-mail-text-muted">
                ({displayEmails.length} found)
              </span>
              <button
                onClick={() => {
                  clearSearch();
                  setShowSearch(false);
                }}
                className="ml-2 px-2 py-0.5 text-xs bg-mail-bg border border-mail-border rounded
                          text-mail-text-muted hover:text-mail-text hover:border-mail-accent transition-colors"
              >
                Clear
              </button>
            </div>
          ) : (
            <>
              <h2 className="text-lg font-semibold text-mail-text">
                {activeMailbox}
              </h2>
              <span className="text-sm text-mail-text-muted flex items-center gap-1">
                ({displayEmails.length.toLocaleString()}{viewMode !== 'local' && totalEmails > displayEmails.length ? ` of ${totalEmails.toLocaleString()}` : ''} emails)
                {loadingMore && (
                  <RefreshCw size={12} className="animate-spin text-mail-accent" />
                )}
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          {hasSelection && (
            <motion.div
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              className="flex items-center gap-2"
            >
              <span className="text-sm text-mail-text-muted">
                {selectedEmailIds.size} selected
              </span>

              <div className="relative">
                <button
                  onClick={() => setActionsMenuOpen(!actionsMenuOpen)}
                  disabled={actionInProgress}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-mail-surface
                            text-mail-text border border-mail-border rounded-lg text-sm font-medium
                            hover:bg-mail-surface-hover transition-colors disabled:opacity-50"
                >
                  {actionInProgress ? (
                    <RefreshCw size={14} className="animate-spin" />
                  ) : (
                    <MoreHorizontal size={14} />
                  )}
                  Actions
                  <ChevronDown size={12} />
                </button>

                <AnimatePresence>
                  {actionsMenuOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-40"
                        onClick={() => setActionsMenuOpen(false)}
                      />
                      <motion.div
                        initial={{ opacity: 0, scale: 0.95, y: -5 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: -5 }}
                        className="absolute right-0 top-full mt-1 bg-mail-bg border border-mail-border
                                  rounded-lg shadow-lg z-50 py-1 min-w-[180px]"
                      >
                        <button
                          onClick={() => handleAction(markSelectedAsRead)}
                          className="w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover
                                    flex items-center gap-2 text-mail-text"
                        >
                          <MailOpen size={14} />
                          Mark as read
                        </button>
                        <button
                          onClick={() => handleAction(markSelectedAsUnread)}
                          className="w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover
                                    flex items-center gap-2 text-mail-text"
                        >
                          <Mail size={14} />
                          Mark as unread
                        </button>
                        <div className="h-px bg-mail-border my-1" />
                        <button
                          onClick={() => {
                            if (confirm(`Delete ${selectedEmailIds.size} email(s) from server?`)) {
                              handleAction(deleteSelectedFromServer);
                            } else {
                              setActionsMenuOpen(false);
                            }
                          }}
                          className="w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover
                                    flex items-center gap-2 text-mail-danger"
                        >
                          <Trash2 size={14} />
                          Delete from server
                        </button>
                      </motion.div>
                    </>
                  )}
                </AnimatePresence>
              </div>

              <button
                onClick={saveSelectedLocally}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-mail-local/10
                          text-mail-local rounded-lg text-sm font-medium
                          hover:bg-mail-local/20 transition-colors"
              >
                <Save size={14} />
                Save All
              </button>
              <button
                onClick={clearSelection}
                className="p-1.5 hover:bg-mail-border rounded transition-colors"
              >
                <X size={14} className="text-mail-text-muted" />
              </button>
            </motion.div>
          )}

          <button
            onClick={() => setShowSearch(!showSearch)}
            className={`p-2 rounded-lg transition-colors ${
              showSearch || searchActive
                ? 'bg-mail-accent/10 text-mail-accent'
                : 'hover:bg-mail-border text-mail-text-muted'
            }`}
            title="Search emails"
          >
            <Search size={18} />
          </button>

          <button
            onClick={() => loadEmails()}
            disabled={loading}
            className="p-2 hover:bg-mail-border rounded-lg transition-colors"
            title="Refresh"
          >
            <RefreshCw
              size={18}
              className={`text-mail-text-muted ${loading ? 'animate-spin' : ''}`}
            />
          </button>
        </div>
      </div>

      {/* Search Bar */}
      <AnimatePresence>
        {(showSearch || searchActive) && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="border-b border-mail-border bg-mail-surface/50 relative z-20 flex-shrink-0"
          >
            <div className="px-4 py-3">
              <SearchBar />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Email List */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto min-h-0"
        onScroll={handleScroll}
      >
        {loading && rowCount === 0 ? (
          <div className="flex items-center justify-center h-full">
            <RefreshCw size={24} className="animate-spin text-mail-accent" />
          </div>
        ) : rowCount === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-mail-text-muted">
            {searchActive ? (
              <>
                <Search size={48} className="mb-4 opacity-50" />
                <p>No results found</p>
                <p className="text-sm mt-2">Try different keywords or adjust your filters</p>
                <button
                  onClick={() => {
                    clearSearch();
                    setShowSearch(false);
                  }}
                  className="mt-4 px-4 py-2 bg-mail-surface border border-mail-border rounded-lg
                            text-sm hover:border-mail-accent transition-colors"
                >
                  Clear search
                </button>
              </>
            ) : viewMode === 'local' ? (
              <>
                <HardDrive size={48} className="mb-4 opacity-50" />
                <p>No locally saved emails</p>
                <p className="text-sm mt-2">Save emails from "Server" view to access them offline</p>
              </>
            ) : viewMode === 'server' ? (
              <>
                <Cloud size={48} className="mb-4 opacity-50" />
                <p>No emails on server</p>
                <p className="text-sm mt-2">This folder is empty or server is unreachable</p>
              </>
            ) : (
              <>
                <Layers size={48} className="mb-4 opacity-50" />
                <p>No emails in this folder</p>
              </>
            )}
          </div>
        ) : (
          <div style={{ height: totalHeight, position: 'relative' }}>
            {visibleRows.map(({ index, email, top, isPlaceholder }) => (
              isPlaceholder ? (
                <PlaceholderRow
                  key={`placeholder-${index}`}
                  isLoading={loadingMore}
                  style={{
                    position: 'absolute',
                    top,
                    left: 0,
                    right: 0,
                    height: ROW_HEIGHT,
                    display: 'flex',
                    alignItems: 'center'
                  }}
                />
              ) : (
                <EmailRow
                  key={email.uid}
                  email={email}
                  isSelected={selectedEmailId === email.uid}
                  isChecked={selectedEmailIds.has(email.uid)}
                  onSelect={selectEmail}
                  onToggleSelection={toggleEmailSelection}
                  style={{
                    position: 'absolute',
                    top,
                    left: 0,
                    right: 0,
                    height: ROW_HEIGHT,
                    display: 'flex',
                    alignItems: 'center'
                  }}
                />
              )
            ))}

          </div>
        )}
      </div>

      {/* View Mode Legend */}
      <div className="px-4 py-2 border-t border-mail-border bg-mail-surface/50
                      flex items-center gap-4 text-xs text-mail-text-muted flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <HardDrive size={12} className="text-mail-local" />
          <span>Saved locally</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Cloud size={12} className="text-mail-server" />
          <span>Server only</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 bg-mail-warning rounded-full" />
          <span>Local only (deleted from server)</span>
        </div>
      </div>
    </div>
  );
}
