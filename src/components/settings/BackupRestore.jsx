import React, { useState } from 'react';
import { useMailStore } from '../../stores/mailStore';
import { useAccountStore } from '../../stores/accountStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { safeStorage } from '../../stores/safeStorage';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Download,
  Upload,
  HardDrive,
} from 'lucide-react';

export default function BackupRestore() {
  const hiddenAccounts = useSettingsStore(s => s.hiddenAccounts);
  const getOrderedAccounts = useSettingsStore(s => s.getOrderedAccounts);
  const accounts = useAccountStore(s => s.accounts);
  const visibleAccounts = getOrderedAccounts(accounts || []).filter(a => !hiddenAccounts?.[a.id]);

  const [showExportChoice, setShowExportChoice] = useState(false);
  const invoke = window.__TAURI__?.core?.invoke;

  // ── ZIP Export / Import ──────────────────────────────────────────────────

  const handleExportData = () => {
    if (!invoke) {
      alert('Backup export is only available in the desktop app.');
      return;
    }
    setShowExportChoice(true);
  };

  const doExport = async (archivedOnly) => {
    setShowExportChoice(false);
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const destPath = await save({
        defaultPath: `mailvault-backup-${new Date().toISOString().split('T')[0]}.zip`,
        filters: [{ name: 'ZIP Archives', extensions: ['zip'] }],
      });
      if (!destPath) return;

      const settingsData = {
        theme: safeStorage.getItem('mailvault-theme'),
        settings: safeStorage.getItem('mailvault-settings'),
      };

      const db = await import('../../services/db');
      await db.initDB();
      const accountsList = await db.getAccountsWithoutPasswords();
      const backupAccounts = accountsList.map(a => ({
        email: a.email,
        imapServer: a.imapServer,
        smtpServer: a.smtpServer,
      }));

      const store = useMailStore.getState();
      store.setExportProgress({ total: 0, completed: 0, active: true, mode: 'export' });

      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen('export-progress', (event) => {
        const p = event.payload;
        useMailStore.getState().setExportProgress({
          total: p.total, completed: p.completed, active: p.active, mode: 'export'
        });
      });

      try {
        await invoke('export_backup', {
          destPath,
          archivedOnly,
          settingsJson: JSON.stringify(settingsData),
          accountsJson: JSON.stringify(backupAccounts),
        });
      } finally {
        unlisten();
      }

      setTimeout(() => useMailStore.getState().dismissExportProgress(), 3000);
    } catch (error) {
      console.error('Export error:', error);
      useMailStore.getState().dismissExportProgress();
      alert('Failed to export backup: ' + (error.message || error));
    }
  };

  const handleImportData = async () => {
    if (!invoke) {
      alert('Backup import is only available in the desktop app.');
      return;
    }
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const sourcePath = await open({
        filters: [{ name: 'ZIP Archives', extensions: ['zip'] }],
        multiple: false,
      });
      if (!sourcePath) return;

      const store = useMailStore.getState();
      store.setExportProgress({ total: 0, completed: 0, active: true, mode: 'import' });

      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen('import-progress', (event) => {
        const p = event.payload;
        useMailStore.getState().setExportProgress({
          total: p.total, completed: p.completed, active: p.active, mode: 'import'
        });
      });

      let result;
      try {
        result = await invoke('import_backup', { sourcePath });
      } finally {
        unlisten();
      }

      if (result.settingsJson) {
        try {
          const settings = JSON.parse(result.settingsJson);
          if (settings.theme) safeStorage.setItem('mailvault-theme', settings.theme);
          if (settings.settings) safeStorage.setItem('mailvault-settings', settings.settings);
        } catch (e) {
          console.warn('Failed to restore settings:', e);
        }
      }

      setTimeout(() => {
        useMailStore.getState().dismissExportProgress();
        let msg = `Backup imported successfully!\n\n${result.emailCount} email(s) from ${result.accountCount} account(s).`;
        if (result.newAccounts.length > 0) {
          msg += `\n\nNew accounts created (re-enter passwords in Settings):\n\u2022 ${result.newAccounts.join('\n\u2022 ')}`;
        }
        alert(msg + '\n\nThe page will reload.');
        window.location.reload();
      }, 1500);
    } catch (error) {
      console.error('Import error:', error);
      useMailStore.getState().dismissExportProgress();
      alert('Failed to import backup: ' + (error.message || error));
    }
  };

  // ── MBOX Export / Import ──────────────────────────────────────────────────

  const handleExportMbox = async () => {
    if (!invoke) {
      alert('MBOX export is only available in the desktop app.');
      return;
    }
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const destPath = await save({
        defaultPath: `mailvault-export-${new Date().toISOString().split('T')[0]}.mbox`,
        filters: [{ name: 'MBOX Files', extensions: ['mbox'] }],
      });
      if (!destPath) return;

      const store = useMailStore.getState();
      store.setExportProgress({ total: 0, completed: 0, active: true, mode: 'export' });

      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen('mbox-export-progress', (event) => {
        const p = event.payload;
        useMailStore.getState().setExportProgress({
          total: p.total, completed: p.completed, active: p.active, mode: 'export'
        });
      });

      let result;
      try {
        result = await invoke('export_mbox_all', { destPath, archivedOnly: false });
      } finally {
        unlisten();
      }

      setTimeout(() => {
        useMailStore.getState().dismissExportProgress();
        alert(`MBOX exported successfully!\n\n${result.emailCount} email(s) from ${result.accountCount} account(s).`);
      }, 1500);
    } catch (error) {
      console.error('MBOX export error:', error);
      useMailStore.getState().dismissExportProgress();
      alert('Failed to export MBOX: ' + (error.message || error));
    }
  };

  const handleImportMbox = async () => {
    if (!invoke) {
      alert('MBOX import is only available in the desktop app.');
      return;
    }
    if (!visibleAccounts.length) {
      alert('Add an email account first before importing an MBOX file.');
      return;
    }
    try {
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
      const sourcePath = await openDialog({
        filters: [{ name: 'MBOX Files', extensions: ['mbox'] }],
        multiple: false,
      });
      if (!sourcePath) return;

      const targetAccount = visibleAccounts[0];
      const targetMailbox = 'INBOX';

      const store = useMailStore.getState();
      store.setExportProgress({ total: 0, completed: 0, active: true, mode: 'import' });

      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen('mbox-import-progress', (event) => {
        const p = event.payload;
        useMailStore.getState().setExportProgress({
          total: p.total, completed: p.completed, active: p.active, mode: 'import'
        });
      });

      let result;
      try {
        result = await invoke('import_mbox', {
          sourcePath,
          accountId: targetAccount.id,
          mailbox: targetMailbox,
        });
      } finally {
        unlisten();
      }

      setTimeout(() => {
        useMailStore.getState().dismissExportProgress();
        alert(`MBOX imported successfully!\n\n${result.emailCount} email(s) imported into ${targetAccount.email || 'your account'} / ${targetMailbox}.\n\nThe page will reload.`);
        window.location.reload();
      }, 1500);
    } catch (error) {
      console.error('MBOX import error:', error);
      useMailStore.getState().dismissExportProgress();
      alert('Failed to import MBOX: ' + (error.message || error));
    }
  };

  return (
    <div className="space-y-6">
      {/* Backup & Restore (ZIP) */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <HardDrive size={18} className="text-mail-accent" />
          Backup & Restore
        </h4>

        <p className="text-sm text-mail-text-muted mb-4">
          Export your data to create a backup file, or import a previous backup to restore your emails.
        </p>

        <div className="flex gap-3">
          <button
            onClick={handleExportData}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3
                      bg-mail-accent/10 hover:bg-mail-accent/20 text-mail-accent
                      rounded-lg transition-colors"
          >
            <Download size={18} />
            Export Backup
          </button>

          <button
            onClick={handleImportData}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3
                      bg-mail-surface-hover hover:bg-mail-border text-mail-text
                      rounded-lg transition-colors"
          >
            <Upload size={18} />
            Import Backup
          </button>
        </div>
      </div>

      {/* MBOX Import / Export */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <HardDrive size={18} className="text-mail-accent" />
          MBOX Import / Export
        </h4>

        <p className="text-sm text-mail-text-muted mb-4">
          Export all emails as a standard MBOX file compatible with Thunderbird, Apple Mail, and other email clients. You can also import an MBOX file to restore emails.
        </p>

        <div className="flex gap-3">
          <button
            onClick={handleExportMbox}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3
                      bg-mail-accent/10 hover:bg-mail-accent/20 text-mail-accent
                      rounded-lg transition-colors"
          >
            <Download size={18} />
            Export MBOX
          </button>

          <button
            onClick={handleImportMbox}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3
                      bg-mail-surface-hover hover:bg-mail-border text-mail-text
                      rounded-lg transition-colors"
          >
            <Upload size={18} />
            Import MBOX
          </button>
        </div>
      </div>

      {/* Export choice modal */}
      <AnimatePresence>
        {showExportChoice && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]"
            onClick={() => setShowExportChoice(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-mail-bg border border-mail-border rounded-xl shadow-xl max-w-sm w-full mx-4 p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-semibold text-mail-text mb-2">Export Backup</h3>
              <p className="text-sm text-mail-text-muted mb-5">
                Which emails would you like to export?
              </p>
              <div className="flex flex-col gap-3">
                <button
                  onClick={() => doExport(true)}
                  className="w-full px-4 py-3 bg-mail-accent hover:bg-mail-accent-hover
                            text-white rounded-lg font-medium transition-colors text-left"
                >
                  <span className="block">Archived Emails</span>
                  <span className="block text-xs font-normal opacity-80 mt-0.5">Only emails you've explicitly saved to your device</span>
                </button>
                <button
                  onClick={() => setShowExportChoice(false)}
                  className="w-full px-4 py-2 text-sm text-mail-text-muted hover:text-mail-text
                            transition-colors"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
