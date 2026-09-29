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
import { send } from '../../services/transport';
import * as mboxUpload from '../../services/mboxUpload';
import MboxImportDialog from './MboxImportDialog';

export default function BackupRestore() {
  const t = useT();
  const hiddenAccounts = useSettingsStore(s => s.hiddenAccounts);
  const getOrderedAccounts = useSettingsStore(s => s.getOrderedAccounts);
  const accounts = useAccountStore(s => s.accounts);
  const visibleAccounts = getOrderedAccounts(accounts || []).filter(a => !hiddenAccounts?.[a.id]);
  const isDemo = !!window.__MAILVAULT_DEMO__;

  const [showExportChoice, setShowExportChoice] = useState(false);
  // The picked MBOX file and default account while the options dialog is open.
  const [mboxPick, setMboxPick] = useState(null);
  const invoke = window.__TAURI__?.core?.invoke;

  const refreshDemoMailbox = async (accountId) => {
    if (!isDemo || useMailStore.getState().activeAccountId !== accountId) return;
    try {
      // The production loader intentionally reuses a populated list. An
      // import is a new local source, so clear this demo view first and let
      // the normal loader hydrate the just-imported sample.
      useMailStore.setState({ emails: [], sentEmails: [], localEmails: [], savedEmailIds: new Set(), archivedEmailIds: new Set(), totalEmails: 0 });
      await useMailStore.getState().loadEmails?.();
    } catch (error) { console.warn('Demo mailbox refresh failed:', error); }
  };

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
        imapHost: a.imapHost,
        smtpHost: a.smtpHost,
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
        await send('export_backup', {
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
        result = await send('import_backup', { sourcePath });
      } finally {
        unlisten();
      }

      // Decision 2: the daemon route never writes accounts.json (a
      // cross-process race against this file's own JS writer otherwise);
      // it only returns the new-account descriptors it discovered. The app
      // merges them itself, before reload, reusing the same batch
      // read-merge-write helper `init()` already calls for this file.
      if (result.newAccounts.length > 0) {
        const db = await import('../../services/db');
        await db.ensureAccountsInFile(result.newAccounts);
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

      await refreshDemoMailbox(visibleAccounts[0]?.id);

      setTimeout(() => {
        useMailStore.getState().dismissExportProgress();
        let msg = `Backup restored. ${result.emailCount} email(s) from ${result.accountCount} account(s) are now in your vault.`;
        if (result.newAccounts.length > 0) {
          msg += `\n\nThese accounts were recreated and still need their passwords, under Settings \u203a Accounts:\n\u2022 ${result.newAccounts.map(a => a.email).join('\n\u2022 ')}`;
        }
        if (isDemo) {
          alert(msg + '\n\nThis browser demo keeps the sample in this session; no native file was read.');
        } else {
          alert(msg + '\n\nMailVault reloads when you close this.');
          window.location.reload();
        }
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
        result = await send('export_mbox_all', { destPath, archivedOnly: false });
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
      const sourcePath = await mboxUpload.pickMboxFile();
      if (!sourcePath) return;

      // The account on screen, not whichever sorts first: that is where the
      // user goes looking for what they imported. The dialog lets them change it.
      const { activeAccountId } = useMailStore.getState();
      const accountId = (visibleAccounts.find(a => a.id === activeAccountId) || visibleAccounts[0]).id;
      setMboxPick({ sourcePath, accountId });
    } catch (error) {
      console.error('MBOX import error:', error);
      alert(t('settings.backup.restore.mboxImportFailed'));
    }
  };

  // "Import and restore to the server" is a daemon job: the start answers at
  // once and the corner chip (MboxUploadProgress) follows it from its events.
  // A file that already has an upload that stopped partway keeps the dialog
  // open with a choice: resume it, or discard it and start over.
  const startServerUpload = async (options, discardJobId) => {
    const { sourcePath } = mboxPick;
    try {
      // Already gone is as good as discarded.
      if (discardJobId) await mboxUpload.discard(discardJobId).catch((e) => { if (!mboxUpload.isNotFound(e)) throw e; });
      await mboxUpload.start({ sourcePath, ...options });
      setMboxPick(null);
    } catch (error) {
      const jobId = mboxUpload.resumableJobId(error);
      if (jobId && !discardJobId) {
        setMboxPick((pick) => pick && { ...pick, resumable: { jobId, options } });
        return;
      }
      console.error('MBOX upload error:', error);
      setMboxPick(null);
      alert(t(mboxUpload.errorKey(error)));
    }
  };

  // The file was just picked, so its path goes along: after a restart a
  // sandboxed daemon may not read the one its journal holds.
  const resumeServerUpload = async () => {
    const { sourcePath, resumable } = mboxPick;
    setMboxPick(null);
    try {
      await mboxUpload.resume({ jobId: resumable.jobId, accountId: resumable.options.accountId, sourcePath });
    } catch (error) {
      console.error('MBOX upload resume error:', error);
      alert(t(mboxUpload.errorKey(error)));
    }
  };

  // `options` is what MboxImportDialog collected: accountId, mode, and for the
  // folder modes mailbox/useLabels/fallbackMailbox, sent to the daemon as is.
  const runMboxImport = async (options) => {
    if (options.mode === 'server') return startServerUpload(options);
    const { sourcePath } = mboxPick;
    setMboxPick(null);
    const targetAccount = visibleAccounts.find(a => a.id === options.accountId);
    try {
      const store = useMailStore.getState();
      store.setExportProgress({ total: 0, completed: 0, active: true, mode: 'import' });

      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen('mbox-import-progress', (event) => {
        const p = event.payload;
        // An upload to the server running meanwhile shares the event name.
        if (p?.mode === 'server') return;
        useMailStore.getState().setExportProgress({
          total: p.total, completed: p.completed, active: p.active, mode: 'import',
          bytesDone: p.bytesDone, bytesTotal: p.bytesTotal,
        });
      });

      let result;
      try {
        result = await send('import_mbox', { sourcePath, ...options });
      } finally {
        unlisten();
      }

      // "Import as a separate folder" made a new folder kept on this computer,
      // named by its display name. Opening it lists the account's folders
      // again and selects it; a reload would land on the first account's INBOX.
      const newFolder = result.folder?.name;
      if (newFolder) {
        useMailStore.getState().activateAccount(options.accountId, newFolder)
          .catch(e => console.warn('Opening the imported folder failed:', e));
      } else await refreshDemoMailbox(options.accountId);

      // The folders the daemon filed mail into (labels can spread it over
      // several), else the one it was pointed at.
      const filed = (result.folders || []).filter(f => f.imported > 0).map(f => f.mailbox);
      const targetMailbox = filed.length ? filed.join(', ') : (result.mailbox || options.mailbox || 'INBOX');
      const account = targetAccount?.email || 'your account';
      setTimeout(() => {
        useMailStore.getState().dismissExportProgress();
        let message = newFolder
          ? t('settings.backup.restore.mboxImportedToLocalFolder', { result: result.emailCount, folder: newFolder, targetAccount: account })
          : t('settings.backup.restore.mboxImportedEmailSNow', { result: result.emailCount, targetAccount: account, targetMailbox });
        if (result.skippedCount > 0) message += `\n\n${t('settings.backup.restore.mboxSkippedAlreadyInFolder', { skipped: result.skippedCount })}`;
        // Messages the daemon could not write (a folder the disk refuses, a full disk).
        if (result.failedCount > 0) message += `\n\n${t('settings.backup.restore.mboxFailedToImport', { failed: result.failedCount })}`;
        if (isDemo) alert(`${message}\n\nThis browser demo keeps the sample in this session; no native file was read.`);
        else { alert(message); if (!newFolder) window.location.reload(); }
      }, 1500);
    } catch (error) {
      console.error('MBOX import error:', error);
      useMailStore.getState().dismissExportProgress();
      // Daemon text is English and internal ("custody store unavailable:
      // closed"): never shown.
      alert(t('settings.backup.restore.mboxImportFailed'));
    }
  };

  return (
    <div className="space-y-6">
      {/* Backup & Restore (ZIP) */}
      <div className="settings-section">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <HardDrive size={18} className="text-mail-accent-text" />
          Backup & Restore
        </h4>

        <p className="text-sm text-mail-text-muted mb-4">
          {isDemo ? t('settings.backup.restore.demoBackupHint') : t('settings.backup.restore.writeEverythingVaultSingleZip')}
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
      <div className="settings-section">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <HardDrive size={18} className="text-mail-accent-text" />
          MBOX Import / Export
        </h4>

        <p className="text-sm text-mail-text-muted mb-4">
          {isDemo ? t('settings.backup.restore.demoMboxHint') : t('settings.backup.restore.writeVaultStandardMboxFile')}
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
        description={isDemo ? 'The browser demo downloads a JSON sample containing fictional vault messages. The desktop app writes a ZIP; this route never uses native file paths.' : 'The .zip holds everything in your vault, plus your accounts and settings. Mail that only exists on the server is not included.'}
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

      {/* Mounted per pick, so every file starts from fresh choices. */}
      {mboxPick && (
        <MboxImportDialog
          sourcePath={mboxPick.sourcePath}
          accounts={visibleAccounts}
          defaultAccountId={mboxPick.accountId}
          onCancel={() => setMboxPick(null)}
          onConfirm={runMboxImport}
          resumable={!!mboxPick.resumable}
          onResume={resumeServerUpload}
          onStartOver={() => startServerUpload(mboxPick.resumable.options, mboxPick.resumable.jobId)}
        />
      )}
    </div>
  );
}
