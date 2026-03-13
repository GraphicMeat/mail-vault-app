import React, { memo, useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useSearchStore } from '../stores/searchStore';
import { useSettingsStore, getAccountColor } from '../stores/settingsStore';
import { buildThreads, groupBySender, getAvatarColor, getInitials } from '../utils/emailParser';
import { motion, AnimatePresence } from 'framer-motion';
import { formatEmailDate } from '../utils/dateFormat';
import { SearchBar } from './SearchBar';
import {
  RefreshCw,
  HardDrive,
  Cloud,
  Paperclip,
  MoreHorizontal,
  Trash2,
  CheckSquare,
  Square,
  Archive,
  X,
  Layers,
  Search,
  MessageSquare,
  Users
} from 'lucide-react';
import { BulkOperationsModal } from './BulkOperationsModal';
import { BulkOperationProgress } from './BulkOperationProgress';
import { bulkOperationManager } from '../services/BulkOperationManager';

const ROW_HEIGHT_DEFAULT = 56;
const ROW_HEIGHT_COMPACT = 52;
const BUFFER_SIZE = 10;


const EmailRow = React.memo(function EmailRow({ email, isSelected, onSelect, onToggleSelection, isChecked, style }) {
  const saveEmailLocally = useMailStore(s => s.saveEmailLocally);
  const removeLocalEmail = useMailStore(s => s.removeLocalEmail);
  const deleteEmailFromServer = useMailStore(s => s.deleteEmailFromServer);
  const unifiedInbox = useMailStore(s => s.unifiedInbox);
  const accountColors = useSettingsStore(s => s.accountColors);
  const [menuOpen, setMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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

  const handleDeleteServer = (e) => {
    e.stopPropagation();
    if (confirmingDelete) {
      deleteEmailFromServer(email.uid);
      setMenuOpen(false);
      setConfirmingDelete(false);
    } else {
      setConfirmingDelete(true);
    }
  };

  const isUnread = !email.flags?.includes('\\Seen');

  return (
    <div
      data-testid="email-row"
      style={style}
      className={`virtual-row group relative flex items-center gap-3 px-4 border-b border-mail-border
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

      <div className="w-5 flex items-center justify-center flex-shrink-0">
        {email.source === 'local-only' ? (
          <div title="Local only (deleted from server)">
            <HardDrive size={14} className="text-mail-warning" />
          </div>
        ) : email.isArchived ? (
          <div title="Archived">
            <HardDrive size={14} className="text-mail-local" />
          </div>
        ) : (
          <Cloud size={14} style={{ color: 'rgba(59, 130, 246, 0.5)' }} />
        )}
      </div>

      <div className={`w-48 min-w-[80px] truncate flex-shrink flex items-center gap-1.5 ${isUnread ? 'font-semibold text-mail-text' : 'text-mail-text-muted'}`}>
        {unifiedInbox && email._accountEmail && (
          <span
            data-testid="account-dot"
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: getAccountColor(accountColors, { id: email._accountId, email: email._accountEmail }) }}
            title={email._accountEmail}
          />
        )}
        <span className="truncate">{email.from?.name || email.from?.address || 'Unknown'}</span>
      </div>

      <div className="flex-1 min-w-0 flex items-center gap-2">
        <span className={`truncate ${isUnread ? 'font-semibold text-mail-text' : 'text-mail-text'}`}>
          {email.subject}
        </span>
        {email.hasAttachments && (
          <Paperclip size={14} className="text-mail-text-muted flex-shrink-0" />
        )}
        <span className="ml-auto text-xs text-mail-text-muted whitespace-nowrap flex-shrink-0">
          {formatEmailDate(email.date)}
        </span>
      </div>

      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-mail-surface-hover rounded-md px-1">
        {!email.isArchived && (
          <button
            onClick={handleSave}
            disabled={saving}
            className="p-1.5 hover:bg-mail-border rounded transition-colors"
            title="Archive"
          >
            {saving ? (
              <RefreshCw size={14} className="animate-spin text-mail-accent" />
            ) : (
              <Archive size={14} className="text-mail-text-muted hover:text-mail-local" />
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
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setConfirmingDelete(false); }}
                />
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="absolute right-0 top-full mt-1 bg-mail-bg border border-mail-border
                            rounded-lg shadow-lg z-50 py-1 min-w-[160px]"
                  onClick={(e) => e.stopPropagation()}
                >
                  {email.isArchived && (
                    <button
                      onClick={handleRemoveLocal}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover
                                flex items-center gap-2 text-mail-text"
                    >
                      <Archive size={14} />
                      Unarchive
                    </button>
                  )}
                  {email.source !== 'local-only' && (
                    <button
                      onClick={handleDeleteServer}
                      className={`w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover
                                flex items-center gap-2 ${confirmingDelete ? 'text-white bg-red-600 hover:bg-red-700' : 'text-mail-danger'}`}
                    >
                      <Trash2 size={14} />
                      {confirmingDelete ? 'Confirm delete?' : 'Delete from server'}
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
});

const CompactEmailRow = React.memo(function CompactEmailRow({ email, isSelected, onSelect, onToggleSelection, isChecked, style }) {
  const saveEmailLocally = useMailStore(s => s.saveEmailLocally);
  const removeLocalEmail = useMailStore(s => s.removeLocalEmail);
  const deleteEmailFromServer = useMailStore(s => s.deleteEmailFromServer);
  const unifiedInbox = useMailStore(s => s.unifiedInbox);
  const accountColors = useSettingsStore(s => s.accountColors);
  const [menuOpen, setMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const handleSave = async (e) => {
    e.stopPropagation();
    setSaving(true);
    try { await saveEmailLocally(email.uid); } finally { setSaving(false); }
  };

  const handleRemoveLocal = async (e) => {
    e.stopPropagation();
    await removeLocalEmail(email.uid);
    setMenuOpen(false);
  };

  const handleDeleteServer = (e) => {
    e.stopPropagation();
    if (confirmingDelete) {
      deleteEmailFromServer(email.uid);
      setMenuOpen(false);
      setConfirmingDelete(false);
    } else {
      setConfirmingDelete(true);
    }
  };

  const isUnread = !email.flags?.includes('\\Seen');

  return (
    <div
      data-testid="email-row"
      style={style}
      className={`virtual-row group relative flex items-center gap-2 px-4 border-b border-mail-border
                 cursor-pointer transition-colors
                 ${isSelected ? 'bg-mail-accent/10' : 'hover:bg-mail-surface-hover'}
                 ${isUnread ? 'bg-mail-surface' : ''}`}
      onClick={() => onSelect(email.uid, email.source)}
    >
      <div onClick={(e) => { e.stopPropagation(); onToggleSelection(email.uid); }}>
        <input type="checkbox" checked={isChecked} onChange={() => {}} className="custom-checkbox" />
      </div>

      {/* Source icon */}
      <div className="w-4 flex items-center justify-center flex-shrink-0">
        {email.source === 'local-only' ? (
          <HardDrive size={13} className="text-mail-warning" title="Local only" />
        ) : email.isArchived ? (
          <HardDrive size={13} className="text-mail-local" title="Archived" />
        ) : (
          <Cloud size={13} style={{ color: 'rgba(59, 130, 246, 0.5)' }} />
        )}
      </div>

      {/* Two-line content */}
      <div className="flex-1 min-w-0 py-1.5">
        {/* Line 1: Sender ... Date */}
        <div className="flex items-center gap-2">
          {unifiedInbox && email._accountEmail && (
            <span
              data-testid="account-dot"
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: getAccountColor(accountColors, { id: email._accountId, email: email._accountEmail }) }}
              title={email._accountEmail}
            />
          )}
          <span className={`truncate text-xs ${isUnread ? 'font-semibold text-mail-text' : 'text-mail-text-muted'}`}>
            {email.from?.name || email.from?.address || 'Unknown'}
          </span>
          <span className="text-xs text-mail-text-muted whitespace-nowrap ml-auto">
            {formatEmailDate(email.date)}
          </span>
        </div>
        {/* Line 2: Subject + attachment */}
        <div className="flex items-center gap-1.5">
          <span className={`truncate text-sm leading-snug ${isUnread ? 'font-semibold text-mail-text' : 'text-mail-text'}`}>
            {email.subject}
          </span>
          {email.hasAttachments && (
            <Paperclip size={12} className="text-mail-text-muted flex-shrink-0" />
          )}
        </div>
      </div>

      {/* Hover actions */}
      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-mail-surface-hover rounded-md px-1">
        {!email.isArchived && (
          <button onClick={handleSave} disabled={saving}
            className="p-1 hover:bg-mail-border rounded transition-colors" title="Archive">
            {saving ? <RefreshCw size={13} className="animate-spin text-mail-accent" />
              : <Archive size={13} className="text-mail-text-muted hover:text-mail-local" />}
          </button>
        )}
        <div className="relative">
          <button onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
            className="p-1 hover:bg-mail-border rounded transition-colors">
            <MoreHorizontal size={13} className="text-mail-text-muted" />
          </button>
          <AnimatePresence>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-40"
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setConfirmingDelete(false); }} />
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}
                  className="absolute right-0 top-full mt-1 bg-mail-bg border border-mail-border rounded-lg shadow-lg z-50 py-1 min-w-[160px]"
                  onClick={(e) => e.stopPropagation()}>
                  {email.isArchived && (
                    <button onClick={handleRemoveLocal}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover flex items-center gap-2 text-mail-text">
                      <Archive size={14} /> Unarchive
                    </button>
                  )}
                  {email.source !== 'local-only' && (
                    <button onClick={handleDeleteServer}
                      className={`w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover flex items-center gap-2 ${confirmingDelete ? 'text-white bg-red-600 hover:bg-red-700' : 'text-mail-danger'}`}>
                      <Trash2 size={14} /> {confirmingDelete ? 'Confirm delete?' : 'Delete from server'}
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
});

// Thread row for default layout — shows collapsed thread with participant names and count
const ThreadRow = React.memo(function ThreadRow({ thread, isSelected, onSelectThread, onToggleSelection, anyChecked, style }) {
  const saveEmailsLocally = useMailStore(s => s.saveEmailsLocally);
  const deleteEmailFromServer = useMailStore(s => s.deleteEmailFromServer);
  const [menuOpen, setMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmingDeleteThread, setConfirmingDeleteThread] = useState(false);

  if (!thread?.lastEmail) return null;
  const latestEmail = thread.lastEmail;
  const hasUnread = thread.unreadCount > 0;
  const allArchived = thread.emails.every(e => e.isArchived);

  // Build participant display: show sender names (not the user)
  const participantNames = useMemo(() => {
    const seen = new Set();
    const names = [];
    for (const email of thread.emails) {
      const name = email.from?.name || email.from?.address || 'Unknown';
      const addr = email.from?.address?.toLowerCase() || '';
      if (!seen.has(addr)) {
        seen.add(addr);
        names.push(name);
      }
    }
    return names.length <= 2 ? names.join(', ') : `${names[0]}, ${names[1]} +${names.length - 2}`;
  }, [thread.emails]);

  const handleArchiveThread = async (e) => {
    e.stopPropagation();
    setSaving(true);
    try {
      const uids = thread.emails.filter(em => !em.isArchived).map(em => em.uid);
      if (uids.length > 0) await saveEmailsLocally(uids);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteThread = async (e) => {
    e.stopPropagation();
    if (!confirmingDeleteThread) {
      setConfirmingDeleteThread(true);
      return;
    }
    // Delete all server emails in the thread, skip per-delete refresh
    const serverEmails = thread.emails.filter(em => em.source !== 'local-only');
    for (const email of serverEmails) {
      await deleteEmailFromServer(email.uid, { skipRefresh: true });
    }
    // Single refresh after all deletions
    if (serverEmails.length > 0) useMailStore.getState().loadEmails();
    setMenuOpen(false);
    setConfirmingDeleteThread(false);
  };

  return (
    <div
      data-testid="email-row"
      style={style}
      className={`virtual-row group relative flex items-center gap-3 px-4 border-b border-mail-border
                 cursor-pointer transition-colors
                 ${isSelected ? 'bg-mail-accent/10' : 'hover:bg-mail-surface-hover'}
                 ${hasUnread ? 'bg-mail-surface' : ''}`}
      onClick={() => onSelectThread(thread)}
    >
      <div onClick={(e) => { e.stopPropagation(); thread.emails.forEach(em => onToggleSelection(em.uid)); }}>
        <input type="checkbox" checked={anyChecked} onChange={() => {}} className="custom-checkbox" />
      </div>

      <div className="w-5 flex items-center justify-center flex-shrink-0">
        {latestEmail.source === 'local-only' ? (
          <HardDrive size={14} className="text-mail-warning" title="Local only" />
        ) : latestEmail.isArchived ? (
          <HardDrive size={14} className="text-mail-local" title="Archived" />
        ) : (
          <Cloud size={14} style={{ color: 'rgba(59, 130, 246, 0.5)' }} />
        )}
      </div>

      <div className={`w-48 min-w-[80px] truncate flex-shrink ${hasUnread ? 'font-semibold text-mail-text' : 'text-mail-text-muted'}`}>
        {participantNames}
      </div>

      <div className="flex-1 min-w-0 flex items-center gap-2">
        <span className={`truncate ${hasUnread ? 'font-semibold text-mail-text' : 'text-mail-text'}`}>
          {thread.subject}
        </span>
        {thread.messageCount > 1 && (
          <span className="flex-shrink-0 min-w-[20px] h-5 px-1.5 bg-mail-text-muted/15 rounded-full
                        text-mail-text-muted text-xs font-medium flex items-center justify-center">
            {thread.messageCount}
          </span>
        )}
        {latestEmail.hasAttachments && (
          <Paperclip size={14} className="text-mail-text-muted flex-shrink-0" />
        )}
        <span className="ml-auto text-xs text-mail-text-muted whitespace-nowrap flex-shrink-0">
          {formatEmailDate(latestEmail.date)}
        </span>
      </div>

      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-mail-surface-hover rounded-md px-1">
        {!allArchived && (
          <button
            onClick={handleArchiveThread}
            disabled={saving}
            className="p-1.5 hover:bg-mail-border rounded transition-colors"
            title="Archive thread"
          >
            {saving ? (
              <RefreshCw size={14} className="animate-spin text-mail-accent" />
            ) : (
              <Archive size={14} className="text-mail-text-muted hover:text-mail-local" />
            )}
          </button>
        )}

        <div className="relative">
          <button
            onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); setConfirmingDeleteThread(false); }}
            className="p-1.5 hover:bg-mail-border rounded transition-colors"
          >
            <MoreHorizontal size={14} className="text-mail-text-muted" />
          </button>

          <AnimatePresence>
            {menuOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setConfirmingDeleteThread(false); }}
                />
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="absolute right-0 top-full mt-1 bg-mail-bg border border-mail-border
                            rounded-lg shadow-lg z-50 py-1 min-w-[200px]"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    onClick={handleDeleteThread}
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover
                              flex items-center gap-2 ${confirmingDeleteThread ? 'text-white bg-red-600 hover:bg-red-700' : 'text-mail-danger'}`}
                  >
                    <Trash2 size={14} />
                    {confirmingDeleteThread ? `Delete ${thread.messageCount} emails?` : 'Delete thread from server'}
                  </button>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
});

// Compact thread row for compact layout
const CompactThreadRow = React.memo(function CompactThreadRow({ thread, isSelected, onSelectThread, onToggleSelection, anyChecked, style }) {
  const saveEmailsLocally = useMailStore(s => s.saveEmailsLocally);
  const deleteEmailFromServer = useMailStore(s => s.deleteEmailFromServer);
  const [menuOpen, setMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmingDeleteThread, setConfirmingDeleteThread] = useState(false);

  if (!thread?.lastEmail) return null;
  const latestEmail = thread.lastEmail;
  const hasUnread = thread.unreadCount > 0;
  const allArchived = thread.emails.every(e => e.isArchived);

  const participantNames = useMemo(() => {
    const seen = new Set();
    const names = [];
    for (const email of thread.emails) {
      const name = email.from?.name || email.from?.address || 'Unknown';
      const addr = email.from?.address?.toLowerCase() || '';
      if (!seen.has(addr)) {
        seen.add(addr);
        names.push(name);
      }
    }
    return names.length <= 2 ? names.join(', ') : `${names[0]}, ${names[1]} +${names.length - 2}`;
  }, [thread.emails]);

  const handleArchiveThread = async (e) => {
    e.stopPropagation();
    setSaving(true);
    try {
      const uids = thread.emails.filter(em => !em.isArchived).map(em => em.uid);
      if (uids.length > 0) await saveEmailsLocally(uids);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteThread = async (e) => {
    e.stopPropagation();
    if (!confirmingDeleteThread) {
      setConfirmingDeleteThread(true);
      return;
    }
    const serverEmails = thread.emails.filter(em => em.source !== 'local-only');
    for (const email of serverEmails) {
      await deleteEmailFromServer(email.uid, { skipRefresh: true });
    }
    if (serverEmails.length > 0) useMailStore.getState().loadEmails();
    setMenuOpen(false);
    setConfirmingDeleteThread(false);
  };

  return (
    <div
      data-testid="email-row"
      style={style}
      className={`virtual-row group relative flex items-center gap-2 px-4 border-b border-mail-border
                 cursor-pointer transition-colors
                 ${isSelected ? 'bg-mail-accent/10' : 'hover:bg-mail-surface-hover'}
                 ${hasUnread ? 'bg-mail-surface' : ''}`}
      onClick={() => onSelectThread(thread)}
    >
      <div onClick={(e) => { e.stopPropagation(); thread.emails.forEach(em => onToggleSelection(em.uid)); }}>
        <input type="checkbox" checked={anyChecked} onChange={() => {}} className="custom-checkbox" />
      </div>

      <div className="w-4 flex items-center justify-center flex-shrink-0">
        {latestEmail.source === 'local-only' ? (
          <HardDrive size={13} className="text-mail-warning" title="Local only" />
        ) : latestEmail.isArchived ? (
          <HardDrive size={13} className="text-mail-local" title="Archived" />
        ) : (
          <Cloud size={13} style={{ color: 'rgba(59, 130, 246, 0.5)' }} />
        )}
      </div>

      <div className="flex-1 min-w-0 py-1.5">
        <div className="flex items-center gap-2">
          <span className={`truncate text-xs ${hasUnread ? 'font-semibold text-mail-text' : 'text-mail-text-muted'}`}>
            {participantNames}
          </span>
          {thread.messageCount > 1 && (
            <span className="flex-shrink-0 min-w-[16px] h-4 px-1 bg-mail-text-muted/15 rounded-full
                          text-mail-text-muted text-[10px] font-medium flex items-center justify-center">
              {thread.messageCount}
            </span>
          )}
          <span className="text-xs text-mail-text-muted whitespace-nowrap ml-auto">
            {formatEmailDate(latestEmail.date)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`truncate text-sm leading-snug ${hasUnread ? 'font-semibold text-mail-text' : 'text-mail-text'}`}>
            {thread.subject}
          </span>
          {latestEmail.hasAttachments && (
            <Paperclip size={12} className="text-mail-text-muted flex-shrink-0" />
          )}
        </div>
      </div>

      {/* Hover actions */}
      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-mail-surface-hover rounded-md px-1">
        {!allArchived && (
          <button onClick={handleArchiveThread} disabled={saving}
            className="p-1 hover:bg-mail-border rounded transition-colors" title="Archive thread">
            {saving ? <RefreshCw size={13} className="animate-spin text-mail-accent" />
              : <Archive size={13} className="text-mail-text-muted hover:text-mail-local" />}
          </button>
        )}
        <div className="relative">
          <button onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); setConfirmingDeleteThread(false); }}
            className="p-1 hover:bg-mail-border rounded transition-colors">
            <MoreHorizontal size={13} className="text-mail-text-muted" />
          </button>
          <AnimatePresence>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-40"
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setConfirmingDeleteThread(false); }} />
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}
                  className="absolute right-0 top-full mt-1 bg-mail-bg border border-mail-border rounded-lg shadow-lg z-50 py-1 min-w-[200px]"
                  onClick={(e) => e.stopPropagation()}>
                  <button onClick={handleDeleteThread}
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-mail-surface-hover flex items-center gap-2 ${confirmingDeleteThread ? 'text-white bg-red-600 hover:bg-red-700' : 'text-mail-danger'}`}>
                    <Trash2 size={14} /> {confirmingDeleteThread ? `Delete ${thread.messageCount} emails?` : 'Delete thread from server'}
                  </button>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
});

function getDateRange(emails) {
  if (!emails || emails.length === 0) return null;
  let oldest = null;
  let newest = null;
  for (const e of emails) {
    const d = e.date ? new Date(e.date) : null;
    if (!d || isNaN(d)) continue;
    if (!oldest || d < oldest) oldest = d;
    if (!newest || d > newest) newest = d;
  }
  if (!oldest || !newest) return null;
  const fmt = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  if (oldest.toDateString() === newest.toDateString()) return fmt(newest);
  return `${fmt(oldest)} – ${fmt(newest)}`;
}

function EmailListComponent() {
  // Individual selectors — component only re-renders when these specific fields change
  const loading = useMailStore(s => s.loading);
  const loadingMore = useMailStore(s => s.loadingMore);
  const activeMailbox = useMailStore(s => s.activeMailbox);
  const activeAccountId = useMailStore(s => s.activeAccountId);
  const viewMode = useMailStore(s => s.viewMode);
  const totalEmails = useMailStore(s => s.totalEmails);
  const selectedEmailId = useMailStore(s => s.selectedEmailId);
  const selectedEmailIds = useMailStore(s => s.selectedEmailIds);
  const sortedEmails = useMailStore(s => s.sortedEmails);
  const sentEmails = useMailStore(s => s.sentEmails);
  const hasMoreEmails = useMailStore(s => s.hasMoreEmails);
  const searchActive = useSearchStore(s => s.searchActive);
  const searchResults = useSearchStore(s => s.searchResults);
  const flagSeq = useMailStore(s => s._flagSeq);
  // Actions (stable references — never cause re-renders)
  const loadEmails = useMailStore(s => s.loadEmails);
  const loadMoreEmails = useMailStore(s => s.loadMoreEmails);
  const selectEmail = useMailStore(s => s.selectEmail);
  const selectThread = useMailStore(s => s.selectThread);
  const toggleEmailSelection = useMailStore(s => s.toggleEmailSelection);
  const selectAllEmails = useMailStore(s => s.selectAllEmails);
  const clearSelection = useMailStore(s => s.clearSelection);
  const clearSearch = useSearchStore(s => s.clearSearch);
  const getChatEmails = useMailStore(s => s.getChatEmails);

  const emailListStyle = useSettingsStore(s => s.emailListStyle);
  const emailListGrouping = useSettingsStore(s => s.emailListGrouping);
  const setEmailListGrouping = useSettingsStore(s => s.setEmailListGrouping);
  const isCompact = emailListStyle === 'compact';
  const ROW_HEIGHT = isCompact ? ROW_HEIGHT_COMPACT : ROW_HEIGHT_DEFAULT;
  const RowComponent = isCompact ? CompactEmailRow : EmailRow;

  const [showSearch, setShowSearch] = useState(false);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkOpProgress, setBulkOpProgress] = useState(null);

  // Sender-grouped accordion state
  const [senderGroups, setSenderGroups] = useState(null);
  const senderGroupCacheRef = useRef({ fingerprint: null, groups: null });
  const [expandedSender, setExpandedSender] = useState(null);
  const [expandedTopics, setExpandedTopics] = useState(new Set());
  const [expandedEmail, setExpandedEmail] = useState(null);
  const scrollContainerRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);

  // Pull-to-refresh
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const pullStartY = useRef(null);
  const isPulling = useRef(false);

  // sortedEmails is already combined (server + local-only), flagged (isLocal, isArchived, source),
  // and sorted by updateSortedEmails(). Use directly to avoid redundant 17k-object spread + sort.
  const displayEmails = useMemo(
    () => searchActive ? searchResults : sortedEmails,
    [searchActive, searchResults, sortedEmails]
  );

  const dateRange = useMemo(() => getDateRange(displayEmails), [displayEmails]);

  // Deferred threading — buildThreads(17k+) is too slow for synchronous render.
  // Show flat list instantly, then compute threads in background and re-render.
  const threadCache = useRef({ fingerprint: '', threads: new Map() });
  const [deferredThreads, setDeferredThreads] = useState(null); // null = not computed yet

  // Fingerprint for thread computation
  const mergedEmails = useMemo(
    () => searchActive ? null : getChatEmails(),
    [searchActive, getChatEmails, sortedEmails, sentEmails]
  );
  const threadFingerprint = useMemo(
    () => mergedEmails ? `${viewMode}-${mergedEmails.length}-${mergedEmails[0]?.uid || 0}-${mergedEmails[mergedEmails.length - 1]?.uid || 0}-${flagSeq}` : '',
    [mergedEmails, flagSeq, viewMode]
  );

  // Compute threads in a deferred callback to avoid blocking render
  useEffect(() => {
    if (!mergedEmails || searchActive) {
      setDeferredThreads(null);
      return;
    }

    // Use cached threads if fingerprint matches
    if (threadCache.current.fingerprint === threadFingerprint) {
      setDeferredThreads(threadCache.current.threads);
      return;
    }

    // Schedule thread computation after paint — keeps UI responsive
    // Note: requestIdleCallback is NOT available in WebKit/Safari (Tauri macOS webview)
    const timer = setTimeout(() => {
      const threads = buildThreads(mergedEmails);
      threadCache.current = { fingerprint: threadFingerprint, threads };
      setDeferredThreads(threads);
    }, 0);

    return () => clearTimeout(timer);
  }, [mergedEmails, threadFingerprint, searchActive, viewMode]);

  // Deferred sender grouping computation
  useEffect(() => {
    if (emailListGrouping !== 'sender') {
      setSenderGroups(null);
      return;
    }

    const emails = displayEmails;
    const fp = `sender-${emails.length}-${emails[0]?.uid}-${emails[emails.length - 1]?.uid}-${flagSeq}`;

    if (senderGroupCacheRef.current.fingerprint === fp) {
      setSenderGroups(senderGroupCacheRef.current.groups);
      return;
    }

    const timer = setTimeout(() => {
      const groups = groupBySender(emails);
      senderGroupCacheRef.current = { fingerprint: fp, groups };
      setSenderGroups(groups);
    }, 0);

    return () => clearTimeout(timer);
  }, [displayEmails, emailListGrouping, flagSeq]);

  // Build display list: use threads if available, flat list as fallback
  const threadedDisplay = useMemo(() => {
    if (searchActive) {
      return displayEmails.map(email => ({ type: 'email', email }));
    }

    // If threads haven't been computed yet, show flat list immediately
    const threads = deferredThreads;
    if (!threads || threads.size === 0) {
      return displayEmails.map(email => ({ type: 'email', email }));
    }

    // Only show threads that contain at least one email from the current display set
    const displayUids = new Set(displayEmails.map(e => e.uid));
    const filtered = Array.from(threads.values())
      .filter(thread => thread.emails.some(e => displayUids.has(e.uid)));

    // Sort threads by latest date descending
    const sorted = filtered.sort((a, b) => b.lastDate - a.lastDate);

    return sorted.map(thread => {
      if (thread.messageCount === 1) {
        return { type: 'email', email: thread.emails[0] };
      }
      return { type: 'thread', thread };
    });
  }, [displayEmails, searchActive, deferredThreads]);

  const hasSelection = selectedEmailIds.size > 0;
  const allSelected = displayEmails.length > 0 && selectedEmailIds.size === displayEmails.length;

  // Hand-rolled virtual scroll — proven to feel smoother than @tanstack/react-virtual
  const rowCount = threadedDisplay.length;

  // Diagnostic: trace loading spinner condition
  useEffect(() => {
    if (loading && rowCount === 0) {
      const state = useMailStore.getState();
      console.log('[EmailList] SPINNER VISIBLE — loading=%s, rowCount=%d, emails=%d, sortedEmails=%d, viewMode=%s, activeMailbox=%s',
        loading, rowCount, state.emails.length, state.sortedEmails.length, state.viewMode, state.activeMailbox);
    }
  }, [loading, rowCount]);
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_SIZE);
  const visibleCount = Math.ceil(containerHeight / ROW_HEIGHT) + 2 * BUFFER_SIZE;
  const endIndex = Math.min(rowCount, startIndex + visibleCount);

  // Reset scroll position when switching mailbox, account, or view mode
  useEffect(() => {
    setScrollTop(0);
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [activeMailbox, activeAccountId, viewMode]);

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
    let rafId;
    const observer = new ResizeObserver((entries) => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const height = entries[0]?.contentRect?.height;
        if (height) setContainerHeight(height);
      });
    });
    observer.observe(scrollContainerRef.current);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, []);

  // Auto-load more emails when approaching the end of the loaded list
  useEffect(() => {
    if (searchActive || loadingMore || !hasMoreEmails || viewMode === 'local') return;

    const visibleEnd = Math.floor(scrollTop / ROW_HEIGHT) + Math.ceil(containerHeight / ROW_HEIGHT);
    if (visibleEnd >= threadedDisplay.length - 20) {
      const timer = setTimeout(() => {
        loadMoreEmails();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [scrollTop, containerHeight, threadedDisplay.length, hasMoreEmails, loadingMore, searchActive, viewMode, loadMoreEmails]);

  // Handle scroll — throttled via rAF to avoid 60fps re-renders
  const rafRef = useRef(null);
  const handleScroll = useCallback((e) => {
    if (rafRef.current) return;
    const target = e.currentTarget;
    rafRef.current = requestAnimationFrame(() => {
      setScrollTop(target.scrollTop);
      rafRef.current = null;
    });
  }, []);

  // Pull-to-refresh handlers
  const PULL_THRESHOLD = 80;

  const handleTouchStart = useCallback((e) => {
    if (scrollContainerRef.current?.scrollTop === 0 && !isRefreshing) {
      pullStartY.current = e.touches[0].clientY;
      isPulling.current = true;
    }
  }, [isRefreshing]);

  const handleTouchMove = useCallback((e) => {
    if (!isPulling.current || pullStartY.current === null) return;
    const y = e.touches[0].clientY;
    const distance = Math.max(0, (y - pullStartY.current) * 0.5);
    if (distance > 0 && scrollContainerRef.current?.scrollTop === 0) {
      setPullDistance(Math.min(distance, PULL_THRESHOLD * 1.5));
    }
  }, []);

  const handleTouchEnd = useCallback(async () => {
    if (!isPulling.current) return;
    isPulling.current = false;
    pullStartY.current = null;

    if (pullDistance >= PULL_THRESHOLD) {
      setIsRefreshing(true);
      setPullDistance(PULL_THRESHOLD * 0.6);
      try {
        await useMailStore.getState().loadEmails();
      } finally {
        setIsRefreshing(false);
        setPullDistance(0);
      }
    } else {
      setPullDistance(0);
    }
  }, [pullDistance]);

  // Generate visible rows
  const visibleRows = useMemo(() => {
    const rows = [];
    for (let i = startIndex; i < endIndex; i++) {
      const item = threadedDisplay[i];
      if (item) {
        rows.push({ index: i, item, top: i * ROW_HEIGHT });
      }
    }
    return rows;
  }, [startIndex, endIndex, threadedDisplay, ROW_HEIGHT]);

  const totalHeight = rowCount * ROW_HEIGHT;

  const handleBulkConfirm = async ({ action, uids }) => {
    const { activeAccountId, accounts, activeMailbox } = useMailStore.getState();
    let account = accounts.find(a => a.id === activeAccountId);
    if (!account) return;

    clearSelection();

    try {
      await bulkOperationManager.start({
        type: action,
        accountId: activeAccountId,
        account,
        mailbox: activeMailbox,
        uids,
        onProgress: (op) => setBulkOpProgress({ ...op }),
      });

      if (bulkOperationManager.operation?.status === 'complete') {
        await useMailStore.getState().loadEmails();
      }
    } catch (err) {
      console.error('[EmailList] Bulk operation failed:', err);
    }
  };

  const handleBulkCancel = async () => {
    await bulkOperationManager.cancel();
    setBulkOpProgress(null);
  };

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Header */}
      <div data-tauri-drag-region className="flex items-center justify-between px-4 py-3 border-b border-mail-border bg-mail-surface flex-shrink-0 min-h-[48px]">
        <div className="flex items-center gap-3">
          <button
            onClick={() => allSelected ? clearSelection() : setBulkModalOpen(true)}
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
            <div className="flex flex-col">
              <h2 className="text-lg font-semibold text-mail-text">
                {activeMailbox === 'UNIFIED' ? 'All Inboxes' : activeMailbox}
              </h2>
              <div className="text-xs text-mail-text-muted mt-0.5 flex items-center gap-1.5">
                <span>{totalEmails.toLocaleString()} emails</span>
                <span>·</span>
                <span className="capitalize">{viewMode}</span>
                {dateRange && (
                  <>
                    <span>·</span>
                    <span>{dateRange}</span>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Sender grouping toggle */}
          <button
            onClick={() => setEmailListGrouping(
              emailListGrouping === 'chronological' ? 'sender' : 'chronological'
            )}
            className={`p-1.5 rounded-lg transition-colors ${
              emailListGrouping === 'sender'
                ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
            }`}
            title={emailListGrouping === 'sender' ? 'Switch to chronological view' : 'Group by sender'}
          >
            <Users size={16} />
          </button>
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
        onScroll={handleScroll}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        className="flex-1 overflow-y-auto min-h-0"
      >
        {/* Pull-to-refresh indicator */}
        {(pullDistance > 0 || isRefreshing) && (
          <div
            className="flex items-center justify-center transition-all"
            style={{ height: pullDistance }}
          >
            <RefreshCw
              size={18}
              className={`text-mail-accent transition-transform ${isRefreshing ? 'animate-spin' : ''}`}
              style={{
                transform: `rotate(${Math.min(pullDistance / PULL_THRESHOLD, 1) * 360}deg)`,
                opacity: Math.min(pullDistance / PULL_THRESHOLD, 1),
              }}
            />
          </div>
        )}
        {loading && rowCount === 0 ? (
          <div className="flex items-center justify-center h-full">
            <RefreshCw size={24} className="animate-spin text-mail-accent" />
          </div>
        ) : rowCount === 0 ? (
          <div
            data-testid="email-list-empty-state"
            className="flex flex-col items-center justify-center h-full text-mail-text-muted"
          >
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
                <p>No locally archived emails</p>
                <p className="text-sm mt-2">Archive emails from "Server" view to access them offline</p>
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
        ) : emailListGrouping === 'sender' ? (
          /* Sender-grouped accordion view */
          senderGroups === null ? (
            <div className="flex items-center justify-center h-32 text-gray-400">
              <RefreshCw size={16} className="animate-spin mr-2" />
              Grouping...
            </div>
          ) : senderGroups.length === 0 ? null : (
            <div className="divide-y divide-gray-100 dark:divide-gray-800">
              {senderGroups.map((sender) => (
                <div key={sender.senderEmail}>
                  {/* Sender row - avatar, name, email, unread badge, date */}
                  <button
                    onClick={() => {
                      setExpandedSender(expandedSender === sender.senderEmail ? null : sender.senderEmail);
                      setExpandedTopics(new Set());
                      setExpandedEmail(null);
                    }}
                    className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors ${
                      expandedSender === sender.senderEmail ? 'bg-gray-50 dark:bg-gray-800/50' : ''
                    }`}
                  >
                    <div
                      className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-medium flex-shrink-0"
                      style={{ backgroundColor: getAvatarColor(sender.senderEmail) }}
                    >
                      {getInitials(sender.senderName || sender.senderEmail)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-sm truncate ${sender.unreadCount > 0 ? 'font-semibold text-gray-900 dark:text-white' : 'text-gray-700 dark:text-gray-300'}`}>
                          {sender.senderName || sender.senderEmail}
                        </span>
                        {sender.senderName && sender.senderName !== sender.senderEmail && (
                          <span className="text-xs text-gray-400 truncate hidden sm:inline">
                            {sender.senderEmail}
                          </span>
                        )}
                      </div>
                    </div>
                    {sender.unreadCount > 0 && (
                      <span className="px-1.5 py-0.5 text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 rounded-full">
                        {sender.unreadCount}
                      </span>
                    )}
                    <span className="text-xs text-gray-400 flex-shrink-0">
                      {sender.lastDate ? formatEmailDate(sender.lastDate) : ''}
                    </span>
                  </button>

                  {/* Expanded sender: show topics */}
                  {expandedSender === sender.senderEmail && (
                    <div className="bg-gray-50/50 dark:bg-gray-800/30">
                      {sender.topics.map((topic) => {
                        const topicKey = `${sender.senderEmail}-${topic.subject}`;
                        return (
                        <div key={topicKey}>
                          <button
                            onClick={() => {
                              setExpandedTopics(prev => {
                                const next = new Set(prev);
                                if (next.has(topicKey)) next.delete(topicKey);
                                else next.add(topicKey);
                                return next;
                              });
                              setExpandedEmail(null);
                            }}
                            className={`w-full flex items-center gap-3 pl-12 pr-4 py-2.5 text-left hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors ${
                              expandedTopics.has(topicKey) ? 'bg-gray-100 dark:bg-gray-700/50' : ''
                            }`}
                          >
                            <div className="flex-1 min-w-0">
                              <div className={`text-sm truncate ${topic.unreadCount > 0 ? 'font-semibold text-gray-900 dark:text-white' : 'text-gray-600 dark:text-gray-400'}`}>
                                {topic.originalSubject || '(No subject)'}
                              </div>
                              <div className="text-xs text-gray-400 truncate mt-0.5">
                                {topic.participants
                                  .filter(p => p !== sender.senderEmail)
                                  .map(p => p.split('@')[0])
                                  .join(', ')
                                  || 'No other participants'
                                }
                                {topic.participants.filter(p => p !== sender.senderEmail).length > 0 && (
                                  <span> · {topic.emails.length} email{topic.emails.length !== 1 ? 's' : ''}</span>
                                )}
                              </div>
                            </div>
                            {topic.unreadCount > 0 && (
                              <span className="px-1.5 py-0.5 text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 rounded-full">
                                {topic.unreadCount}
                              </span>
                            )}
                            <span className="text-xs text-gray-400 flex-shrink-0">
                              {topic.lastDate ? formatEmailDate(topic.lastDate) : ''}
                            </span>
                          </button>

                          {/* Expanded topic: show emails */}
                          {expandedTopics.has(topicKey) && (
                            <div className="bg-white dark:bg-gray-900">
                              {topic.emails.map((email) => (
                                <div key={email.uid}>
                                  <button
                                    onClick={() => {
                                      selectEmail(email);
                                      if (expandedEmail === email.uid) {
                                        setExpandedEmail(null);
                                      } else {
                                        setExpandedEmail(email.uid);
                                      }
                                    }}
                                    className={`w-full flex items-center gap-3 pl-16 pr-4 py-2 text-left hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors ${
                                      expandedEmail === email.uid ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                                    } ${selectedEmailId === email.uid ? 'ring-1 ring-blue-300 dark:ring-blue-700' : ''}`}
                                  >
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-2">
                                        <span className="text-xs text-gray-400">
                                          {email.date ? formatEmailDate(new Date(email.date)) : ''}
                                        </span>
                                        <span className={`text-xs ${!email.flags?.includes('\\Seen') ? 'font-semibold text-gray-700 dark:text-gray-300' : 'text-gray-500 dark:text-gray-400'}`}>
                                          {email.from?.name || (email.from?.address || '').split('@')[0]}
                                        </span>
                                      </div>
                                      {email.snippet && (
                                        <div className="text-xs text-gray-400 truncate mt-0.5">
                                          {email.snippet}
                                        </div>
                                      )}
                                    </div>
                                    {email.has_attachments && (
                                      <Paperclip size={12} className="text-gray-400 flex-shrink-0" />
                                    )}
                                  </button>

                                  {/* Inline expanded email body (plain text) */}
                                  {expandedEmail === email.uid && (
                                    <div className="pl-16 pr-4 py-3 border-t border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900">
                                      <div className="text-xs text-gray-500 mb-2">
                                        From: {email.from?.name || email.from?.address} · To: {email.to?.[0]?.address || ''}
                                      </div>
                                      <div className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
                                        {email.text || email.textBody || email.snippet || email.subject || 'No content available'}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )
        ) : (
          /* Original chronological virtual scroll rendering */
          <div key={`${activeAccountId}-${viewMode}`} style={{ height: totalHeight, position: 'relative' }}>
            {visibleRows.map(({ index, item, top }) => {
              if (!item) return null;

              const rowStyle = { top, height: ROW_HEIGHT };

              if (item.type === 'thread') {
                const ThreadRowComponent = isCompact ? CompactThreadRow : ThreadRow;
                const anyChecked = item.thread.emails.some(e => selectedEmailIds.has(e.uid));
                return (
                  <ThreadRowComponent
                    key={`thread-${item.thread.threadId}`}
                    thread={item.thread}
                    isSelected={item.thread.emails.some(e => selectedEmailId === e.uid)}
                    onSelectThread={selectThread}
                    onToggleSelection={toggleEmailSelection}
                    anyChecked={anyChecked}
                    style={rowStyle}
                  />
                );
              }

              return (
                <RowComponent
                  key={item.email.uid}
                  email={item.email}
                  isSelected={selectedEmailId === item.email.uid}
                  isChecked={selectedEmailIds.has(item.email.uid)}
                  onSelect={selectEmail}
                  onToggleSelection={toggleEmailSelection}
                  style={rowStyle}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* View Mode Legend */}
      <div className="px-4 py-2 border-t border-mail-border bg-mail-surface/50
                      flex items-center gap-4 text-xs text-mail-text-muted flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <HardDrive size={12} className="text-mail-local" />
          <span>Archived</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Cloud size={12} className="text-mail-server" />
          <span>Server only</span>
        </div>
        <div className="flex items-center gap-1.5">
          <HardDrive size={12} className="text-mail-warning" />
          <span>Local only (deleted from server)</span>
        </div>
      </div>

      <BulkOperationsModal
        isOpen={bulkModalOpen}
        onClose={() => setBulkModalOpen(false)}
        onConfirm={handleBulkConfirm}
      />
      <BulkOperationProgress
        operation={bulkOpProgress}
        onCancel={handleBulkCancel}
        onDismiss={() => setBulkOpProgress(null)}
      />
    </div>
  );
}

export const EmailList = memo(EmailListComponent);
