import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowRight, ArrowLeftRight, Check, CheckCircle2, Circle,
  Loader, XCircle, AlertCircle, Folder, Lock,
  ChevronDown, ChevronRight, X, Play, Pause, Loader2
} from 'lucide-react';
import { useSettingsStore, getAccountInitial, getAccountColor } from '../../stores/settingsStore.js';
import { useMailStore } from '../../stores/mailStore.js';
import * as api from '../../services/api.js';
import { ensureFreshToken } from '../../services/authUtils.js';
import { migrationManager } from '../../services/migrationManager.js';

function formatDuration(secs) {
  if (!secs || secs < 1) return '< 1s';
  if (secs < 60) return '< 1 min';
  if (secs < 3600) return `${Math.floor(secs / 60)} min`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function getTransport(account) {
  return account?.oauth2Transport === 'graph' ? 'graph' : 'imap';
}

const stepAnimation = {
  initial: { opacity: 0, x: 20 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -20 },
  transition: { duration: 0.15 },
};

const STEP_LABELS = ['Source', 'Destination', 'Folders', 'Confirm'];

function StepIndicator({ step }) {
  return (
    <div className="flex items-center mb-6">
      {STEP_LABELS.map((label, i) => {
        const stepNum = i + 1;
        const isCompleted = stepNum < step;
        const isCurrent = stepNum === step;
        return (
          <div key={label} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold ${
                  isCompleted || isCurrent
                    ? 'bg-mail-accent text-white'
                    : 'bg-mail-border text-mail-text-muted'
                }`}
              >
                {isCompleted ? <Check size={14} /> : stepNum}
              </div>
              <span className={`text-xs mt-1 ${isCurrent ? 'text-mail-text font-medium' : 'text-mail-text-muted'}`}>
                {label}
              </span>
            </div>
            {i < STEP_LABELS.length - 1 && (
              <div className={`h-0.5 flex-1 mx-2 ${stepNum < step ? 'bg-mail-accent' : 'bg-mail-border'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function AccountRow({ account, selected, disabled, disabledLabel, accountColors, onClick }) {
  const avatarColor = getAccountColor(accountColors, account);
  const avatarInitial = getAccountInitial(account);
  const transport = getTransport(account);

  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      className={`w-full border rounded-lg p-3 flex items-center gap-3 transition-colors ${
        disabled
          ? 'opacity-50 cursor-not-allowed border-mail-border bg-mail-surface'
          : selected
            ? 'border-mail-accent bg-mail-accent/5 cursor-pointer'
            : 'border-mail-border bg-mail-surface cursor-pointer hover:border-mail-accent/50 hover:bg-mail-surface-hover'
      }`}
    >
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold flex-shrink-0"
        style={{ backgroundColor: avatarColor }}
      >
        {avatarInitial}
      </div>
      <span className="text-sm text-mail-text flex-1 text-left">{account.email}</span>
      {disabledLabel && (
        <span className="text-xs text-mail-text-muted">{disabledLabel}</span>
      )}
      <span className="text-xs px-1.5 py-0.5 rounded bg-mail-border text-mail-text-muted">
        {transport === 'graph' ? 'Graph' : 'IMAP'}
      </span>
    </button>
  );
}

export default function MigrationSettings() {
  const isPaidUser = useSettingsStore(s => s.isPaidUser);
  const activeMigration = useSettingsStore(s => s.activeMigration);
  const migrationHistory = useSettingsStore(s => s.migrationHistory);
  const incompleteMigration = useSettingsStore(s => s.incompleteMigration);
  const accounts = useMailStore(s => s.accounts);
  const accountColors = useSettingsStore(s => s.accountColors);
  const folderCounts = useSettingsStore(s => s.migrationFolderCounts);
  const clearFolderCounts = useSettingsStore(s => s.clearMigrationFolderCounts);

  // Wizard state
  const [step, setStep] = useState(1);
  const [sourceAccount, setSourceAccount] = useState(null);
  const [destAccount, setDestAccount] = useState(null);
  const [folderMappings, setFolderMappings] = useState([]);
  const [selectedFolders, setSelectedFolders] = useState(new Set());
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [starting, setStarting] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [error, setError] = useState(null);

  // Auto-select dest when only 1 other account
  useEffect(() => {
    if (step === 2 && sourceAccount && accounts.length === 2) {
      const other = accounts.find(a => a.id !== sourceAccount.id);
      if (other) setDestAccount(other);
    }
  }, [step, sourceAccount, accounts]);

  // Load folder mappings on step 3
  useEffect(() => {
    if (step !== 3 || !sourceAccount || !destAccount) return;
    let cancelled = false;
    setLoadingFolders(true);
    setError(null);

    api.getFolderMappings(sourceAccount, destAccount, getTransport(sourceAccount), getTransport(destAccount))
      .then((mappings) => {
        if (cancelled) return;
        setFolderMappings(mappings || []);
        setSelectedFolders(new Set((mappings || []).map((_, i) => i)));
        // Trigger background folder email counting
        clearFolderCounts();
        api.countMigrationFolders(sourceAccount, getTransport(sourceAccount), mappings || []).catch(() => {});
      })
      .catch((err) => {
        if (!cancelled) setError('Failed to load folders: ' + (err.message || err));
      })
      .finally(() => {
        if (!cancelled) setLoadingFolders(false);
      });

    return () => { cancelled = true; };
  }, [step, sourceAccount, destAccount]);

  const toggleFolder = useCallback((index) => {
    setSelectedFolders(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const toggleAllFolders = useCallback(() => {
    setSelectedFolders(prev => {
      if (prev.size === folderMappings.length) return new Set();
      return new Set(folderMappings.map((_, i) => i));
    });
  }, [folderMappings]);

  const selectedMappings = folderMappings.filter((_, i) => selectedFolders.has(i));
  const totalEmails = selectedMappings.reduce((sum, m) => sum + (m.email_count || 0), 0);
  const etaMinutes = Math.ceil(totalEmails * 1.5 / 60);

  const handleStartMigration = useCallback(async () => {
    if (!sourceAccount || !destAccount || selectedMappings.length === 0) return;
    setStarting(true);
    setError(null);
    useSettingsStore.getState().clearMigrationLogEntries();
    try {
      await ensureFreshToken(sourceAccount);
      await ensureFreshToken(destAccount);
    } catch (err) {
      setError(`Failed to refresh authentication for ${err.account?.email || 'an account'}. Please re-authenticate the account and try again.`);
      setStarting(false);
      return;
    }
    try {
      await api.startMigration(
        sourceAccount, destAccount,
        getTransport(sourceAccount), getTransport(destAccount),
        selectedMappings
      );
    } catch (err) {
      setError('Failed to start migration: ' + (err.message || err));
    } finally {
      setStarting(false);
    }
  }, [sourceAccount, destAccount, selectedMappings]);

  const handlePause = useCallback(async () => {
    try { await api.pauseMigration(); } catch (e) { console.error('Pause failed:', e); }
  }, []);

  const [cancelRemoving, setCancelRemoving] = useState(false);
  const [cancelRemoveError, setCancelRemoveError] = useState(null);

  const handleCancel = useCallback(async (choice) => {
    try {
      await api.cancelMigration();
    } catch (e) { console.error('Cancel failed:', e); }
    if (choice === 'remove') {
      setCancelRemoving(true);
      try {
        await api.removeMigratedEmails(activeMigration);
      } catch (err) {
        setCancelRemoveError(err.message || 'Removal failed. Some emails may remain at the destination.');
        setCancelRemoving(false);
        return; // Keep dialog open so user sees the error
      }
      setCancelRemoving(false);
    }
    await api.clearMigrationState();
    setShowCancelConfirm(false);
  }, [activeMigration]);

  const handleResume = useCallback(async (srcAccount, dstAccount) => {
    setError(null);
    try {
      await ensureFreshToken(srcAccount);
      await ensureFreshToken(dstAccount);
    } catch (err) {
      setError(`Failed to refresh authentication. Please re-authenticate and try again.`);
      return;
    }
    try {
      await api.resumeMigration(srcAccount, dstAccount, getTransport(srcAccount), getTransport(dstAccount));
    } catch (err) {
      setError('Failed to resume migration: ' + (err.message || err));
    }
  }, []);

  const handleDone = useCallback(() => {
    useSettingsStore.getState().clearActiveMigration();
    setStep(1);
    setSourceAccount(null);
    setDestAccount(null);
    setFolderMappings([]);
    setSelectedFolders(new Set());
  }, []);

  const canGoNext = step === 1 ? !!sourceAccount
    : step === 2 ? !!destAccount
    : step === 3 ? selectedFolders.size > 0
    : true;

  // Determine view: progress, completion, or wizard
  const isRunning = activeMigration && (activeMigration.status === 'running' || activeMigration.status === 'paused');
  const isCompleted = activeMigration && (activeMigration.status === 'completed' || activeMigration.status === 'failed' || activeMigration.status === 'cancelled');

  // ---- Premium gate ----
  const mainContent = (
    <div className="p-6 space-y-6">
      {/* Error display */}
      {error && (
        <div className="bg-mail-danger/10 border border-mail-danger/30 rounded-lg p-3 flex items-start gap-2">
          <AlertCircle size={16} className="text-mail-danger mt-0.5 flex-shrink-0" />
          <p className="text-sm text-mail-danger">{error}</p>
        </div>
      )}

      {/* Resume banner */}
      {incompleteMigration && !activeMigration && (
        <div className="bg-mail-warning/10 border border-mail-warning/30 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <AlertCircle size={20} className="text-mail-warning mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm text-mail-text mb-3">
                An incomplete migration was found. {incompleteMigration.completed_folders || 0} of {incompleteMigration.total_folders || 0} folders completed.
              </p>
              {showDiscardConfirm ? (
                <div className="bg-mail-surface rounded-lg p-3">
                  <p className="text-sm text-mail-text mb-3">Discard incomplete migration? Progress will be lost.</p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        migrationManager.discardIncompleteMigration();
                        setShowDiscardConfirm(false);
                      }}
                      className="text-sm text-mail-danger hover:text-mail-danger/80"
                    >
                      Discard
                    </button>
                    <button
                      onClick={() => setShowDiscardConfirm(false)}
                      className="text-sm text-mail-text-muted hover:text-mail-text"
                    >
                      Keep
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => {
                      const src = accounts.find(a => a.email === incompleteMigration.source_email);
                      const dst = accounts.find(a => a.email === incompleteMigration.dest_email);
                      if (src && dst) handleResume(src, dst);
                    }}
                    className="bg-mail-accent text-white rounded-lg px-4 py-2 text-sm font-semibold"
                  >
                    Resume Migration
                  </button>
                  <button
                    onClick={() => setShowDiscardConfirm(true)}
                    className="text-sm text-mail-text-muted hover:text-mail-text"
                  >
                    Discard
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main view router */}
      {isRunning ? (
        <ProgressView
          migration={activeMigration}
          accounts={accounts}
          accountColors={accountColors}
          onPause={handlePause}
          onResume={handleResume}
          onCancel={() => { setShowCancelConfirm(true); setCancelRemoveError(null); }}
          showCancelConfirm={showCancelConfirm}
          onConfirmCancel={handleCancel}
          onCancelCancel={() => setShowCancelConfirm(false)}
          cancelRemoving={cancelRemoving}
          cancelRemoveError={cancelRemoveError}
        />
      ) : isCompleted ? (
        <CompletionView migration={activeMigration} onDone={handleDone} />
      ) : (
        <>
          {/* Wizard */}
          <StepIndicator step={step} />

          <AnimatePresence mode="wait">
            {step === 1 && (
              <motion.div key="step1" {...stepAnimation}>
                <h4 className="text-sm font-semibold text-mail-text mb-1">Select source account</h4>
                <p className="text-xs text-mail-text-muted mb-4">Choose the account to migrate emails from</p>
                <div className="space-y-2">
                  {accounts.map(account => (
                    <AccountRow
                      key={account.id}
                      account={account}
                      selected={sourceAccount?.id === account.id}
                      accountColors={accountColors}
                      onClick={() => setSourceAccount(account)}
                    />
                  ))}
                </div>
              </motion.div>
            )}

            {step === 2 && (
              <motion.div key="step2" {...stepAnimation}>
                <h4 className="text-sm font-semibold text-mail-text mb-1">Select destination account</h4>
                <p className="text-xs text-mail-text-muted mb-4">Choose where to migrate emails to</p>
                <div className="space-y-2">
                  {accounts.map(account => (
                    <AccountRow
                      key={account.id}
                      account={account}
                      selected={destAccount?.id === account.id}
                      disabled={sourceAccount?.id === account.id}
                      disabledLabel={sourceAccount?.id === account.id ? '(source)' : null}
                      accountColors={accountColors}
                      onClick={() => setDestAccount(account)}
                    />
                  ))}
                </div>
              </motion.div>
            )}

            {step === 3 && (
              <motion.div key="step3" {...stepAnimation}>
                <h4 className="text-sm font-semibold text-mail-text mb-1">Select folders to migrate</h4>
                <p className="text-xs text-mail-text-muted mb-4">All folders are selected by default</p>

                {loadingFolders ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader size={24} className="animate-spin text-mail-accent" />
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2 mb-3">
                      <input
                        type="checkbox"
                        checked={selectedFolders.size === folderMappings.length && folderMappings.length > 0}
                        onChange={toggleAllFolders}
                        className="w-4 h-4 rounded border-mail-border accent-[var(--mail-accent)]"
                      />
                      <span className="text-sm text-mail-text">Select All</span>
                      <span className="text-xs text-mail-text-muted ml-auto">{folderMappings.length} folders</span>
                    </div>
                    <div className="max-h-80 overflow-y-auto space-y-1">
                      {folderMappings.map((mapping, i) => {
                        const depth = (mapping.source_path || '').split('/').length - 1;
                        const isSelected = selectedFolders.has(i);
                        return (
                          <label
                            key={i}
                            className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer hover:bg-mail-surface-hover ${
                              isSelected ? 'text-mail-text' : 'text-mail-text-muted'
                            }`}
                            style={{ paddingLeft: `${8 + depth * 24}px` }}
                          >
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleFolder(i)}
                              className="w-4 h-4 rounded border-mail-border accent-[var(--mail-accent)]"
                            />
                            <Folder size={16} className="flex-shrink-0" />
                            <span className="text-sm flex-1">{mapping.source_name || mapping.source_path}</span>
                            {folderCounts[mapping.source_path] ? (
                              <span className="text-xs text-mail-text-muted bg-mail-border px-1.5 py-0.5 rounded">
                                {folderCounts[mapping.source_path].counting
                                  ? `${folderCounts[mapping.source_path].count}+ (counting...)`
                                  : `${folderCounts[mapping.source_path].count} emails`
                                }
                              </span>
                            ) : mapping.email_count != null ? (
                              <span className="text-xs text-mail-text-muted bg-mail-border px-1.5 py-0.5 rounded">
                                {mapping.email_count}
                              </span>
                            ) : null}
                          </label>
                        );
                      })}
                    </div>
                  </>
                )}
              </motion.div>
            )}

            {step === 4 && (
              <motion.div key="step4" {...stepAnimation}>
                <h4 className="text-sm font-semibold text-mail-text mb-4">Review migration</h4>

                {/* Summary card */}
                <div className="bg-mail-surface rounded-lg p-4 space-y-3 mb-4">
                  <SummaryRow label="Source" account={sourceAccount} accountColors={accountColors} />
                  <SummaryRow label="Destination" account={destAccount} accountColors={accountColors} />
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-mail-text-muted">Folders</span>
                    <span className="text-mail-text">{selectedMappings.length} folders</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-mail-text-muted">Emails</span>
                    <span className="text-mail-text">~{totalEmails.toLocaleString()} emails</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-mail-text-muted">Estimated time</span>
                    <span className="text-mail-text">~{etaMinutes} min</span>
                  </div>
                </div>

                {/* Folder mapping table */}
                <div className="max-h-60 overflow-y-auto">
                  <div className="grid grid-cols-[1fr_auto_1fr] gap-2 text-xs text-mail-text-muted font-medium mb-2 px-2">
                    <span>Source Folder</span>
                    <span />
                    <span>Destination Folder</span>
                  </div>
                  {selectedMappings.map((mapping, i) => (
                    <div key={i} className="grid grid-cols-[1fr_auto_1fr] gap-2 items-center text-sm px-2 py-1.5 rounded hover:bg-mail-surface-hover">
                      <span className="text-mail-text truncate">{mapping.source_path}</span>
                      <ArrowRight size={14} className="text-mail-text-muted flex-shrink-0" />
                      <span className="text-mail-text truncate flex items-center gap-1">
                        {mapping.dest_path}
                        {mapping.auto_create && (
                          <span className="text-mail-success text-xs">+ New</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Navigation buttons */}
          <div className="flex items-center justify-between pt-4">
            {step > 1 ? (
              <button
                onClick={() => setStep(s => s - 1)}
                className="text-sm text-mail-text-muted hover:text-mail-text"
              >
                Back
              </button>
            ) : <div />}
            <button
              onClick={step === 4 ? handleStartMigration : () => setStep(s => s + 1)}
              disabled={!canGoNext || starting}
              className={`bg-mail-accent text-white rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                !canGoNext || starting ? 'opacity-50 cursor-not-allowed' : 'hover:bg-mail-accent-hover'
              }`}
            >
              {starting ? (
                <span className="flex items-center gap-2">
                  <Loader size={14} className="animate-spin" />
                  Starting...
                </span>
              ) : step === 4 ? 'Start Migration' : 'Next'}
            </button>
          </div>
        </>
      )}

      {/* Migration History */}
      <div className="mt-6">
        <h4 className="text-sm font-semibold text-mail-text mb-3">Migration History</h4>
        {migrationHistory.length > 0 ? (
          <div className="space-y-2">
            {migrationHistory.map((entry) => (
              <div key={entry.id} className="bg-mail-surface rounded-lg p-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1 text-sm">
                    <span className="truncate">{entry.sourceEmail}</span>
                    <ArrowRight size={14} className="text-mail-text-muted flex-shrink-0" />
                    <span className="truncate">{entry.destEmail}</span>
                  </div>
                  <div className="text-xs text-mail-text-muted mt-0.5">
                    {new Date(entry.completedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}{', '}
                    {new Date(entry.completedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-sm font-semibold text-mail-text">{entry.migratedEmails} emails</div>
                  <div className="text-xs text-mail-text-muted">{formatDuration(entry.duration)}</div>
                </div>
                <StatusBadge status={entry.status} />
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-8">
            <h5 className="text-sm font-semibold text-mail-text mb-1">No migrations yet</h5>
            <p className="text-xs text-mail-text-muted max-w-[280px] mx-auto">
              Select a source and destination account to move your emails between providers.
            </p>
          </div>
        )}
      </div>
    </div>
  );

  if (!isPaidUser) {
    return (
      <div className="p-6">
        <div className="relative">
          <div className="opacity-30 blur-[1px] pointer-events-none select-none" aria-hidden="true">
            {mainContent}
          </div>
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-mail-surface/60 backdrop-blur-[1px] rounded-lg">
            <div className="flex flex-col items-center gap-3 text-center px-6">
              <div className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-500/20 to-indigo-500/20 border border-blue-500/30 flex items-center justify-center">
                <ArrowLeftRight size={20} className="text-blue-500" />
              </div>
              <div>
                <p className="text-sm font-semibold text-mail-text mb-1">Coming Soon</p>
                <p className="text-xs text-mail-text-muted text-center max-w-[280px]">
                  Mailbox migration lets you move emails between any two providers. Available in a future update.
                </p>
              </div>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-gradient-to-r from-blue-500 to-indigo-500 text-white rounded-full">
                <ArrowLeftRight size={10} />
                Coming Soon
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return mainContent;
}

function SummaryRow({ label, account, accountColors }) {
  if (!account) return null;
  const avatarColor = getAccountColor(accountColors, account);
  const avatarInitial = getAccountInitial(account);
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-mail-text-muted">{label}</span>
      <div className="flex items-center gap-2">
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-bold"
          style={{ backgroundColor: avatarColor }}
        >
          {avatarInitial}
        </div>
        <span className="text-sm text-mail-text">{account.email}</span>
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  const styles = {
    completed: 'text-mail-success bg-mail-success/10',
    failed: 'text-mail-danger bg-mail-danger/10',
    cancelled: 'text-mail-text-muted bg-mail-border',
  };
  const labels = { completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${styles[status] || styles.cancelled}`}>
      {labels[status] || status}
    </span>
  );
}

function LiveLogSection() {
  const logEntries = useSettingsStore(s => s.migrationLogEntries);
  const [expanded, setExpanded] = useState(true);
  const containerRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logEntries, autoScroll]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    setAutoScroll(atBottom);
  };

  return (
    <div className="border border-mail-border rounded-lg">
      <button onClick={() => setExpanded(!expanded)} className="w-full p-2 text-sm text-mail-text-muted flex items-center gap-1">
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        Live Log
      </button>
      {expanded && (
        <div ref={containerRef} onScroll={handleScroll} className="max-h-48 overflow-y-auto font-mono text-xs p-2 space-y-1">
          {logEntries.length === 0 ? (
            <p className="text-mail-text-muted italic">Log entries will appear here during migration.</p>
          ) : (
            logEntries.map((entry, i) => (
              <div key={i} className="flex items-center gap-1 text-mail-text-muted whitespace-nowrap">
                <span>{entry.timestamp}</span>
                <span className="text-mail-text">{entry.sender}</span>
                <span>--</span>
                <span className="text-mail-text truncate">{entry.subject}</span>
                {entry.status === 'ok' && <Check size={12} className="text-mail-success flex-shrink-0" />}
                {entry.status === 'skipped' && <ArrowRight size={12} className="text-mail-text-muted flex-shrink-0" />}
                {entry.status === 'failed' && <X size={12} className="text-mail-danger flex-shrink-0" />}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function RateLimitCountdown({ initialSeconds }) {
  const [seconds, setSeconds] = useState(initialSeconds);
  useEffect(() => { setSeconds(initialSeconds); }, [initialSeconds]);
  useEffect(() => {
    if (seconds <= 0) return;
    const timer = setTimeout(() => setSeconds(s => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [seconds]);
  if (seconds <= 0) return null;
  return <p className="text-xs text-mail-warning font-semibold">Rate limited -- retrying in {seconds}s</p>;
}

function ProgressView({ migration, accounts, accountColors, onPause, onResume, onCancel, showCancelConfirm, onConfirmCancel, onCancelCancel, cancelRemoving, cancelRemoveError }) {
  const isPaused = migration.status === 'paused';
  const [isPausing, setIsPausing] = useState(false);
  const srcAccount = accounts.find(a => a.email === migration.source_email);
  const dstAccount = accounts.find(a => a.email === migration.dest_email);

  // Clear isPausing when status changes to paused
  useEffect(() => {
    if (isPaused) setIsPausing(false);
  }, [isPaused]);

  const totalEmails = (migration.migrated_emails || 0) + (migration.skipped_emails || 0) + (migration.failed_emails || 0);
  const totalTarget = migration.total_emails || totalEmails || 1;
  const percent = Math.min(100, Math.round((migration.migrated_emails / Math.max(totalTarget, 1)) * 100));
  const elapsedSecs = migration.elapsed_seconds || 0;
  const etaMinutes = migration.migrated_emails > 0
    ? Math.ceil((totalTarget - migration.migrated_emails) * (elapsedSecs / Math.max(migration.migrated_emails, 1)) / 60)
    : null;

  return (
    <div className="space-y-4">
      {/* Header: source -> dest */}
      <div className="flex items-center gap-3">
        {srcAccount && (
          <div className="flex items-center gap-2">
            <div
              className="w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-bold"
              style={{ backgroundColor: getAccountColor(accountColors, srcAccount) }}
            >
              {getAccountInitial(srcAccount)}
            </div>
            <span className="text-sm text-mail-text">{srcAccount.email}</span>
          </div>
        )}
        <ArrowRight size={16} className="text-mail-text-muted flex-shrink-0" />
        {dstAccount && (
          <div className="flex items-center gap-2">
            <div
              className="w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-bold"
              style={{ backgroundColor: getAccountColor(accountColors, dstAccount) }}
            >
              {getAccountInitial(dstAccount)}
            </div>
            <span className="text-sm text-mail-text">{dstAccount.email}</span>
          </div>
        )}
        <StatusBadge status={isPaused ? 'paused' : 'running'} />
      </div>

      {/* Progress bar */}
      <div>
        <div className="h-2 rounded-full bg-mail-border">
          <div
            className="h-2 rounded-full bg-mail-accent transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="flex items-center justify-between mt-1">
          <span className="text-xs text-mail-text-muted">
            {migration.migrated_emails}/{totalTarget} emails ({percent}%)
          </span>
          {etaMinutes != null && (
            <span className="text-xs text-mail-text-muted">
              ETA: ~{etaMinutes} min
            </span>
          )}
        </div>
      </div>

      {/* Rate limit countdown */}
      {migration.status === 'rate_limited' && migration.rate_limit_remaining > 0 && (
        <RateLimitCountdown initialSeconds={migration.rate_limit_remaining} />
      )}

      {/* Current folder */}
      {migration.current_folder && (
        <div>
          <p className="text-sm text-mail-text">Current folder: {migration.current_folder}</p>
        </div>
      )}

      {/* Live log */}
      <LiveLogSection />

      {/* Folder checklist */}
      {migration.folders && migration.folders.length > 0 && (
        <div className="max-h-48 overflow-y-auto space-y-1">
          {migration.folders.map((folder, i) => {
            let Icon = Circle;
            let iconClass = 'text-mail-border';
            if (folder.status === 'completed') { Icon = CheckCircle2; iconClass = 'text-mail-success'; }
            else if (folder.status === 'in_progress') { Icon = Loader; iconClass = 'text-mail-accent animate-spin'; }
            else if (folder.status === 'failed') { Icon = XCircle; iconClass = 'text-mail-danger'; }

            return (
              <div key={i} className="flex items-center gap-2 text-sm py-1">
                <Icon size={16} className={iconClass} />
                <span className="flex-1 text-mail-text">{folder.name}</span>
                <span className="text-xs text-mail-text-muted">
                  {folder.status === 'in_progress'
                    ? `${folder.done || 0}/${folder.total || 0}`
                    : folder.status === 'failed'
                      ? `${folder.failed || 0} failed`
                      : `${folder.total || folder.email_count || 0}`}
                </span>
                {folder.skipped > 0 && (
                  <span className="text-xs text-mail-text-muted">({folder.skipped} duplicates skipped)</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-3 pt-2">
        {isPaused ? (
          <button
            onClick={() => {
              if (srcAccount && dstAccount) onResume(srcAccount, dstAccount);
            }}
            className="bg-mail-accent text-white rounded-lg px-4 py-2 text-sm font-semibold flex items-center gap-2"
          >
            <Play size={14} /> Resume
          </button>
        ) : isPausing ? (
          <button disabled className="bg-mail-surface border border-mail-border rounded-lg px-4 py-2 text-sm font-semibold opacity-70 flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" /> Pausing...
          </button>
        ) : (
          <button
            onClick={() => { setIsPausing(true); onPause(); }}
            className="bg-mail-warning/10 text-mail-warning rounded-lg px-4 py-2 text-sm font-semibold hover:bg-mail-warning/20 flex items-center gap-2"
          >
            <Pause size={14} /> Pause
          </button>
        )}
        {showCancelConfirm ? (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40">
            <div className="bg-mail-surface border border-mail-border rounded-xl shadow-xl p-4 w-80 space-y-3">
              <h4 className="text-sm font-semibold text-mail-text">Cancel migration?</h4>
              <p className="text-xs text-mail-text-muted">Migration will stop. Choose what to do with emails already copied to the destination.</p>
              <p className="text-xs text-mail-text-muted italic">Removal is best-effort. If the connection drops, some emails may remain at the destination.</p>
              {cancelRemoveError && (
                <p className="text-xs text-mail-danger">{cancelRemoveError}</p>
              )}
              <div className="flex items-center gap-2">
                <button onClick={() => onConfirmCancel('keep')} className="text-xs px-3 py-1.5 rounded bg-mail-surface border border-mail-border text-mail-text">Keep emails</button>
                <button onClick={() => onConfirmCancel('remove')} disabled={cancelRemoving} className="text-xs px-3 py-1.5 rounded bg-mail-danger text-white flex items-center gap-1">
                  {cancelRemoving && <Loader2 size={10} className="animate-spin" />}
                  Remove emails
                </button>
                <button onClick={onCancelCancel} className="text-xs text-mail-text-muted ml-auto">Go back</button>
              </div>
            </div>
          </div>
        ) : (
          <button
            onClick={onCancel}
            className="text-sm text-mail-danger hover:text-mail-danger/80"
          >
            Cancel Migration
          </button>
        )}
      </div>
    </div>
  );
}

function CompletionView({ migration, onDone }) {
  const isFailed = migration.status === 'failed';
  const isCancelled = migration.status === 'cancelled';

  return (
    <div className="flex flex-col items-center justify-center py-12">
      {isFailed ? (
        <XCircle size={48} className="text-mail-danger mb-4" />
      ) : (
        <CheckCircle2 size={48} className="text-mail-success mb-4" />
      )}
      <h4 className="text-base font-semibold text-mail-text mb-2">
        {isFailed ? 'Migration Failed' : isCancelled ? 'Migration Cancelled' : 'Migration Complete'}
      </h4>
      <p className="text-sm text-mail-text-muted mb-1">
        {migration.migrated_emails} emails migrated across {migration.folders?.length || 0} folders in {formatDuration(migration.elapsed_seconds)}
      </p>
      {migration.skipped_emails > 0 && (
        <p className="text-xs text-mail-text-muted">{migration.skipped_emails} duplicates skipped</p>
      )}
      {migration.failed_emails > 0 && (
        <p className="text-xs text-mail-danger">{migration.failed_emails} emails failed</p>
      )}
      <button
        onClick={onDone}
        className="bg-mail-accent text-white rounded-lg px-4 py-2 text-sm font-semibold mt-6"
      >
        Done
      </button>
    </div>
  );
}
