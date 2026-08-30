import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import {
  ArrowRight, ArrowLeftRight, Check, CheckCircle2, Circle,
  Loader, XCircle, AlertCircle, Folder, Lock,
  ChevronDown, ChevronRight, X, Play, Pause, Loader2
} from 'lucide-react';
import { useSettingsStore, getAccountInitial, getAccountColor, hasPremiumAccess } from '../../stores/settingsStore.js';
import { useMailStore } from '../../stores/mailStore.js';
import { useAccountStore } from '../../stores/accountStore.js';
import * as api from '../../services/api.js';
import { ensureFreshToken } from '../../services/authUtils.js';
import { migrationManager } from '../../services/migrationManager.js';
import { formatDateTime } from '../../utils/dateFormat.js';
import { IS_APPSTORE_BUILD } from '../../utils/buildFlags.js';
import { usePremiumPriceBlurb } from '../../hooks/usePremiumPricing.js';
import { decodeImapUtf7 } from '../../utils/imapUtf7';
import { t, useT  } from '../../i18n/index.js';

function formatDuration(secs) {
  if (!secs || secs < 1) return '< 1s';
  if (secs < 60) return '< 1 min';
  if (secs < 3600) return t('settings.migration.min', { Math: Math.floor(secs / 60) });
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return m > 0 ? t('settings.migration.hM', { h, m }) : t('settings.migration.h', { h });
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
                    ? 'bg-mail-accent-fill text-white'
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
  const t = useT();
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
        {transport === 'graph' ? t('settings.migration.graph') : 'IMAP'}
      </span>
    </button>
  );
}

export default function MigrationSettings({ onUpgrade }) {
  const t = useT();
  const priceBlurb = usePremiumPriceBlurb();
  const billingProfile = useSettingsStore(s => s.billingProfile);
  const isPaidUser = hasPremiumAccess(billingProfile);
  const activeMigration = useSettingsStore(s => s.activeMigration);
  const migrationHistory = useSettingsStore(s => s.migrationHistory);
  const incompleteMigration = useSettingsStore(s => s.incompleteMigration);
  const rawAccounts = useAccountStore(s => s.accounts);
  const accountColors = useSettingsStore(s => s.accountColors);
  const getOrderedAccounts = useSettingsStore(s => s.getOrderedAccounts);
  const accounts = getOrderedAccounts(rawAccounts);
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
  const [includeLocalArchive, setIncludeLocalArchive] = useState(false);
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
        if (!cancelled) setError(t('settings.migration.failedLoadFolders') + (err.message || err));
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
  // Use live folder counts from background counting events, fall back to mapping email_count
  const totalEmails = selectedMappings.reduce((sum, m) => {
    const live = folderCounts?.[m.source_path];
    const count = live ? (live.count || 0) : (m.email_count || 0);
    return sum + count;
  }, 0);
  const isCounting = Object.values(folderCounts || {}).some(v => v?.counting);
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
      setError(t('settings.migration.failedRefreshAuthenticationPleaseRe', { err: err.account?.email || 'an account' }));
      setStarting(false);
      return;
    }
    try {
      await api.startMigration(
        sourceAccount, destAccount,
        getTransport(sourceAccount), getTransport(destAccount),
        selectedMappings,
        includeLocalArchive
      );
    } catch (err) {
      setError(t('settings.migration.failedStartMigration') + (err.message || err));
    } finally {
      setStarting(false);
    }
  }, [sourceAccount, destAccount, selectedMappings]);

  const handlePause = useCallback(async () => {
    console.log('[migration] handlePause called, invoking api.pauseMigration()');
    try {
      await api.pauseMigration();
      console.log('[migration] pauseMigration() succeeded');
      // If migration isn't actively running (no new events arrive to set status='paused'),
      // update the store directly so UI reflects the pause
      setTimeout(() => {
        const current = useSettingsStore.getState().activeMigration;
        if (current && current.status !== 'paused') {
          useSettingsStore.getState().setActiveMigration({ ...current, status: 'paused' });
        }
      }, 3000);
    } catch (e) {
      console.error('[migration] Pause failed:', e);
      setError(t('settings.migration.failedPauseMigration') + (e.message || e));
    }
  }, []);

  const [cancelRemoving, setCancelRemoving] = useState(false);
  const [cancelRemoveError, setCancelRemoveError] = useState(null);

  const handleCancel = useCallback(async (choice) => {
    console.log('[migration] handleCancel called with choice:', choice);
    try {
      await api.cancelMigration();
      console.log('[migration] cancelMigration() succeeded');
    } catch (e) {
      console.error('[migration] Cancel failed:', e);
      setError(t('settings.migration.failedCancelMigration') + (e.message || e));
    }
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
    useSettingsStore.getState().clearActiveMigration();
    useSettingsStore.getState().clearIncompleteMigration();
    setShowCancelConfirm(false);
  }, [activeMigration]);

  const handleResume = useCallback(async (srcAccount, dstAccount) => {
    setError(null);
    try {
      await ensureFreshToken(srcAccount);
      await ensureFreshToken(dstAccount);
    } catch (err) {
      setError(t('settings.migration.failedRefreshAuthenticationPleaseRe2'));
      return;
    }
    try {
      await api.resumeMigration(srcAccount, dstAccount, getTransport(srcAccount), getTransport(dstAccount));
    } catch (err) {
      setError(t('settings.migration.failedResumeMigration') + (err.message || err));
    }
  }, []);

  const handleDone = useCallback(() => {
    // Refresh destination account so migrated emails/folders appear
    const destId = activeMigration?.dest_email;
    const destAcc = accounts.find(a => a.email === destId);
    if (destAcc) {
      const { setActiveAccount } = useMailStore.getState();
      // Trigger a full reload by re-activating the destination account
      setActiveAccount(destAcc.id);
    }
    useSettingsStore.getState().clearActiveMigration();
    setStep(1);
    setSourceAccount(null);
    setDestAccount(null);
    setFolderMappings([]);
    setSelectedFolders(new Set());
    setIncludeLocalArchive(false);
  }, [activeMigration, accounts]);

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
                {t('settings.migration.incompleteFoldersCompleted', { completed: incompleteMigration.completed_folders || 0, total: incompleteMigration.total_folders || 0 })}
              </p>
              {showDiscardConfirm ? (
                <div className="bg-mail-surface rounded-lg p-3">
                  <p className="text-sm text-mail-text mb-3">{t('settings.migration.discardIncompleteMigrationProgressWill')}</p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        migrationManager.discardIncompleteMigration();
                        setShowDiscardConfirm(false);
                      }}
                      className="text-sm text-mail-danger hover:text-mail-danger/80"
                    >
                      {t('common.discard')}
                    </button>
                    <Button variant="ghost" size="sm" className="p-0"
                      onClick={() => setShowDiscardConfirm(false)}
                    >
                      {t('settings.migration.keep')}
                    </Button>
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
                    className="bg-mail-accent-fill text-white rounded-lg px-4 py-2 text-sm font-semibold"
                  >
                    {t('settings.migration.resumeMigration')}
                  </button>
                  <Button variant="ghost" size="sm" className="p-0"
                    onClick={() => setShowDiscardConfirm(true)}
                  >
                    {t('common.discard')}
                  </Button>
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

          {/* Server-only explanation */}
          {step === 1 && (
            <div className="bg-mail-surface/50 border border-mail-border rounded-lg p-3 mb-2">
              <p className="text-xs text-mail-text-muted">
                {t('settings.migration.copiesEmailsBetweenServers')}
              </p>
            </div>
          )}

          <AnimatePresence mode="wait">
            {step === 1 && (
              <motion.div key="step1" {...stepAnimation}>
                <h4 className="text-sm font-semibold text-mail-text mb-1">{t('settings.migration.selectSourceAccount')}</h4>
                <p className="text-xs text-mail-text-muted mb-4">{t('settings.migration.chooseAccountMigrateEmails')}</p>
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
                <h4 className="text-sm font-semibold text-mail-text mb-1">{t('settings.migration.selectDestinationAccount')}</h4>
                <p className="text-xs text-mail-text-muted mb-4">{t('settings.migration.chooseWhereMigrateEmails')}</p>
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
                <h4 className="text-sm font-semibold text-mail-text mb-1">{t('settings.migration.selectFoldersMigrate')}</h4>
                <p className="text-xs text-mail-text-muted mb-4">{t('settings.migration.allFoldersSelectedDefault')}</p>

                {loadingFolders ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader size={24} className="animate-spin text-mail-accent-text" />
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
                      <span className="text-sm text-mail-text">{t('settings.migration.selectAll')}</span>
                      <span className="text-xs text-mail-text-muted ml-auto">{t('common.folderCount', { count: folderMappings.length })}</span>
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
                                  ? t('settings.migration.counting', { folderCounts: folderCounts[mapping.source_path].count })
                                  : t('settings.migration.emails2', { folderCounts: folderCounts[mapping.source_path].count })
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
                <h4 className="text-sm font-semibold text-mail-text mb-4">{t('settings.migration.reviewMigration')}</h4>

                {/* Summary card */}
                <div className="bg-mail-surface rounded-lg p-4 space-y-3 mb-4">
                  <SummaryRow label="Source" account={sourceAccount} accountColors={accountColors} />
                  <SummaryRow label="Destination" account={destAccount} accountColors={accountColors} />
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-mail-text-muted">{t('settings.migration.folders')}</span>
                    <span className="text-mail-text">{t('common.folderCount', { count: selectedMappings.length })}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-mail-text-muted">{t('settings.migration.emails')}</span>
                    <span className="text-mail-text">
                      {isCounting ? t('settings.migration.emailsCounting', { totalEmails: totalEmails.toLocaleString() }) : `~${totalEmails.toLocaleString()} emails`}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-mail-text-muted">{t('settings.migration.estimatedTime')}</span>
                    <span className="text-mail-text">{t('settings.migration.approxMinutes', { etaMinutes })}</span>
                  </div>
                </div>

                {/* Include local archive option */}
                <div className="bg-mail-surface rounded-lg p-3 mb-4">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeLocalArchive}
                      onChange={(e) => setIncludeLocalArchive(e.target.checked)}
                      className="mt-0.5 accent-mail-accent"
                    />
                    <div>
                      <span className="text-sm text-mail-text font-medium">{t('settings.migration.includeEmailsVault')}</span>
                      <p className="text-xs text-mail-text-muted mt-0.5">
                        {t('settings.migration.alsoUploadEmlFilesVault')}
                      </p>
                    </div>
                  </label>
                </div>

                {/* Folder mapping table */}
                <div className="max-h-60 overflow-y-auto">
                  <div className="grid grid-cols-[1fr_auto_1fr] gap-2 text-xs text-mail-text-muted font-medium mb-2 px-2">
                    <span>{t('settings.migration.sourceFolder')}</span>
                    <span />
                    <span>{t('settings.migration.destinationFolder')}</span>
                  </div>
                  {selectedMappings.map((mapping, i) => (
                    <div key={i} className="grid grid-cols-[1fr_auto_1fr] gap-2 items-center text-sm px-2 py-1.5 rounded hover:bg-mail-surface-hover">
                      <span className="text-mail-text truncate">{decodeImapUtf7(mapping.source_path)}</span>
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
              <Button variant="secondary" className="bg-transparent"
                onClick={() => setStep(s => s - 1)}
              >
                {t('settings.migration.back')}
              </Button>
            ) : <div />}
            <button
              onClick={step === 4 ? handleStartMigration : () => setStep(s => s + 1)}
              disabled={!canGoNext || starting}
              className={`bg-mail-accent-fill text-white rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                !canGoNext || starting ? 'opacity-50 cursor-not-allowed' : 'hover:bg-mail-accent-hover'
              }`}
            >
              {starting ? (
                <span className="flex items-center gap-2">
                  <Loader size={14} className="animate-spin" />
                  {t('settings.migration.starting')}
                </span>
              ) : step === 4 ? t('settings.migration.startMigration') : t('bulk.ops.next')}
            </button>
          </div>
        </>
      )}

      {/* Migration History */}
      <div className="mt-6">
        <h4 className="text-sm font-semibold text-mail-text mb-3">{t('settings.migration.migrationHistory')}</h4>
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
                    {formatDateTime(entry.completedAt)}
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-sm font-semibold text-mail-text">{t('common.emailCount', { count: entry.migratedEmails })}</div>
                  <div className="text-xs text-mail-text-muted">{formatDuration(entry.duration)}</div>
                </div>
                <StatusBadge status={entry.status} />
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-8">
            <h5 className="text-sm font-semibold text-mail-text mb-1">{t('settings.migration.noMigrationsYet')}</h5>
            <p className="text-xs text-mail-text-muted max-w-[280px] mx-auto">
              {t('settings.migration.selectSourceDestinationAccountMove')}
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
              <div className="w-12 h-12 rounded-full bg-mail-accent-tint border border-mail-accent/30 flex items-center justify-center">
                <ArrowLeftRight size={20} className="text-mail-accent-text" />
              </div>
              <div>
                <p className="text-sm font-semibold text-mail-text mb-1">{t('common.premiumFeature')}</p>
                <p className="text-xs text-mail-text-muted text-center max-w-[280px]">
                  {t('settings.migration.mailboxMigrationLetsMoveEmails')}
                </p>
                {/* MAS builds must not advertise the web subscription — no external
                    purchase price, no path to Stripe checkout. */}
                {!IS_APPSTORE_BUILD && (
                  <p className="text-xs text-mail-text-muted mt-1">{priceBlurb}</p>
                )}
              </div>
              {!IS_APPSTORE_BUILD && onUpgrade && (
                <Button variant="primary" size="sm" pill className="text-xs font-semibold" onClick={onUpgrade}>
                  {t('common.upgrade')}
                </Button>
              )}
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
  const t = useT();
  const styles = {
    completed: 'text-mail-success bg-mail-success/10',
    failed: 'text-mail-danger bg-mail-danger/10',
    cancelled: 'text-mail-text-muted bg-mail-border',
  };
  const labels = { completed: t('settings.migration.completed'), failed: t('settings.migration.failed'), cancelled: t('settings.migration.cancelled') };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${styles[status] || styles.cancelled}`}>
      {labels[status] || status}
    </span>
  );
}

function LiveLogSection() {
  const t = useT();
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
        {t('settings.migration.liveLog')}
      </button>
      {expanded && (
        <div ref={containerRef} onScroll={handleScroll} className="max-h-48 overflow-y-auto font-mono text-xs p-2 space-y-1">
          {logEntries.length === 0 ? (
            <p className="text-mail-text-muted italic">{t('settings.migration.logEntriesWillAppearHere')}</p>
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
  const t = useT();
  const [seconds, setSeconds] = useState(initialSeconds);
  useEffect(() => { setSeconds(initialSeconds); }, [initialSeconds]);
  useEffect(() => {
    if (seconds <= 0) return;
    const timer = setTimeout(() => setSeconds(s => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [seconds]);
  if (seconds <= 0) return null;
  return <p className="text-xs text-mail-warning font-semibold">{t('settings.migration.rateLimitedRetryingIn', { seconds })}</p>;
}

function ProgressView({ migration, accounts, accountColors, onPause, onResume, onCancel, showCancelConfirm, onConfirmCancel, onCancelCancel, cancelRemoving, cancelRemoveError }) {
  const t = useT();
  const isPaused = migration.status === 'paused';
  const [isPausing, setIsPausing] = useState(false);
  const srcAccount = accounts.find(a => a.email === migration.source_email);
  const dstAccount = accounts.find(a => a.email === migration.dest_email);

  // Clear isPausing when status changes to paused, or after 5s timeout
  useEffect(() => {
    if (isPaused) setIsPausing(false);
  }, [isPaused]);
  useEffect(() => {
    if (!isPausing) return;
    const t = setTimeout(() => setIsPausing(false), 5000);
    return () => clearTimeout(t);
  }, [isPausing]);

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
            {t('settings.migration.emailsProgressPercent', { migrated: migration.migrated_emails, totalTarget, percent })}
          </span>
          {etaMinutes != null && (
            <span className="text-xs text-mail-text-muted">
              {t('settings.migration.etaMinutes', { etaMinutes })}
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
          <p className="text-sm text-mail-text">{t('settings.migration.currentFolder', { folder: decodeImapUtf7(migration.current_folder) })}</p>
        </div>
      )}

      {/* Live log */}
      <LiveLogSection />

      {/* Folder checklist */}
      {migration.folders && migration.folders.length > 0 && (
        <div className="max-h-48 overflow-y-auto space-y-1">
          {migration.folders.map((folder, i) => {
            const migrationPaused = migration.status === 'paused';
            let Icon = Circle;
            let iconClass = 'text-mail-border';
            if (folder.status === 'completed') { Icon = CheckCircle2; iconClass = 'text-mail-success'; }
            else if (folder.status === 'in_progress') {
              if (migrationPaused) { Icon = Pause; iconClass = 'text-mail-warning'; }
              else { Icon = Loader; iconClass = 'text-mail-accent-text animate-spin'; }
            }
            else if (folder.status === 'failed') { Icon = XCircle; iconClass = 'text-mail-danger'; }

            const folderName = decodeImapUtf7(folder.source_path || folder.name || folder.dest_path) || 'Unknown';

            return (
              <div key={i} className="flex items-center gap-2 text-sm py-1">
                <Icon size={16} className={iconClass} />
                <span className="flex-1 text-mail-text truncate">{folderName}</span>
                <span className="text-xs text-mail-text-muted">
                  {folder.status === 'in_progress'
                    ? `${folder.done || 0}/${folder.total || 0}`
                    : folder.status === 'failed'
                      ? t('settings.migration.failed2', { folder: folder.failed || 0 })
                      : `${folder.total || folder.email_count || 0}`}
                </span>
                {folder.skipped > 0 && (
                  <span className="text-xs text-mail-text-muted">{t('settings.migration.duplicatesSkippedParen', { count: folder.skipped })}</span>
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
            className="bg-mail-accent-fill text-white rounded-lg px-4 py-2 text-sm font-semibold flex items-center gap-2"
          >
            <Play size={14} /> {t('common.resume')}
          </button>
        ) : isPausing ? (
          <button disabled className="bg-mail-surface border border-mail-border rounded-lg px-4 py-2 text-sm font-semibold opacity-70 flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" /> {t('settings.migration.pausing')}
          </button>
        ) : (
          <Button
            onClick={() => { setIsPausing(true); onPause(); }}
            className="bg-mail-warning-tint text-mail-warning font-semibold hover:bg-mail-warning/20"
          >
            <Pause size={14} /> {t('settings.migration.pause')}
          </Button>
        )}
        <Dialog
          open={showCancelConfirm}
          onClose={onCancelCancel}
          role="alertdialog"
          size="sm"
          panelBg="bg-mail-surface"
          title={t('settings.migration.cancelMigration')}
          description="Migration will stop. Choose what to do with emails already copied to the destination."
          footer={
            <div className="flex items-center gap-2 w-full">
              <Button variant="secondary" size="sm" onClick={() => onConfirmCancel('keep')}>{t('settings.migration.keepEmails')}</Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => onConfirmCancel('remove')}
                loading={cancelRemoving}
              >
                {t('settings.migration.removeEmails')}
              </Button>
              <Button variant="ghost" size="sm" onClick={onCancelCancel} className="ml-auto" data-autofocus>{t('settings.migration.goBack')}</Button>
            </div>
          }
        >
          <p className="text-xs text-mail-text-muted italic">{t('settings.migration.removalBestEffortIfConnection')}</p>
          {cancelRemoveError && (
            <p className="text-xs text-mail-danger">{cancelRemoveError}</p>
          )}
        </Dialog>
        {!showCancelConfirm && (
          <Button variant="link" size="sm" className="text-sm" onClick={onCancel}>
            {t('settings.migration.cancelMigration2')}
          </Button>
        )}
      </div>
    </div>
  );
}

function CompletionView({ migration, onDone }) {
  const t = useT();
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
        {isFailed ? t('settings.migration.migrationFailed') : isCancelled ? t('settings.migration.migrationCancelled') : t('settings.migration.migrationComplete')}
      </h4>
      <p className="text-sm text-mail-text-muted mb-1">
        {t('settings.migration.emailsMigratedAcrossFolders', { emails: migration.migrated_emails, folders: migration.folders?.length || 0, duration: formatDuration(migration.elapsed_seconds) })}
      </p>
      {migration.skipped_emails > 0 && (
        <p className="text-xs text-mail-text-muted">{t('settings.migration.duplicatesSkipped', { count: migration.skipped_emails })}</p>
      )}
      {migration.failed_emails > 0 && (
        <p className="text-xs text-mail-danger">{t('settings.migration.emailsFailed', { count: migration.failed_emails })}</p>
      )}
      <button
        onClick={onDone}
        className="bg-mail-accent-fill text-white rounded-lg px-4 py-2 text-sm font-semibold mt-6"
      >
        {t('common.done')}
      </button>
    </div>
  );
}
