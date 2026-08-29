import React, { useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { useMailStore } from '../../stores/mailStore';
import { useAccountStore } from '../../stores/accountStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { safeStorage } from '../../stores/safeStorage';
import { motion } from 'framer-motion';
import {
  Download,
  Upload,
  HardDrive,
} from 'lucide-react';
import { t, useT  } from '../../i18n/index.js';

export default function BackupRestore() {
  const t = useT();
  const hiddenAccounts = useSettingsStore(s => s.hiddenAccounts);
  const getOrderedAccounts = useSettingsStore(s => s.getOrderedAccounts);
  const accounts = useAccountStore(s => s.accounts);
  const visibleAccounts = getOrderedAccounts(accounts || []).filter(a => !hiddenAccounts?.[a.id]);

  const [showExportChoice, setShowExportChoice] = useState(false);
  const invoke = window.__TAURI__?.core?.invoke;

  // ── ZIP Export / Import ──────────────────────────────────────────────────

  const handleExportData = () => {
    if (!invoke) {
      alert(t('settings.backup.restore.exportingBackupOnlyAvailableDesktop'));
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
        filters: [{ name: t('settings.backup.restore.zipArchives'), extensions: ['zip'] }],
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
      alert(t('settings.backup.restore.couldWriteBackupFilePick') + (error.message || error));
    }
  };

  const handleImportData = async () => {
    if (!invoke) {
      alert(t('settings.backup.restore.importingBackupOnlyAvailableDesktop'));
      return;
    }
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const sourcePath = await open({
        filters: [{ name: t('settings.backup.restore.zipArchives'), extensions: ['zip'] }],
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
        let msg = `Backup restored. ${result.emailCount} email(s) from ${result.accountCount} account(s) are now in your vault.`;
        if (result.newAccounts.length > 0) {
          msg += `\n\nThese accounts were recreated and still need their passwords, under Settings \u203a Accounts:\n\u2022 ${result.newAccounts.join('\n\u2022 ')}`;
        }
        alert(msg + '\n\nMailVault reloads when you close this.');
        window.location.reload();
      }, 1500);
    } catch (error) {
      console.error('Import error:', error);
      useMailStore.getState().dismissExportProgress();
      alert(t('settings.backup.restore.couldReadBackupFilePick') + (error.message || error));
    }
  };

  // ── MBOX Export / Import ──────────────────────────────────────────────────

  const handleExportMbox = async () => {
    if (!invoke) {
      alert(t('settings.backup.restore.exportingMboxOnlyAvailableDesktop'));
      return;
    }
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const destPath = await save({
        defaultPath: `mailvault-export-${new Date().toISOString().split('T')[0]}.mbox`,
        filters: [{ name: t('settings.backup.restore.mboxFiles'), extensions: ['mbox'] }],
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
        alert(t('settings.backup.restore.mboxWrittenEmailSAccount', { result: result.emailCount, result2: result.accountCount }));
      }, 1500);
    } catch (error) {
      console.error('MBOX export error:', error);
      useMailStore.getState().dismissExportProgress();
      alert(t('settings.backup.restore.couldWriteMboxFilePick') + (error.message || error));
    }
  };

  const handleImportMbox = async () => {
    if (!invoke) {
      alert(t('settings.backup.restore.importingMboxOnlyAvailableDesktop'));
      return;
    }
    if (!visibleAccounts.length) {
      alert(t('settings.backup.restore.addEmailAccountFirstImported'));
      return;
    }
    try {
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
      const sourcePath = await openDialog({
        filters: [{ name: t('settings.backup.restore.mboxFiles'), extensions: ['mbox'] }],
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
        alert(t('settings.backup.restore.mboxImportedEmailSNow', { result: result.emailCount, targetAccount: targetAccount.email || 'your account', targetMailbox }));
        window.location.reload();
      }, 1500);
    } catch (error) {
      console.error('MBOX import error:', error);
      useMailStore.getState().dismissExportProgress();
      alert(t('settings.backup.restore.couldReadMboxFileCheck') + (error.message || error));
    }
  };

  return (
    <div className="space-y-6">
      {/* Backup & Restore (ZIP) */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <HardDrive size={18} className="text-mail-accent-text" />
          Backup & Restore
        </h4>

        <p className="text-sm text-mail-text-muted mb-4">
          {t('settings.backup.restore.writeEverythingVaultSingleZip')}
        </p>

        <div className="flex gap-3">
          <Button variant="accentTint" className="flex-1 py-3"
            onClick={handleExportData}
          >
            <Download size={18} />
            {t('settings.backup.restore.exportBackup')}
          </Button>

          <Button variant="subtle" className="flex-1 py-3"
            onClick={handleImportData}
          >
            <Upload size={18} />
            {t('settings.backup.restore.importBackup')}
          </Button>
        </div>
      </div>

      {/* MBOX Import / Export */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <HardDrive size={18} className="text-mail-accent-text" />
          MBOX Import / Export
        </h4>

        <p className="text-sm text-mail-text-muted mb-4">
          {t('settings.backup.restore.writeVaultStandardMboxFile')}
        </p>

        <div className="flex gap-3">
          <Button variant="accentTint" className="flex-1 py-3"
            onClick={handleExportMbox}
          >
            <Download size={18} />
            {t('settings.backup.restore.exportMbox')}
          </Button>

          <Button variant="subtle" className="flex-1 py-3"
            onClick={handleImportMbox}
          >
            <Upload size={18} />
            {t('settings.backup.restore.importMbox')}
          </Button>
        </div>
      </div>

      {/* Export choice modal */}
      <Dialog
        open={showExportChoice}
        onClose={() => setShowExportChoice(false)}
        size="sm"
        title={t('settings.backup.restore.exportBackup')}
        // This asked "Which emails would you like to export?" and then offered
        // one button and Cancel. A question with a single answer is not a
        // choice — say what the export contains instead.
        description="The .zip holds everything in your vault, plus your accounts and settings. Mail that only exists on the server is not included."
      >
        <div className="flex flex-col gap-3">
          <Button variant="primary" size="lg" onClick={() => doExport(true)} fullWidth className="py-3 text-left justify-start">
            <span className="block">
              {t('settings.backup.restore.chooseLocation')}
              <span className="block text-xs font-normal opacity-80 mt-0.5">{t('settings.backup.restore.pickWhereWriteBackupFile')}</span>
            </span>
          </Button>
          <Button variant="ghost" onClick={() => setShowExportChoice(false)} fullWidth data-autofocus>
            {t('common.cancel')}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
