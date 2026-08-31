import { Button } from '../ui/Button';
import React, { useState, useEffect } from 'react';
import { useMailStore } from '../../stores/mailStore';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import { motion, AnimatePresence } from 'framer-motion';
import { runCleanupRules } from '../../services/cleanupEngine';
import { ToggleSwitch } from './ToggleSwitch';
import { IS_APPSTORE_BUILD } from '../../utils/buildFlags';
import { usePremiumPriceBlurb } from '../../hooks/usePremiumPricing.js';
import {
  FolderOpen,
  HardDrive,
  Shield,
  Trash2,
  Database,
  Loader,
  Clock,
  Plus,
  Play,
  Pencil,
  AlertTriangle,
} from 'lucide-react';
import { decodeImapUtf7 } from '../../utils/imapUtf7';
import { ConfirmDialog } from '../ConfirmDialog';
import { t, useT  } from '../../i18n/index.js';

export function StorageSettings({ accounts, onUpgrade }) {
  const t = useT();
  const priceBlurb = usePremiumPriceBlurb();
  // A native confirm() can only offer OK/Cancel, so the button on the most
  // destructive action in the app could not name what it was about to erase.
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const {
    localStoragePath,
    setLocalStoragePath,
    localCacheDurationMonths,
    setLocalCacheDurationMonths,
    hiddenAccounts,
    billingProfile,
    cleanupRules,
    addCleanupRule,
    updateCleanupRule,
    removeCleanupRule,
    toggleCleanupRule,
    cleanupRulesDisarmed,
    dismissCleanupRulesDisarmed,
  } = useSettingsStore();
  const isPaidUser = hasPremiumAccess(billingProfile);

  const [movingStorage, setMovingStorage] = useState(false);
  const [supportsFileSystem, setSupportsFileSystem] = useState(false);
  const [localStorageUsage, setLocalStorageUsage] = useState(null);
  const [clearingCache, setClearingCache] = useState(false);
  const [clearCacheConfirm, setClearCacheConfirm] = useState(false);
  const [clearCacheResult, setClearCacheResult] = useState(null);
  const [cleanupForm, setCleanupForm] = useState(null); // null | { mode: 'add' } | { mode: 'edit', id }
  const [cleanupAccount, setCleanupAccount] = useState('all');
  const [cleanupFolder, setCleanupFolder] = useState('INBOX');
  const [cleanupAge, setCleanupAge] = useState(30);
  const [cleanupUnit, setCleanupUnit] = useState('days');
  const [cleanupAction, setCleanupAction] = useState('delete');
  const [cleanupDeleteConfirm, setCleanupDeleteConfirm] = useState(null);
  const [showCleanupFirstTimeWarning, setShowCleanupFirstTimeWarning] = useState(false);
  const [cleanupRunning, setCleanupRunning] = useState(false);
  const [cleanupResult, setCleanupResult] = useState(null);
  const [orphanStats, setOrphanStats] = useState(null);
  const [purgingOrphans, setPurgingOrphans] = useState(false);
  const [purgeOrphansConfirm, setPurgeOrphansConfirm] = useState(false);

  const invoke = window.__TAURI__?.core?.invoke;

  // Check for File System Access API support
  useEffect(() => {
    setSupportsFileSystem('showDirectoryPicker' in window);
  }, []);

  // Load local storage usage
  useEffect(() => {
    const loadStorageUsage = async () => {
      try {
        const { getStorageUsage, getVaultOrphanStats } = await import('../../services/db');
        const [usage, orphans] = await Promise.all([getStorageUsage(), getVaultOrphanStats()]);
        setLocalStorageUsage(usage);
        setOrphanStats(orphans);
      } catch (error) {
        console.error('Failed to get storage usage:', error);
      }
    };
    loadStorageUsage();
  }, []);

  const handleSelectFolder = async () => {
    if (!supportsFileSystem) {
      return;
    }

    try {
      const dirHandle = await window.showDirectoryPicker({
        mode: 'readwrite'
      });

      const newPath = dirHandle.name;

      // No confirm() here any more. It asked "Do you want to move all existing
      // emails and settings to the new folder?" and then ran
      // setLocalStoragePath(newPath) either way — the only thing the answer
      // changed was whether a 500ms spinner appeared first. A question the app
      // does not act on teaches people that these prompts do not matter.
      if (localStoragePath && localStoragePath !== newPath) {
        setMovingStorage(true);
        setTimeout(() => {
          setLocalStoragePath(newPath);
          setMovingStorage(false);
        }, 500);
        return;
      }

      setLocalStoragePath(newPath);
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Folder selection error:', err);
      }
    }
  };

  return (
    <div className="p-6 space-y-6">
      {/* Current Storage Status */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <Database size={18} className="text-mail-accent-text" />
          {t('settings.storage.storageStatus')}
        </h4>

        <div className="flex items-center gap-3 p-3 bg-mail-local-tint border border-mail-local/20 rounded-lg mb-4">
          <div className="w-3 h-3 bg-mail-success rounded-full animate-pulse" />
          <span className="text-sm text-mail-text">
            {t('settings.storage.emailsStoredSecurelyLocalStorage')}
          </span>
        </div>

        <p className="text-sm text-mail-text-muted">
          {t('settings.storage.ordinaryFilesNothingUploaded')}
        </p>
      </div>

      {/* Local Email Caching */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <HardDrive size={18} className="text-mail-accent-text" />
          {t('settings.storage.localEmailCaching')}
        </h4>

        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-3">
              <label className="text-sm font-medium text-mail-text">
                {t('settings.storage.cacheDuration')}
              </label>
              <span className="text-sm font-medium text-mail-accent-text">
                {localCacheDurationMonths === 0 ? t('settings.storage.allEmails') :
                 localCacheDurationMonths === 1 ? t('settings.storage.month1') :
                 localCacheDurationMonths === 12 ? t('settings.storage.year1') :
                 t('settings.storage.monthsCount', { count: localCacheDurationMonths })}
              </span>
            </div>

            {/* Slider - 5 steps: 1, 3, 6, 12 months, All */}
            <div className="relative">
              <input
                type="range"
                min="0"
                max="4"
                value={
                  localCacheDurationMonths === 1 ? 0 :
                  localCacheDurationMonths === 3 ? 1 :
                  localCacheDurationMonths === 6 ? 2 :
                  localCacheDurationMonths === 12 ? 3 : 4
                }
                onChange={(e) => {
                  const steps = [1, 3, 6, 12, 0]; // 0 = All
                  setLocalCacheDurationMonths(steps[parseInt(e.target.value)]);
                }}
                className="w-full"
              />

              {/* Tick marks */}
              <div className="flex justify-between mt-1 px-1">
                <span className="text-[10px] text-mail-text-muted">{t('settings.storage.mo1')}</span>
                <span className="text-[10px] text-mail-text-muted">{t('settings.storage.mo3')}</span>
                <span className="text-[10px] text-mail-text-muted">{t('settings.storage.mo6')}</span>
                <span className="text-[10px] text-mail-text-muted">{t('settings.storage.year1')}</span>
                <span className="text-[10px] text-mail-text-muted">{t('settings.storage.all')}</span>
              </div>
            </div>
          </div>

          {/* Local storage usage */}
          <div className="flex items-center justify-between p-3 bg-mail-bg rounded-lg">
            <div>
              <div className="text-sm text-mail-text">{t('settings.storage.localStorageUsage')}</div>
              <div className="text-xs text-mail-local">
                {localStorageUsage ? (
                  <>
                    {(localStorageUsage.totalMB || 0) >= 1024
                      ? t('settings.storage.gb', { localStorageUsage: ((localStorageUsage.totalMB || 0) / 1024).toFixed(2) })
                      : (localStorageUsage.totalMB || 0) >= 1
                      ? t('settings.storage.mb', { localStorageUsage: (localStorageUsage.totalMB || 0).toFixed(2) })
                      : t('settings.storage.kb', { localStorageUsage: ((localStorageUsage.totalMB || 0) * 1024).toFixed(0) })}
                    {' '}{t('settings.storage.emailsSavedParen', { count: (localStorageUsage.emailCount || 0).toLocaleString() })}
                  </>
                ) : (
                  'Calculating...'
                )}
              </div>
            </div>
          </div>

          {/* Messages from a previous server generation.
              A UID reissue (change of mail host, or one the server did itself)
              re-numbers a mailbox, so the vault's copies get re-bound to their
              new UIDs by Message-ID. What has no match is not on the server at
              all — the vault may be its only copy — so it is moved aside rather
              than deleted, and deleting it is left to the person whose mail it
              is. Hidden entirely when there is nothing set aside. */}
          {orphanStats?.count > 0 && (
            <div className="flex items-center justify-between p-3 bg-mail-bg rounded-lg">
              <div className="pr-4">
                <div className="text-sm text-mail-text">{t('settings.storage.messagesPreviousServer')}</div>
                <div className="text-xs text-mail-text-muted">
                  {t('settings.storage.savedOrphans', { count: orphanStats.count })}
                  {' '}{t('settings.storage.orphanBytesKeptInVault', { mb: (orphanStats.bytes / (1024 * 1024)).toFixed(1) })}
                </div>
              </div>
              {!purgeOrphansConfirm ? (
                <button
                  onClick={() => setPurgeOrphansConfirm(true)}
                  disabled={purgingOrphans}
                  className="flex items-center gap-2 shrink-0 px-3 py-1.5 text-sm font-medium rounded-lg border border-mail-danger text-mail-danger hover:bg-mail-danger-tint transition-colors disabled:opacity-50"
                >
                  <Trash2 size={14} />
                  {t('common.delete')}
                </button>
              ) : (
                <div className="flex items-center gap-2 shrink-0">
                  <Button variant="secondary" size="sm" className="bg-transparent text-mail-text-muted hover:bg-mail-surface"
                    onClick={() => setPurgeOrphansConfirm(false)}
                    disabled={purgingOrphans}
                  >
                    {t('common.cancel')}
                  </Button>
                  <Button variant="danger" size="sm"
                    onClick={async () => {
                      if (purgingOrphans) return;
                      setPurgingOrphans(true);
                      try {
                        const { purgeVaultOrphans, getVaultOrphanStats, getStorageUsage } = await import('../../services/db');
                        await purgeVaultOrphans();
                        const [orphans, usage] = await Promise.all([getVaultOrphanStats(), getStorageUsage()]);
                        setOrphanStats(orphans);
                        setLocalStorageUsage(usage);
                      } catch (error) {
                        console.error('Failed to delete previous-server messages:', error);
                      } finally {
                        setPurgingOrphans(false);
                        setPurgeOrphansConfirm(false);
                      }
                    }}
                    disabled={purgingOrphans}
                  >
                    {purgingOrphans ? <Loader size={14} className="animate-spin" /> : <Trash2 size={14} />}
                    {t('settings.storage.deletePermanently')}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Clear cache */}
          <div className="flex items-center justify-between p-3 bg-mail-bg rounded-lg">
            <div>
              <div className="text-sm text-mail-text">{t('settings.storage.clearCachedEmails')}</div>
              <div className="text-xs text-mail-text-muted">
                {t('settings.storage.removesAllCachedEmlFiles')}
              </div>
            </div>
            {!clearCacheConfirm ? (
              <button
                onClick={() => { setClearCacheConfirm(true); setClearCacheResult(null); }}
                disabled={clearingCache}
                className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg border border-mail-danger text-mail-danger hover:bg-mail-danger-tint transition-colors disabled:opacity-50"
              >
                <Trash2 size={14} />
                {t('settings.storage.clearCache')}
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" className="bg-transparent text-mail-text-muted hover:bg-mail-surface"
                  onClick={() => setClearCacheConfirm(false)}
                  disabled={clearingCache}
                >
                  {t('common.cancel')}
                </Button>
                <Button variant="danger" size="sm"
                  onClick={async () => {
                    if (clearingCache) return;
                    setClearingCache(true);
                    setClearCacheResult(null);
                    try {
                      const invoke = window.__TAURI__?.core?.invoke;
                      if (!invoke) return;

                      // Stop all pipelines
                      const { pipelineManager } = await import('../../services/EmailPipelineManager');
                      pipelineManager.destroyAll();

                      // Clear .eml files (preserving archived)
                      const result = await invoke('maildir_clear_cache');

                      // Clear headers cache files
                      await invoke('clear_email_cache', { accountId: null });

                      // Clear in-memory cache and reset emails array so coordinator hook re-triggers
                      useMailStore.getState().clearEmailCache();
                      useMailStore.setState({ emails: [], sortedEmails: [], localEmails: [], totalEmails: 0, loadedRanges: [], currentPage: 0, hasMoreEmails: true, sentEmails: [] });

                      setClearCacheResult(result);

                      // Refresh storage usage
                      const { getStorageUsage } = await import('../../services/db');
                      const usage = await getStorageUsage();
                      setLocalStorageUsage(usage);

                      // Re-load emails from server — this repopulates the store and lets the pipeline coordinator restart
                      const { activeAccountId, activeMailbox } = useMailStore.getState();
                      if (activeAccountId) {
                        useMailStore.getState().activateAccount(activeAccountId, activeMailbox || 'INBOX');
                      }
                    } catch (error) {
                      console.error('Failed to clear cache:', error);
                    } finally {
                      setClearingCache(false);
                      setClearCacheConfirm(false);
                    }
                  }}
                  disabled={clearingCache}
                >
                  {clearingCache ? (
                    <Loader size={14} className="animate-spin" />
                  ) : (
                    <Trash2 size={14} />
                  )}
                  {clearingCache ? t('settings.storage.clearing') : t('settings.storage.confirm')}
                </Button>
              </div>
            )}
          </div>
          {clearCacheResult && (
            <div className="text-xs text-mail-success px-1">
              {t('settings.storage.clearedCachedEmails', { count: clearCacheResult.deletedCount.toLocaleString() })}
              {clearCacheResult.skippedArchived > 0 && t('settings.storage.archivedPreservedSuffix', { count: clearCacheResult.skippedArchived.toLocaleString() })}
              {t('settings.storage.resyncStarted')}
            </div>
          )}
        </div>
      </div>

      {/* Auto-Cleanup Rules */}
      <div data-testid="settings-auto-cleanup" className="bg-mail-surface border border-mail-border rounded-xl p-5 relative overflow-hidden">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <Clock size={18} className="text-mail-accent-text" />
          Auto-Cleanup
          {!isPaidUser && (
            <span className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-mail-accent-fill text-white rounded-full">
              {t('common.premium')}
            </span>
          )}
        </h4>

        {!isPaidUser ? (
          /* Locked state for non-paid users */
          <div className="relative">
            {/* Blurred preview of what the UI looks like */}
            <div className="opacity-30 blur-[1px] pointer-events-none select-none" aria-hidden="true">
              <div className="space-y-2 mb-3">
                <div className="flex items-center justify-between p-2.5 bg-mail-bg rounded-lg">
                  <div className="flex items-center gap-3 text-sm text-mail-text">
                    <span>{t('settings.storage.inbox')}</span>
                    <span className="text-mail-text-muted">{t('settings.storage.allAccounts')}</span>
                    <span className="text-mail-text-muted">{t('settings.storage.olderThan90Days')}</span>
                    <span className="text-mail-text-muted">{t('settings.storage.archiveLocallyThenDelete')}</span>
                  </div>
                </div>
                <div className="flex items-center justify-between p-2.5 bg-mail-bg rounded-lg">
                  <div className="flex items-center gap-3 text-sm text-mail-text">
                    <span>{t('settings.storage.trash')}</span>
                    <span className="text-mail-text-muted">{t('settings.storage.allAccounts')}</span>
                    <span className="text-mail-text-muted">{t('settings.storage.olderThan30Days')}</span>
                    <span className="text-mail-text-muted">{t('settings.storage.deleteServer')}</span>
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <div className="px-3 py-1.5 text-sm bg-mail-accent/10 text-mail-accent-text rounded-lg">{t('settings.storage.addRule')}</div>
                <div className="px-3 py-1.5 text-sm bg-mail-surface-hover text-mail-text rounded-lg">{t('settings.storage.runAllNow')}</div>
              </div>
            </div>

            {/* Lock overlay */}
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-mail-surface/60 backdrop-blur-[1px] rounded-lg">
              <div className="flex flex-col items-center gap-3 text-center px-6">
                <div className="w-12 h-12 rounded-full bg-mail-accent-tint border border-mail-accent/30 flex items-center justify-center">
                  <Clock size={20} className="text-mail-accent-text" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-mail-text mb-1">{t('common.premiumFeature')}</p>
                  <p className="text-xs text-mail-text-muted max-w-[280px]">
                    {t('settings.storage.automaticallyCleanUpOldEmails')}
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
        ) : (
          /* Full rule management UI for paid users */
          <div className="space-y-4">
            <p className="text-sm text-mail-text-muted">
              {t('settings.storage.automaticallyCleanUpOldEmails2')}
            </p>

            {/* Rules saved before the engine was fixed never ran. Say so, rather
                than leaving the user to find their rules mysteriously off. */}
            {cleanupRulesDisarmed && cleanupRules.length > 0 && (
              <div className="flex items-start gap-2 p-3 bg-mail-warning-tint border border-mail-warning rounded-lg">
                <AlertTriangle size={16} className="text-mail-warning shrink-0 mt-0.5" />
                <p className="text-xs text-mail-warning flex-1">
                  {t('settings.storage.cleanupRulesDisarmed')}
                </p>
                <button
                  onClick={dismissCleanupRulesDisarmed}
                  className="text-xs text-mail-warning underline shrink-0"
                >
                  {t('common.close')}
                </button>
              </div>
            )}

            {/* Existing rules list */}
            {cleanupRules.length > 0 && (
              <div className="space-y-2">
                {cleanupRules.map((rule) => (
                  <div key={rule.id} className="flex items-center justify-between p-3 bg-mail-bg rounded-lg group">
                    <div className="flex items-center gap-3 text-sm min-w-0 flex-1">
                      <span className="font-medium text-mail-text">{decodeImapUtf7(rule.folder)}</span>
                      <span className="text-mail-text-muted truncate">
                        {rule.account === 'all' ? t('contacts.allAccounts') : rule.account}
                      </span>
                      <span className="text-mail-text-muted whitespace-nowrap">
                        {'>'} {rule.age} {rule.unit}
                      </span>
                      <span className={`text-xs px-1.5 py-0.5 rounded whitespace-nowrap ${
                        rule.action === 'delete'
                          ? 'bg-mail-danger-tint text-mail-danger'
                          : 'bg-mail-accent-tint text-mail-accent-text'
                      }`}>
                        {rule.action === 'delete' ? t('rowMenu.deleteServer') : t('settings.storage.archiveThenDelete')}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 ml-3 shrink-0">
                      <ToggleSwitch
                        active={rule.enabled}
                        onClick={() => toggleCleanupRule(rule.id)}
                      />
                      <button
                        onClick={() => {
                          setCleanupForm({ mode: 'edit', id: rule.id });
                          setCleanupAccount(rule.account);
                          setCleanupFolder(rule.folder);
                          setCleanupAge(rule.age);
                          setCleanupUnit(rule.unit);
                          setCleanupAction(rule.action);
                        }}
                        className="p-1.5 text-mail-text-muted hover:text-mail-accent-text rounded-md hover:bg-mail-surface transition-colors opacity-0 group-hover:opacity-100"
                        title={t('settings.storage.editRule')}
                      >
                        <Pencil size={14} />
                      </button>
                      {cleanupDeleteConfirm === rule.id ? (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setCleanupDeleteConfirm(null)}
                            className="px-2 py-1 text-xs text-mail-text-muted hover:bg-mail-surface rounded transition-colors"
                          >
                            {t('common.cancel')}
                          </button>
                          <button
                            onClick={() => {
                              removeCleanupRule(rule.id);
                              setCleanupDeleteConfirm(null);
                            }}
                            className="px-2 py-1 text-xs text-mail-danger hover:bg-mail-danger-tint rounded transition-colors"
                          >
                            {t('common.delete')}
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setCleanupDeleteConfirm(rule.id)}
                          className="p-1.5 text-mail-text-muted hover:text-mail-danger rounded-md hover:bg-mail-surface transition-colors opacity-0 group-hover:opacity-100"
                          title={t('settings.storage.deleteRule')}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {cleanupRules.length === 0 && !cleanupForm && (
              <div className="text-center py-6 text-mail-text-muted text-sm">
                {t('settings.storage.noCleanupRulesYetAdd')}
              </div>
            )}

            {/* Inline add/edit form */}
            {cleanupForm && (
              <div className="bg-mail-bg border border-mail-border rounded-lg p-4 space-y-3">
                <h5 className="text-sm font-medium text-mail-text">
                  {cleanupForm.mode === 'add' ? t('settings.storage.addCleanupRule') : t('settings.storage.editCleanupRule')}
                </h5>

                {/* First-time warning */}
                {showCleanupFirstTimeWarning && (
                  <div className="flex items-start gap-2 p-3 bg-mail-warning-tint border border-mail-warning rounded-lg">
                    <AlertTriangle size={16} className="text-mail-warning shrink-0 mt-0.5" />
                    <p className="text-xs text-mail-warning">
                      {t('settings.storage.autoCleanupRulesRunAutomatically')}
                    </p>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  {/* Account dropdown */}
                  <div>
                    <label className="text-xs text-mail-text-muted mb-1 block">{t('settings.storage.account')}</label>
                    <select
                      value={cleanupAccount}
                      onChange={(e) => setCleanupAccount(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-mail-surface border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent"
                    >
                      <option value="all">{t('settings.storage.allAccounts')}</option>
                      {accounts
                        .filter(a => !hiddenAccounts?.[a.id])
                        .map(a => (
                          <option key={a.id} value={a.email}>{a.email}</option>
                        ))
                      }
                    </select>
                  </div>

                  {/* Folder dropdown */}
                  <div>
                    <label className="text-xs text-mail-text-muted mb-1 block">{t('common.folder')}</label>
                    <select
                      value={cleanupFolder}
                      onChange={(e) => setCleanupFolder(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-mail-surface border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent"
                    >
                      {['INBOX', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive'].map(f => (
                        <option key={f} value={f}>{decodeImapUtf7(f)}</option>
                      ))}
                    </select>
                  </div>

                  {/* Age threshold */}
                  <div>
                    <label className="text-xs text-mail-text-muted mb-1 block">{t('settings.storage.olderThan')}</label>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        min={cleanupUnit === 'days' ? 7 : 1}
                        value={cleanupAge}
                        onChange={(e) => {
                          const val = parseInt(e.target.value) || 0;
                          setCleanupAge(val);
                        }}
                        className="w-20 px-3 py-2 text-sm bg-mail-surface border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent"
                      />
                      <select
                        value={cleanupUnit}
                        onChange={(e) => {
                          setCleanupUnit(e.target.value);
                          if (e.target.value === 'days' && cleanupAge < 7) setCleanupAge(7);
                        }}
                        className="flex-1 px-3 py-2 text-sm bg-mail-surface border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent"
                      >
                        <option value="days">{t('settings.storage.days')}</option>
                        <option value="months">{t('settings.storage.months')}</option>
                      </select>
                    </div>
                    {cleanupUnit === 'days' && cleanupAge < 7 && cleanupAge > 0 && (
                      <p className="text-[10px] text-mail-danger mt-1">{t('settings.storage.minimum7Days')}</p>
                    )}
                  </div>

                  {/* Action dropdown */}
                  <div>
                    <label className="text-xs text-mail-text-muted mb-1 block">{t('settings.storage.action')}</label>
                    <select
                      value={cleanupAction}
                      onChange={(e) => setCleanupAction(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-mail-surface border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent"
                    >
                      <option value="delete">{t('settings.storage.deleteServer')}</option>
                      <option value="archive-then-delete">{t('settings.storage.archiveLocallyThenDelete')}</option>
                    </select>
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    onClick={() => {
                      setCleanupForm(null);
                      setShowCleanupFirstTimeWarning(false);
                    }}
                    className="px-3 py-1.5 text-sm text-mail-text-muted hover:bg-mail-surface rounded-lg transition-colors"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={() => {
                      const effectiveAge = cleanupUnit === 'days' ? Math.max(7, cleanupAge) : Math.max(1, cleanupAge);
                      const ruleData = {
                        account: cleanupAccount,
                        folder: cleanupFolder,
                        age: effectiveAge,
                        unit: cleanupUnit,
                        action: cleanupAction,
                        enabled: true,
                      };
                      if (cleanupForm.mode === 'edit') {
                        updateCleanupRule(cleanupForm.id, ruleData);
                      } else {
                        addCleanupRule(ruleData);
                      }
                      setCleanupForm(null);
                      setShowCleanupFirstTimeWarning(false);
                    }}
                    disabled={cleanupUnit === 'days' && cleanupAge < 7}
                    className="px-3 py-1.5 text-sm font-medium bg-mail-accent-fill text-white rounded-lg hover:bg-mail-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {cleanupForm.mode === 'edit' ? t('common.save') : t('settings.storage.addRule')}
                  </button>
                </div>
              </div>
            )}

            {/* Action buttons */}
            {!cleanupForm && (<>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setCleanupForm({ mode: 'add' });
                    setCleanupAccount('all');
                    setCleanupFolder('INBOX');
                    setCleanupAge(30);
                    setCleanupUnit('days');
                    setCleanupAction('delete');
                    if (cleanupRules.length === 0) {
                      setShowCleanupFirstTimeWarning(true);
                    }
                  }}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium bg-mail-accent/10 text-mail-accent-text rounded-lg hover:bg-mail-accent/20 transition-colors"
                >
                  <Plus size={14} />
                  {t('settings.storage.addRule')}
                </button>
                {cleanupRules.length > 0 && (
                  <button
                    onClick={async () => {
                      setCleanupRunning(true);
                      setCleanupResult(null);
                      try {
                        const result = await runCleanupRules();
                        if (result.archived > 0 || result.deleted > 0) {
                          setCleanupResult(`${t('settings.storage.cleanedUp', { count: result.deleted })}${result.archived > 0 ? ` (${result.archived} archived)` : ''}`);
                        } else {
                          setCleanupResult('No emails matched cleanup criteria');
                        }
                      } catch (e) {
                        setCleanupResult(`Cleanup failed: ${e.message}`);
                      } finally {
                        setCleanupRunning(false);
                        setTimeout(() => setCleanupResult(null), 5000);
                      }
                    }}
                    disabled={cleanupRunning}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium bg-mail-surface-hover text-mail-text rounded-lg hover:bg-mail-border transition-colors disabled:opacity-50"
                  >
                    {cleanupRunning ? <Loader size={14} className="animate-spin" /> : <Play size={14} />}
                    {cleanupRunning ? t('settings.storage.running') : t('settings.storage.runAllNow')}
                  </button>
                )}
              </div>
              {cleanupResult && (
                <p className={`text-xs mt-2 ${cleanupResult.startsWith('Cleanup failed') ? 'text-mail-danger' : 'text-mail-text-muted'}`}>
                  {cleanupResult}
                </p>
              )}
            </>)}
          </div>
        )}
      </div>

      {/* Advanced: Folder Selection (only for supported browsers) */}
      {supportsFileSystem && (
        <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
          <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
            <FolderOpen size={18} className="text-mail-accent-text" />
            {t('settings.storage.advancedCustomStorageFolder')}
          </h4>

          <p className="text-sm text-mail-text-muted mb-3">
            {t('settings.storage.chooseWhereVaultLivesAny')}
          </p>
          <div className="flex gap-2">
            <div className="flex-1 px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                          text-mail-text min-h-[42px] flex items-center">
              {localStoragePath || (
                <span className="text-mail-text-muted">{t('settings.storage.browserStorageDefault')}</span>
              )}
            </div>
            <button
              onClick={handleSelectFolder}
              disabled={movingStorage}
              className="px-4 py-2.5 bg-mail-surface-hover hover:bg-mail-border
                        text-mail-text rounded-lg transition-colors flex items-center gap-2
                        disabled:opacity-50"
            >
              <FolderOpen size={16} />
              {movingStorage ? t('moveTo.moving') : t('settings.storage.browse')}
            </button>
          </div>
        </div>
      )}

      {/* Security */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <Shield size={18} className="text-mail-accent-text" />
          {t('settings.storage.security')}
        </h4>

        <div className="text-mail-text-muted text-sm">
          <p className="mb-3">
            {t('settings.storage.passwordProtectionLocalStorageComing')}
          </p>
          <div className="flex items-center gap-2 text-mail-accent-text">
            <Shield size={16} />
            <span>{t('settings.storage.featureUnderDevelopment')}</span>
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="bg-mail-surface border border-mail-danger/30 rounded-xl p-5">
        <h4 className="font-semibold text-mail-danger mb-4 flex items-center gap-2">
          <Trash2 size={18} />
          {t('settings.storage.dangerZone')}
        </h4>

        <p className="text-sm text-mail-text-muted mb-4">
          Empties your vault on this computer and forgets every account and setting.
          Mail still on the server is untouched; anything the server no longer has is gone for good.
        </p>
        <Button variant="dangerTint"
          onClick={() => setShowClearConfirm(true)}
        >
          <Trash2 size={16} />
          {t('settings.storage.emptyVault')}
        </Button>
      </div>

      <ConfirmDialog
        isOpen={showClearConfirm}
        onClose={() => !clearing && setShowClearConfirm(false)}
        title={t('settings.storage.emptyVaultComputer')}
        description="Every email in your vault, every account, and every setting is deleted from this computer. Mail still on the server can be downloaded again; anything the server no longer has has no other copy. This cannot be undone."
        confirmLabel="Empty the vault"
        destructive
        loading={clearing}
        onConfirm={async () => {
          setClearing(true);
          try {
            const db = await import('../../services/db');
            // Delete each account's Maildir and data
            const accts = await db.getAccountsWithoutPasswords();
            for (const acct of accts) {
              await db.deleteAccount(acct.id);
            }
          } catch (e) {
            console.error('Failed to clear Maildir data:', e);
          }
          try { localStorage.clear(); } catch { /* sandbox may block */ }
          window.location.reload();
        }}
      />

    </div>
  );
}
