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
      alert('Exporting a backup is only available in the desktop app.');
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
      alert('Could not write the backup file. Pick a folder you can write to, make sure there is room on the disk, and try again.\n\nDetails: ' + (error.message || error));
    }
  };

  const handleImportData = async () => {
    if (!invoke) {
      alert('Importing a backup is only available in the desktop app.');
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
      alert('Could not read that backup file. Pick the .zip MailVault wrote — nothing in your vault was changed.\n\nDetails: ' + (error.message || error));
    }
  };

  // ── MBOX Export / Import ──────────────────────────────────────────────────

  const handleExportMbox = async () => {
    if (!invoke) {
      alert('Exporting MBOX is only available in the desktop app.');
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
        alert(`MBOX written. ${result.emailCount} email(s) from ${result.accountCount} account(s) are in the file — Thunderbird, Apple Mail and anything else that reads MBOX can open it.`);
      }, 1500);
    } catch (error) {
      console.error('MBOX export error:', error);
      useMailStore.getState().dismissExportProgress();
      alert('Could not write the MBOX file. Pick a folder you can write to, make sure there is room on the disk, and try again.\n\nDetails: ' + (error.message || error));
    }
  };

  const handleImportMbox = async () => {
    if (!invoke) {
      alert('Importing MBOX is only available in the desktop app.');
      return;
    }
    if (!visibleAccounts.length) {
      alert('Add an email account first — an imported MBOX has to land in one.');
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
        alert(`MBOX imported. ${result.emailCount} email(s) are now in your vault under ${targetAccount.email || 'your account'} / ${targetMailbox}.\n\nMailVault reloads when you close this.`);
        window.location.reload();
      }, 1500);
    } catch (error) {
      console.error('MBOX import error:', error);
      useMailStore.getState().dismissExportProgress();
      alert('Could not read that MBOX file. Check it is the file you meant — nothing in your vault was changed.\n\nDetails: ' + (error.message || error));
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
          Write everything in your vault to a single .zip you can copy anywhere, or read one back in.
        </p>

        <div className="flex gap-3">
          <Button variant="accentTint" className="flex-1 py-3"
            onClick={handleExportData}
          >
            <Download size={18} />
            Export Backup
          </Button>

          <Button variant="subtle" className="flex-1 py-3"
            onClick={handleImportData}
          >
            <Upload size={18} />
            Import Backup
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
          Write your vault to a standard MBOX file that Thunderbird, Apple Mail and other clients can open, or read an MBOX from another client into your vault.
        </p>

        <div className="flex gap-3">
          <Button variant="accentTint" className="flex-1 py-3"
            onClick={handleExportMbox}
          >
            <Download size={18} />
            Export MBOX
          </Button>

          <Button variant="subtle" className="flex-1 py-3"
            onClick={handleImportMbox}
          >
            <Upload size={18} />
            Import MBOX
          </Button>
        </div>
      </div>

      {/* Export choice modal */}
      <Dialog
        open={showExportChoice}
        onClose={() => setShowExportChoice(false)}
        size="sm"
        title="Export Backup"
        // This asked "Which emails would you like to export?" and then offered
        // one button and Cancel. A question with a single answer is not a
        // choice — say what the export contains instead.
        description="The .zip holds everything in your vault, plus your accounts and settings. Mail that only exists on the server is not included."
      >
        <div className="flex flex-col gap-3">
          <Button variant="primary" size="lg" onClick={() => doExport(true)} fullWidth className="py-3 text-left justify-start">
            <span className="block">
              Choose a location
              <span className="block text-xs font-normal opacity-80 mt-0.5">Pick where to write the backup file</span>
            </span>
          </Button>
          <Button variant="ghost" onClick={() => setShowExportChoice(false)} fullWidth data-autofocus>
            Cancel
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
