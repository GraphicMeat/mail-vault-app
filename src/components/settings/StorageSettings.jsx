import React, { useState, useEffect } from 'react';
import { useMailStore } from '../../stores/mailStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { motion, AnimatePresence } from 'framer-motion';
import { runCleanupRules } from '../../services/cleanupEngine';
import { ToggleSwitch } from './ToggleSwitch';
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

export function StorageSettings({ accounts }) {
  const {
    localStoragePath,
    setLocalStoragePath,
    localCacheDurationMonths,
    setLocalCacheDurationMonths,
    hiddenAccounts,
    isPaidUser,
    cleanupRules,
    addCleanupRule,
    updateCleanupRule,
    removeCleanupRule,
    toggleCleanupRule,
  } = useSettingsStore();

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

  const invoke = window.__TAURI__?.core?.invoke;

  // Check for File System Access API support
  useEffect(() => {
    setSupportsFileSystem('showDirectoryPicker' in window);
  }, []);

  // Load local storage usage
  useEffect(() => {
    const loadStorageUsage = async () => {
      try {
        const { getStorageUsage } = await import('../../services/db');
        const usage = await getStorageUsage();
        setLocalStorageUsage(usage);
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

      if (localStoragePath && localStoragePath !== newPath) {
        const shouldMove = confirm(
          'Do you want to move all existing emails and settings to the new folder?'
        );
        if (shouldMove) {
          setMovingStorage(true);
          setTimeout(() => {
            setLocalStoragePath(newPath);
            setMovingStorage(false);
          }, 500);
          return;
        }
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
          <Database size={18} className="text-mail-accent" />
          Storage Status
        </h4>

        <div className="flex items-center gap-3 p-3 bg-mail-success/10 border border-mail-success/20 rounded-lg mb-4">
          <div className="w-3 h-3 bg-mail-success rounded-full animate-pulse" />
          <span className="text-sm text-mail-text">
            Your emails are stored securely in local storage
          </span>
        </div>

        <p className="text-sm text-mail-text-muted">
          All archived emails, attachments, and settings are stored locally on your device.
          This data persists across sessions and is private to your device.
        </p>
      </div>

      {/* Local Email Caching */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <HardDrive size={18} className="text-mail-accent" />
          Local Email Caching
        </h4>

        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-3">
              <label className="text-sm font-medium text-mail-text">
                Cache Duration
              </label>
              <span className="text-sm font-medium text-mail-accent">
                {localCacheDurationMonths === 0 ? 'All emails' :
                 localCacheDurationMonths === 1 ? '1 month' :
                 localCacheDurationMonths === 12 ? '1 year' :
                 `${localCacheDurationMonths} months`}
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
                <span className="text-[10px] text-mail-text-muted">1 mo</span>
                <span className="text-[10px] text-mail-text-muted">3 mo</span>
                <span className="text-[10px] text-mail-text-muted">6 mo</span>
                <span className="text-[10px] text-mail-text-muted">1 year</span>
                <span className="text-[10px] text-mail-text-muted">All</span>
              </div>
            </div>
          </div>

          {/* Local storage usage */}
          <div className="flex items-center justify-between p-3 bg-mail-bg rounded-lg">
            <div>
              <div className="text-sm text-mail-text">Local storage usage</div>
              <div className="text-xs text-mail-text-muted">
                {localStorageUsage ? (
                  <>
                    {localStorageUsage.totalMB >= 1024
                      ? `${(localStorageUsage.totalMB / 1024).toFixed(2)} GB`
                      : localStorageUsage.totalMB >= 1
                      ? `${localStorageUsage.totalMB.toFixed(2)} MB`
                      : `${(localStorageUsage.totalMB * 1024).toFixed(0)} KB`}
                    {' '}({localStorageUsage.emailCount.toLocaleString()} emails saved)
                  </>
                ) : (
                  'Calculating...'
                )}
              </div>
            </div>
          </div>

          {/* Clear cache */}
          <div className="flex items-center justify-between p-3 bg-mail-bg rounded-lg">
            <div>
              <div className="text-sm text-mail-text">Clear cached emails</div>
              <div className="text-xs text-mail-text-muted">
                Removes all cached .eml files and re-syncs. Archived emails are preserved.
              </div>
            </div>
            {!clearCacheConfirm ? (
              <button
                onClick={() => { setClearCacheConfirm(true); setClearCacheResult(null); }}
                disabled={clearingCache}
                className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
              >
                <Trash2 size={14} />
                Clear Cache
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setClearCacheConfirm(false)}
                  disabled={clearingCache}
                  className="px-3 py-1.5 text-sm font-medium rounded-lg border border-mail-border text-mail-text-muted hover:bg-mail-surface transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
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
                      useMailStore.setState({ emails: [], sortedEmails: [], localEmails: [], emailsByIndex: {}, totalEmails: 0, loadedRanges: [], currentPage: 0, hasMoreEmails: true, sentEmails: [] });

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
                  className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
                >
                  {clearingCache ? (
                    <Loader size={14} className="animate-spin" />
                  ) : (
                    <Trash2 size={14} />
                  )}
                  {clearingCache ? 'Clearing...' : 'Confirm'}
                </button>
              </div>
            )}
          </div>
          {clearCacheResult && (
            <div className="text-xs text-green-600 dark:text-green-400 px-1">
              Cleared {clearCacheResult.deletedCount.toLocaleString()} cached emails
              {clearCacheResult.skippedArchived > 0 && `, ${clearCacheResult.skippedArchived.toLocaleString()} archived emails preserved`}.
              Re-sync started.
            </div>
          )}
        </div>
      </div>

      {/* Auto-Cleanup Rules */}
      <div data-testid="settings-auto-cleanup" className="bg-mail-surface border border-mail-border rounded-xl p-5 relative overflow-hidden">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <Clock size={18} className="text-mail-accent" />
          Auto-Cleanup
          {!isPaidUser && (
            <span className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-gradient-to-r from-blue-500 to-indigo-500 text-white rounded-full">
              <Clock size={10} />
              Coming Soon
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
                    <span>INBOX</span>
                    <span className="text-mail-text-muted">All accounts</span>
                    <span className="text-mail-text-muted">Older than 90 days</span>
                    <span className="text-mail-text-muted">Archive locally then delete</span>
                  </div>
                </div>
                <div className="flex items-center justify-between p-2.5 bg-mail-bg rounded-lg">
                  <div className="flex items-center gap-3 text-sm text-mail-text">
                    <span>Trash</span>
                    <span className="text-mail-text-muted">All accounts</span>
                    <span className="text-mail-text-muted">Older than 30 days</span>
                    <span className="text-mail-text-muted">Delete from server</span>
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <div className="px-3 py-1.5 text-sm bg-mail-accent/10 text-mail-accent rounded-lg">Add Rule</div>
                <div className="px-3 py-1.5 text-sm bg-mail-surface-hover text-mail-text rounded-lg">Run All Now</div>
              </div>
            </div>

            {/* Lock overlay */}
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-mail-surface/60 backdrop-blur-[1px] rounded-lg">
              <div className="flex flex-col items-center gap-3 text-center px-6">
                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-500/20 to-indigo-500/20 border border-blue-500/30 flex items-center justify-center">
                  <Clock size={20} className="text-blue-500" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-mail-text mb-1">Coming Soon</p>
                  <p className="text-xs text-mail-text-muted max-w-[280px]">
                    Automatically clean up old emails with custom rules. Set per-folder age thresholds, choose to archive or delete, and keep your mailbox tidy.
                  </p>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* Full rule management UI for paid users */
          <div className="space-y-4">
            <p className="text-sm text-mail-text-muted">
              Automatically clean up old emails with custom rules. Rules run in the background periodically.
            </p>

            {/* Existing rules list */}
            {cleanupRules.length > 0 && (
              <div className="space-y-2">
                {cleanupRules.map((rule) => (
                  <div key={rule.id} className="flex items-center justify-between p-3 bg-mail-bg rounded-lg group">
                    <div className="flex items-center gap-3 text-sm min-w-0 flex-1">
                      <span className="font-medium text-mail-text">{rule.folder}</span>
                      <span className="text-mail-text-muted truncate">
                        {rule.account === 'all' ? 'All accounts' : rule.account}
                      </span>
                      <span className="text-mail-text-muted whitespace-nowrap">
                        {'>'} {rule.age} {rule.unit}
                      </span>
                      <span className={`text-xs px-1.5 py-0.5 rounded whitespace-nowrap ${
                        rule.action === 'delete'
                          ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                          : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                      }`}>
                        {rule.action === 'delete' ? 'Delete from server' : 'Archive then delete'}
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
                        className="p-1.5 text-mail-text-muted hover:text-mail-accent rounded-md hover:bg-mail-surface transition-colors opacity-0 group-hover:opacity-100"
                        title="Edit rule"
                      >
                        <Pencil size={14} />
                      </button>
                      {cleanupDeleteConfirm === rule.id ? (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setCleanupDeleteConfirm(null)}
                            className="px-2 py-1 text-xs text-mail-text-muted hover:bg-mail-surface rounded transition-colors"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => {
                              removeCleanupRule(rule.id);
                              setCleanupDeleteConfirm(null);
                            }}
                            className="px-2 py-1 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors"
                          >
                            Delete
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setCleanupDeleteConfirm(rule.id)}
                          className="p-1.5 text-mail-text-muted hover:text-red-500 rounded-md hover:bg-mail-surface transition-colors opacity-0 group-hover:opacity-100"
                          title="Delete rule"
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
                No cleanup rules yet. Add a rule to get started.
              </div>
            )}

            {/* Inline add/edit form */}
            {cleanupForm && (
              <div className="bg-mail-bg border border-mail-border rounded-lg p-4 space-y-3">
                <h5 className="text-sm font-medium text-mail-text">
                  {cleanupForm.mode === 'add' ? 'Add Cleanup Rule' : 'Edit Cleanup Rule'}
                </h5>

                {/* First-time warning */}
                {showCleanupFirstTimeWarning && (
                  <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                    <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-800 dark:text-amber-300">
                      Auto-cleanup rules run automatically. Deleted emails cannot be recovered from server.
                    </p>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  {/* Account dropdown */}
                  <div>
                    <label className="text-xs text-mail-text-muted mb-1 block">Account</label>
                    <select
                      value={cleanupAccount}
                      onChange={(e) => setCleanupAccount(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-mail-surface border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent"
                    >
                      <option value="all">All accounts</option>
                      {accounts
                        .filter(a => !hiddenAccounts.includes(a.id))
                        .map(a => (
                          <option key={a.id} value={a.email}>{a.email}</option>
                        ))
                      }
                    </select>
                  </div>

                  {/* Folder dropdown */}
                  <div>
                    <label className="text-xs text-mail-text-muted mb-1 block">Folder</label>
                    <select
                      value={cleanupFolder}
                      onChange={(e) => setCleanupFolder(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-mail-surface border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent"
                    >
                      {['INBOX', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive'].map(f => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                  </div>

                  {/* Age threshold */}
                  <div>
                    <label className="text-xs text-mail-text-muted mb-1 block">Older than</label>
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
                        <option value="days">days</option>
                        <option value="months">months</option>
                      </select>
                    </div>
                    {cleanupUnit === 'days' && cleanupAge < 7 && cleanupAge > 0 && (
                      <p className="text-[10px] text-red-500 mt-1">Minimum 7 days</p>
                    )}
                  </div>

                  {/* Action dropdown */}
                  <div>
                    <label className="text-xs text-mail-text-muted mb-1 block">Action</label>
                    <select
                      value={cleanupAction}
                      onChange={(e) => setCleanupAction(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-mail-surface border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent"
                    >
                      <option value="delete">Delete from server</option>
                      <option value="archive-then-delete">Archive locally then delete</option>
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
                    Cancel
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
                    className="px-3 py-1.5 text-sm font-medium bg-mail-accent text-white rounded-lg hover:bg-mail-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {cleanupForm.mode === 'edit' ? 'Save' : 'Add Rule'}
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
                  className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium bg-mail-accent/10 text-mail-accent rounded-lg hover:bg-mail-accent/20 transition-colors"
                >
                  <Plus size={14} />
                  Add Rule
                </button>
                {cleanupRules.length > 0 && (
                  <button
                    onClick={async () => {
                      setCleanupRunning(true);
                      setCleanupResult(null);
                      try {
                        const result = await runCleanupRules();
                        if (result.archived > 0 || result.deleted > 0) {
                          setCleanupResult(`Cleaned up ${result.deleted} email${result.deleted !== 1 ? 's' : ''}${result.archived > 0 ? ` (${result.archived} archived)` : ''}`);
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
                    {cleanupRunning ? 'Running...' : 'Run All Now'}
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
            <FolderOpen size={18} className="text-mail-accent" />
            Advanced: Custom Storage Folder
          </h4>

          <p className="text-sm text-mail-text-muted mb-3">
            Optionally select a folder on your device to sync your emails.
          </p>
          <div className="flex gap-2">
            <div className="flex-1 px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                          text-mail-text min-h-[42px] flex items-center">
              {localStoragePath || (
                <span className="text-mail-text-muted">Browser storage (default)</span>
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
              {movingStorage ? 'Moving...' : 'Browse'}
            </button>
          </div>
        </div>
      )}

      {/* Security */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <Shield size={18} className="text-mail-accent" />
          Security
        </h4>

        <div className="text-mail-text-muted text-sm">
          <p className="mb-3">
            Password protection for your local storage is coming soon.
          </p>
          <div className="flex items-center gap-2 text-mail-accent">
            <Shield size={16} />
            <span>This feature is under development</span>
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="bg-mail-surface border border-mail-danger/30 rounded-xl p-5">
        <h4 className="font-semibold text-mail-danger mb-4 flex items-center gap-2">
          <Trash2 size={18} />
          Danger Zone
        </h4>

        <p className="text-sm text-mail-text-muted mb-4">
          Clear all locally archived emails and settings. This action cannot be undone.
        </p>
        <button
          onClick={async () => {
            if (confirm('Are you sure? This will delete all locally archived emails and settings. This action cannot be undone.')) {
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
            }
          }}
          className="px-4 py-2 bg-mail-danger/10 hover:bg-mail-danger/20
                    text-mail-danger rounded-lg transition-colors flex items-center gap-2"
        >
          <Trash2 size={16} />
          Clear All Data
        </button>
      </div>

    </div>
  );
}
