import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Archive, ArchiveRestore, Trash2, ArrowRight, ArrowLeft, AlertTriangle, HardDrive, Calendar } from 'lucide-react';
import { useMailStore } from '../stores/mailStore';

const ACTION_STYLES = {
  archive: {
    color: 'var(--mail-local)',
    iconColor: 'text-mail-local',
    confirmLabel: 'Start Archive',
  },
  delete: {
    color: 'var(--mail-danger)',
    iconColor: 'text-mail-danger',
    confirmLabel: 'Confirm Delete',
  },
  archive_and_delete: {
    color: 'var(--mail-local)',
    iconColor: 'text-mail-local',
    confirmLabel: 'Archive & Delete',
  },
  unarchive: {
    color: 'var(--mail-warning)',
    iconColor: 'text-mail-warning',
    confirmLabel: 'Unarchive',
  },
};

function actionBg(color, pct) {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}

export function BulkOperationsModal({ isOpen, onClose, onConfirm }) {
  const [step, setStep] = useState(1);
  const [selectedRange, setSelectedRange] = useState(null);
  const [selectedAction, setSelectedAction] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const sortedEmails = useMailStore(s => s.sortedEmails);
  const totalEmails = useMailStore(s => s.totalEmails);
  const archivedEmailIds = useMailStore(s => s.archivedEmailIds);

  // Compute available years from loaded emails
  const emailYears = useMemo(() => {
    const years = new Map(); // year -> count
    for (const email of sortedEmails) {
      const date = email.date ? new Date(email.date) : null;
      if (date && !isNaN(date)) {
        const y = date.getFullYear();
        years.set(y, (years.get(y) || 0) + 1);
      }
    }
    return [...years.entries()].sort((a, b) => b[0] - a[0]);
  }, [sortedEmails]);

  // Filter emails by selected range
  const selectedEmails = useMemo(() => {
    if (!selectedRange) return [];
    const now = new Date();

    return sortedEmails.filter(email => {
      const date = email.date ? new Date(email.date) : null;
      if (!date || isNaN(date)) return false;

      switch (selectedRange.type) {
        case 'all':
          return true;
        case 'year':
          return date.getFullYear() === selectedRange.year;
        case 'today': {
          const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          return date >= start;
        }
        case 'yesterday': {
          const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
          const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          return date >= dayStart && date < dayEnd;
        }
        case 'last_week':
          return (now - date) <= 7 * 24 * 60 * 60 * 1000;
        case 'last_30':
          return (now - date) <= 30 * 24 * 60 * 60 * 1000;
        case 'last_90':
          return (now - date) <= 90 * 24 * 60 * 60 * 1000;
        case 'this_year':
          return date.getFullYear() === now.getFullYear();
        case 'last_year':
          return date.getFullYear() === now.getFullYear() - 1;
        case 'custom': {
          const from = customFrom ? new Date(customFrom) : new Date(0);
          const to = customTo ? new Date(customTo + 'T23:59:59') : now;
          return date >= from && date <= to;
        }
        default:
          return false;
      }
    });
  }, [selectedRange, sortedEmails, customFrom, customTo]);

  const selectedCount = selectedEmails.length;
  const isPartialLoad = sortedEmails.length < totalEmails;

  const handleConfirm = () => {
    if (selectedAction === 'delete' || selectedAction === 'archive_and_delete') {
      setShowDeleteConfirm(true);
      return;
    }
    const uids = selectedEmails.map(e => e.uid);
    onConfirm({ action: selectedAction, uids });
    handleClose();
  };

  const handleDeleteConfirm = () => {
    const uids = selectedEmails.map(e => e.uid);
    onConfirm({ action: selectedAction, uids });
    handleClose();
  };

  const handleClose = () => {
    setStep(1);
    setSelectedRange(null);
    setSelectedAction(null);
    setShowDeleteConfirm(false);
    setCustomFrom('');
    setCustomTo('');
    onClose();
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 bg-black/50"
          onClick={handleClose}
        />

        {/* Modal */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          className="relative bg-mail-bg border border-mail-border rounded-xl shadow-2xl
                     w-full max-w-md mx-4 overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-mail-border">
            <h2 className="text-lg font-semibold text-mail-text">
              {showDeleteConfirm ? 'Confirm Delete' : step === 1 ? 'Bulk Email Operations' : `Choose Action for ${selectedCount.toLocaleString()} Emails`}
            </h2>
            <button onClick={handleClose} className="p-1 hover:bg-mail-border rounded transition-colors">
              <X size={18} className="text-mail-text-muted" />
            </button>
          </div>

          {/* Delete confirmation */}
          {showDeleteConfirm ? (
            <div className="p-5">
              <div className="flex items-start gap-3 p-4 bg-red-500/10 border border-red-500/20 rounded-lg mb-4">
                <AlertTriangle size={20} className="text-mail-danger flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-mail-text">
                    Are you sure? This will permanently delete {selectedCount.toLocaleString()} emails from the server.
                  </p>
                  <p className="text-xs text-mail-text-muted mt-1">This cannot be undone.</p>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="px-4 py-2 text-sm text-mail-text-muted hover:bg-mail-border rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDeleteConfirm}
                  className="px-4 py-2 text-sm font-medium bg-mail-danger text-white rounded-lg
                            hover:bg-mail-danger/90 transition-colors"
                >
                  Yes, Delete
                </button>
              </div>
            </div>
          ) : step === 1 ? (
            /* Step 1: Date Range */
            <div className="p-5">
              {isPartialLoad && (
                <div className="flex items-start gap-2 p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg mb-4">
                  <AlertTriangle size={16} className="text-yellow-500 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-mail-text-muted">
                    {sortedEmails.length.toLocaleString()} of {totalEmails.toLocaleString()} total emails are loaded. Only loaded emails will be selected.
                  </p>
                </div>
              )}

              {/* Per-year buttons */}
              {emailYears.length > 0 && (
                <div className="mb-4">
                  <label className="text-xs font-medium text-mail-text-muted uppercase tracking-wide mb-2 block">By Year</label>
                  <div className="flex flex-wrap gap-2">
                    {emailYears.map(([year, count]) => {
                      const isActive = selectedRange?.type === 'year' && selectedRange?.year === year;
                      return (
                        <button
                          key={year}
                          onClick={() => setSelectedRange({ type: 'year', year })}
                          className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                            isActive
                              ? 'bg-mail-accent text-white border-mail-accent'
                              : 'bg-mail-surface border-mail-border text-mail-text hover:bg-mail-surface-hover'
                          }`}
                        >
                          {year} ({count.toLocaleString()})
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Relative presets */}
              <div className="mb-4">
                <label className="text-xs font-medium text-mail-text-muted uppercase tracking-wide mb-2 block">Presets</label>
                <div className="flex flex-wrap gap-2">
                  {[
                    { type: 'today', label: 'Today' },
                    { type: 'yesterday', label: 'Yesterday' },
                    { type: 'last_week', label: 'Last Week' },
                    { type: 'last_30', label: 'Last 30 Days' },
                    { type: 'last_90', label: 'Last 90 Days' },
                    { type: 'this_year', label: 'This Year' },
                    { type: 'last_year', label: 'Last Year' },
                    { type: 'all', label: 'All' },
                  ].map(preset => {
                    const isActive = selectedRange?.type === preset.type;
                    return (
                      <button
                        key={preset.type}
                        onClick={() => setSelectedRange({ type: preset.type })}
                        className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                          isActive
                            ? 'bg-mail-accent text-white border-mail-accent'
                            : 'bg-mail-surface border-mail-border text-mail-text hover:bg-mail-surface-hover'
                        }`}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Custom range */}
              <div className="mb-4">
                <button
                  onClick={() => setSelectedRange({ type: 'custom' })}
                  className={`flex items-center gap-1.5 text-sm mb-2 ${
                    selectedRange?.type === 'custom' ? 'text-mail-accent font-medium' : 'text-mail-text-muted hover:text-mail-text'
                  }`}
                >
                  <Calendar size={14} />
                  Custom Range
                </button>
                {selectedRange?.type === 'custom' && (
                  <div className="flex items-center gap-2">
                    <input
                      type="date"
                      value={customFrom}
                      onChange={(e) => setCustomFrom(e.target.value)}
                      className="px-2 py-1.5 text-sm bg-mail-surface border border-mail-border rounded-lg
                                text-mail-text focus:border-mail-accent outline-none"
                    />
                    <span className="text-mail-text-muted text-sm">to</span>
                    <input
                      type="date"
                      value={customTo}
                      onChange={(e) => setCustomTo(e.target.value)}
                      className="px-2 py-1.5 text-sm bg-mail-surface border border-mail-border rounded-lg
                                text-mail-text focus:border-mail-accent outline-none"
                    />
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="flex items-center justify-between pt-3 border-t border-mail-border">
                <span className="text-sm text-mail-text-muted">
                  {selectedCount > 0 ? `${selectedCount.toLocaleString()} emails selected` : 'Select a date range'}
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={handleClose}
                    className="px-4 py-2 text-sm text-mail-text-muted hover:bg-mail-border rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => setStep(2)}
                    disabled={selectedCount === 0}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-mail-accent text-white
                              rounded-lg hover:bg-mail-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Next
                    <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            </div>
          ) : (
            /* Step 2: Action Selection */
            <div className="p-5">
              {/* Warning for locally-stored emails */}
              {selectedEmails.some(e => archivedEmailIds.has(e.uid)) && (
                <div className="flex items-start gap-2 p-3 mb-3 rounded-lg bg-mail-warning/10 border border-mail-warning/30">
                  <AlertTriangle size={14} className="text-mail-warning flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-mail-text">
                    Some selected emails are archived locally. Deleting from server is safe — your local copies remain.
                    Unarchiving will remove local copies — if they're also deleted from server, they will be <strong>lost forever</strong>.
                  </p>
                </div>
              )}
              <div className="space-y-3 mb-4">
                {[
                  {
                    id: 'archive',
                    icon: HardDrive,
                    label: 'Archive',
                    description: 'Download emails to your computer',
                  },
                  ...(selectedEmails.some(e => archivedEmailIds.has(e.uid)) ? [{
                    id: 'unarchive',
                    icon: ArchiveRestore,
                    label: 'Unarchive',
                    description: 'Remove local copies — emails only remain on server',
                  }] : []),
                  {
                    id: 'delete',
                    icon: Trash2,
                    label: 'Delete from Server',
                    description: 'Permanently remove from server (local archives kept)',
                  },
                  {
                    id: 'archive_and_delete',
                    icon: Archive,
                    label: 'Archive & Delete',
                    description: 'Download first, then remove from server',
                  },
                ].map(action => {
                  const isActive = selectedAction === action.id;
                  const Icon = action.icon;
                  const styles = ACTION_STYLES[action.id];
                  const isGradient = action.id === 'archive_and_delete';
                  return (
                    <button
                      key={action.id}
                      onClick={() => setSelectedAction(action.id)}
                      className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all text-left ${
                        isActive ? '' : 'bg-mail-surface border-mail-border hover:bg-mail-surface-hover'
                      }`}
                      style={isActive ? {
                        background: isGradient
                          ? `linear-gradient(135deg, ${actionBg('var(--mail-local)', 10)}, ${actionBg('var(--mail-danger)', 10)})`
                          : actionBg(styles.color, 10),
                        borderColor: isGradient
                          ? actionBg('var(--mail-local)', 30)
                          : actionBg(styles.color, 30),
                      } : undefined}
                    >
                      <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center"
                        style={isActive ? {
                          background: isGradient
                            ? `linear-gradient(135deg, ${actionBg('var(--mail-local)', 20)}, ${actionBg('var(--mail-danger)', 20)})`
                            : actionBg(styles.color, 20),
                        } : { backgroundColor: 'var(--mail-border)' }}
                      >
                        <Icon size={16} className={isActive ? styles.iconColor : 'text-mail-text-muted'} />
                      </div>
                      <div>
                        <div className="text-sm font-medium text-mail-text">
                          {action.label}
                        </div>
                        <div className="text-xs text-mail-text-muted">{action.description}</div>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Footer */}
              <div className="flex justify-between pt-3 border-t border-mail-border">
                <button
                  onClick={() => { setStep(1); setSelectedAction(null); }}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm text-mail-text-muted
                            hover:bg-mail-border rounded-lg transition-colors"
                >
                  <ArrowLeft size={14} />
                  Back
                </button>
                <button
                  onClick={handleConfirm}
                  disabled={!selectedAction}
                  className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-all
                            disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90"
                  style={{
                    background: !selectedAction
                      ? 'var(--mail-accent)'
                      : selectedAction === 'archive_and_delete'
                        ? 'linear-gradient(135deg, var(--mail-local), var(--mail-danger))'
                        : ACTION_STYLES[selectedAction].color
                  }}
                >
                  {selectedAction ? ACTION_STYLES[selectedAction].confirmLabel : 'Start'}
                </button>
              </div>
            </div>
          )}
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
