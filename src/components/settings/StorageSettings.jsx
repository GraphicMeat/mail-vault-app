import { Button } from '../ui/Button';
import React, { useState, useEffect } from 'react';
import { useMailStore } from '../../stores/mailStore';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import { motion, AnimatePresence } from 'framer-motion';
import { cleanupStatus, cleanupRules as readCleanupRules, onCleanupRun, runCleanupNow } from '../../services/cleanupApi';
import { ToggleSwitch } from '../ui/ToggleSwitch';
import { SearchIndexSettings } from './SearchIndexSettings';
import { StorageFormatSettings } from './StorageFormatSettings';
import { DownloadModeControl } from './DownloadModeControl';
import { IS_APPSTORE_BUILD } from '../../utils/buildFlags';
import { usePremiumPriceBlurb } from '../../hooks/usePremiumPricing.js';
import { send } from '../../services/transport';
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
import { formatDateTime } from '../../utils/dateFormat';
import { ConfirmDialog } from '../ConfirmDialog';
import { t, tErr, useT } from '../../i18n/index.js';
import { usePrivateAttr } from '../../hooks/usePrivacy';
import { formatCount } from '../../utils/formatCount';
import { SettingsPageLayout } from '../ui/SettingsForm';

/**
 * The folders the rule picker offers: roles, resolved per account by the
 * daemon (src-core/src/cleanup_rules.rs). 'all' is the every-folder sentinel.
 * None of them may be a protected folder there (`PROTECTED_FOLDERS`, Drafts):
 * a rule that names one renders enabled and never runs.
 */
const CLEANUP_FOLDERS = ['all', 'INBOX', 'Sent', 'Trash', 'Junk', 'Archive'];

export function StorageSettings({ accounts, onUpgrade }) {
  const t = useT();
  const pa = usePrivateAttr();
  const priceBlurb = usePremiumPriceBlurb();
  // A native confirm() can only offer OK/Cancel, so the button on the most
  // destructive action in the app could not name what it was about to erase.
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearVaultError, setClearVaultError] = useState(false);
  const {
    localStoragePath,
    setLocalStoragePath,
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

  // 'all' is a sentinel, not a mailbox name - decodeImapUtf7 would print it raw.
  const folderLabel = (folder) => (
    folder === 'all' ? t('settings.backup.account.allFolders') : decodeImapUtf7(folder)
  );

  const [movingStorage, setMovingStorage] = useState(false);
  const [supportsFileSystem, setSupportsFileSystem] = useState(false);
  const [localStorageUsage, setLocalStorageUsage] = useState(null);
  const [usageError, setUsageError] = useState(false);
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
  // The daemon runs the rules (daily, or on Run All Now) and keeps the last run.
  const [cleanupLastRun, showCleanupLastRun] = useState(null);
  // rule id -> the catalog key of why the daemon will not run it
  const [cleanupRefused, setCleanupRefused] = useState({});
  const [orphanStats, setOrphanStats] = useState(null);
  const [purgingOrphans, setPurgingOrphans] = useState(false);
  const [purgeOrphansConfirm, setPurgeOrphansConfirm] = useState(false);

  const invoke = window.__TAURI__?.core?.invoke;

  // The last run and whether one is going, and every run's end after that.
  // A reconnect or a lagged event stream may have eaten the end: ask again.
  useEffect(() => {
    let alive = true;
    const offs = [];
    const ask = () => cleanupStatus().then((status) => {
      if (!alive || !status) return;
      setCleanupRunning(!!status.running);
      if (status.lastRun) showCleanupLastRun(status.lastRun);
    }, () => {});
    // `start` makes one subscription. Without a Tauri runtime `listen()`
    // rejects or throws: that is "no events here", never an unhandled
    // rejection (which fails a vitest run and CI).
    const keep = (start) => {
      let sub;
      try { sub = Promise.resolve(start()); } catch { return; }
      sub.then((fn) => {
        if (typeof fn !== 'function') return;
        if (alive) offs.push(fn); else fn();
      }, () => {});
    };
    keep(() => onCleanupRun((p) => {
      if (p.state === 'running') setCleanupRunning(true);
      if (p.state === 'done') {
        setCleanupRunning(false);
        if (p.lastRun) showCleanupLastRun(p.lastRun);
      }
    }));
    import('@tauri-apps/api/event').then(({ listen }) => {
      keep(() => listen('daemon-reconnected', ask));
      keep(() => listen('daemon-events-lagged', ask));
    }).catch(() => {});
    ask();
    return () => { alive = false; offs.forEach((fn) => fn()); };
  }, []);

  // While a run is going, the status is the fallback for an end event that
  // never arrives.
  useEffect(() => {
    if (!cleanupRunning) return undefined;
    const timer = setInterval(() => {
      cleanupStatus().then((status) => {
        if (!status) return;
        if (!status.running) setCleanupRunning(false);
        if (status.lastRun) showCleanupLastRun(status.lastRun);
      }, () => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [cleanupRunning]);

  // Rules the daemon reads but will not run say so on their row.
  useEffect(() => {
    let alive = true;
    readCleanupRules().then((r) => {
      if (!alive) return;
      const refused = {};
      for (const rule of r?.rules || []) if (rule?.id && rule.refused) refused[rule.id] = rule.refused;
      setCleanupRefused(refused);
    }, () => {});
    return () => { alive = false; };
  }, [cleanupRules]);

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
        setUsageError(true);
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
    <SettingsPageLayout>
      {/* Current Storage Status */}
      <div className="settings-section">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <Database size={18} className="text-mail-accent-text" />
          {t('settings.storage.storageStatus')}
        </h4>

        <div className="flex items-center gap-3 p-3 bg-mail-local-tint border border-mail-local/20 rounded-lg mb-4">
          <div className="w-3 h-3 bg-mail-success rounded-full" />
          <span className="text-sm text-mail-text">
            {t('settings.storage.emailsStoredSecurelyLocalStorage')}
          </span>
        </div>

        <p className="text-sm text-mail-text-muted">
          {t('settings.storage.ordinaryFilesNothingUploaded')}
        </p>
      </div>

      {/* Download mode: how much mail stays on this computer */}
      <div className="settings-section">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <HardDrive size={18} className="text-mail-accent-text" />
          {t('settings.storage.downloadMode')}
        </h4>

        <div className="space-y-4">
          <DownloadModeControl onUpgrade={onUpgrade} />

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
                    {' '}{t('settings.storage.emailsSavedParen', { count: formatCount(localStorageUsage.emailCount || 0) })}
                  </>
                ) : (
                  usageError ? t('settings.storage.usageUnavailable') : t('settings.storage.calculating')
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

                      // Stop the daemon's download-ahead before its files are cleared; the
                      // coordinator reports the view again when the list reloads.
                      const { stopNative } = await import('../../services/nativePipeline');
                      await stopNative().catch(error => console.warn('[storage] download-ahead not stopped:', error));

                      // Clear .eml files (preserving archived)
                      const result = await send('maildir_clear_cache');

                      // Clear headers cache files
                      await send('clear_email_cache', { accountId: null });

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
              {t('settings.storage.clearedCachedEmails', { count: formatCount(clearCacheResult.deletedCount) })}
              {clearCacheResult.skippedArchived > 0 && t('settings.storage.archivedPreservedSuffix', { count: formatCount(clearCacheResult.skippedArchived) })}
              {t('settings.storage.resyncStarted')}
            </div>
          )}
        </div>
      </div>

      {/* Message format: Maildir or JMAP, and converting between them. */}
      <StorageFormatSettings usage={localStorageUsage} />

      <SearchIndexSettings onUpgrade={onUpgrade} />

      {/* Auto-Cleanup Rules */}
      <div data-testid="settings-auto-cleanup" className="settings-section relative overflow-hidden">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <Clock size={18} className="text-mail-accent-text" />
          {t('settings.storage.autoCleanupHeading')}
          {!isPaidUser && (
            <span className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 text-xs font-bold uppercase tracking-wider bg-mail-accent-fill text-white rounded-full">
              {t('common.premium')}
            </span>
          )}
        </h4>

        {!isPaidUser ? (
          <div className="space-y-4">
            <p className="text-sm text-mail-text-muted max-w-xl">{t('settings.storage.automaticallyCleanUpOldEmails')}</p>
            {!IS_APPSTORE_BUILD && <p className="text-xs text-mail-text-muted">{priceBlurb}</p>}
            {!IS_APPSTORE_BUILD && onUpgrade && <Button variant="primary" size="sm" onClick={onUpgrade}>{t('common.upgrade')}</Button>}
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
                      <span className="font-medium text-mail-text">{folderLabel(rule.folder)}</span>
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
                      {cleanupRefused[rule.id] && (
                        <span className="text-xs text-mail-warning truncate" title={tErr(cleanupRefused[rule.id])}>
                          <AlertTriangle size={12} className="inline mr-1" />
                          {tErr(cleanupRefused[rule.id])}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 ml-3 shrink-0">
                      <ToggleSwitch label={t('settings.storage.enableRule', { folder: decodeImapUtf7(rule.folder) })}
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
                    <select aria-label={t('settings.storage.account')}
                      value={cleanupAccount}
                      onChange={(e) => setCleanupAccount(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-mail-surface border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent"
                    >
                      <option value="all">{t('settings.storage.allAccounts')}</option>
                      {accounts
                        .filter(a => !hiddenAccounts?.[a.id])
                        .map(a => (
                          <option key={a.id} value={a.email}>{pa(a.email, 'email')}</option>
                        ))
                      }
                    </select>
                  </div>

                  {/* Folder dropdown */}
                  <div>
                    <label className="text-xs text-mail-text-muted mb-1 block">{t('common.folder')}</label>
                    <select aria-label={t('common.folder')}
                      value={cleanupFolder}
                      onChange={(e) => setCleanupFolder(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-mail-surface border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent"
                    >
                      {CLEANUP_FOLDERS.map(f => (
                        <option key={f} value={f}>{folderLabel(f)}</option>
                      ))}
                    </select>
                  </div>

                  {/* Age threshold */}
                  <div>
                    <label className="text-xs text-mail-text-muted mb-1 block">{t('settings.storage.olderThan')}</label>
                    <div className="flex gap-2">
                      <input aria-label={t('settings.storage.olderThan')}
                        type="number"
                        min={cleanupUnit === 'days' ? 7 : 1}
                        value={cleanupAge}
                        onChange={(e) => {
                          const val = parseInt(e.target.value) || 0;
                          setCleanupAge(val);
                        }}
                        className="w-20 px-3 py-2 text-sm bg-mail-surface border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent"
                      />
                      <select aria-label={t('settings.storage.olderThan')}
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
                      <p className="text-xs text-mail-danger mt-1">{t('settings.storage.minimum7Days')}</p>
                    )}
                  </div>

                  {/* Action dropdown */}
                  <div>
                    <label className="text-xs text-mail-text-muted mb-1 block">{t('settings.storage.action')}</label>
                    <select aria-label={t('settings.storage.action')}
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
                        // The daemon runs it; the line below is its last run,
                        // which a daily run updates too. `cleanup-run` says
                        // when it is over.
                        const r = await runCleanupNow();
                        if (!r?.started && !r?.running) setCleanupRunning(false);
                      } catch (e) {
                        setCleanupRunning(false);
                        setCleanupResult(tErr(e));
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
              {cleanupResult ? (
                <p className="text-xs mt-2 text-mail-danger">{cleanupResult}</p>
              ) : cleanupLastRun && (
                <p className="text-xs mt-2 text-mail-text-muted">
                  {t('settings.storage.cleanupLastRun', {
                    date: formatDateTime(cleanupLastRun.at),
                    deleted: cleanupLastRun.deleted ?? 0,
                    archived: cleanupLastRun.archived ?? 0,
                    skipped: cleanupLastRun.skipped ?? 0,
                  })}
                </p>
              )}
            </>)}
          </div>
        )}
      </div>

      {/* Advanced: Folder Selection (only for supported browsers) */}
      {supportsFileSystem && (
        <div className="settings-section">
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
      <div className="settings-section">
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
          {t('settings.storage.emptiesVaultExplanation')}
        </p>
        <Button variant="dangerTint"
          onClick={() => { setClearVaultError(false); setShowClearConfirm(true); }}
        >
          <Trash2 size={16} />
          {t('settings.storage.emptyVault')}
        </Button>
      </div>

      <ConfirmDialog
        isOpen={showClearConfirm}
        onClose={() => !clearing && setShowClearConfirm(false)}
        title={t('settings.storage.emptyVaultComputer')}
        description={<>
          {t('settings.storage.emptyVaultConfirmDescription')}
          {clearVaultError && <span role="alert" className="block mt-3 text-mail-danger">
            {t('settings.storage.emptyVaultFailed')}
          </span>}
        </>}
        confirmLabel="Empty the vault"
        destructive
        loading={clearing}
        onConfirm={async () => {
          setClearing(true);
          setClearVaultError(false);
          try {
            const db = await import('../../services/db');
            const accts = await db.listAccountsForRemoval();
            if (!Array.isArray(accts) || accts.some(acct => typeof acct?.id !== 'string' || !acct.id)
              || new Set(accts.map(acct => acct.id)).size !== accts.length) {
              throw new Error('errors.accountsWriteFailed');
            }
            for (const acct of accts) {
              const result = await db.deleteAccount(acct.id);
              if (result?.outcome !== 'complete' || result.accountId !== acct.id
                || Object.keys(result).length !== 2) throw new Error('errors.accountRemovalIncomplete');
            }
          } catch (e) {
            console.error('Failed to clear Maildir data:', e);
            setClearVaultError(true);
            setClearing(false);
            return;
          }
          try { localStorage.clear(); } catch { /* sandbox may block */ }
          window.location.reload();
        }}
      />

    </SettingsPageLayout>
  );
}
