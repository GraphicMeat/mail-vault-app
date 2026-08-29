import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const AUDIT = resolve(process.cwd(), 'scripts/i18n-audit.mjs');

// Every task appends the files it drained. A file listed here can never regress.
const DONE = [
  'src/components/Sidebar.jsx',
  'src/components/settings/StorageSettings.jsx',
  'src/components/settings/AppearanceSettings.jsx',
  'src/components/settings/MailStorageLocation.jsx',
  'src/components/settings/AccountSettings.jsx',
  'src/components/settings/AISettings.jsx',
  'src/components/settings/SendAsVerifyModal.jsx',
  'src/components/settings/MigrationSettings.jsx',
  'src/components/settings/BehaviorSettings.jsx',
  'src/components/settings/ShortcutsSettings.jsx',
  'src/components/settings/BillingSettings.jsx',
  'src/components/settings/BackupAccountCard.jsx',
  'src/components/settings/BackupConfig.jsx',
  'src/components/settings/BackupRestore.jsx',
  'src/components/settings/BackupSchedule.jsx',
  'src/components/settings/BackupVerificationTree.jsx',
  'src/components/settings/NotificationSettings.jsx',
  'src/components/settings/TimeCapsuleSettings.jsx',
  'src/components/settings/CleanupSettings.jsx',
  'src/components/settings/TrackerBlockingView.jsx',
  'src/components/settings/TemplateSettings.jsx',
  'src/components/settings/SecuritySettings.jsx',
  'src/components/settings/HelpSettings.jsx',
  'src/components/settings/DataUsageAccountCard.jsx',
  'src/components/settings/LogsSettings.jsx',
  'src/components/settings/DataUsageSettings.jsx',
  'src/components/settings/DaemonSettings.jsx',
  'src/components/ComposeModal.jsx',
  'src/components/AccountModal.jsx',
  'src/components/ChangeServerModal.jsx',
  'src/components/RichTextEditor.jsx',
  'src/components/ContactsPicker.jsx',
  'src/components/EmailList.jsx',
  'src/components/SelectionActionBar.jsx',
  'src/components/SearchBar.jsx',
  'src/components/email/EmailHeaderComponent.jsx',
  'src/components/email/AttachmentBar.jsx',
  'src/components/EmailViewer.jsx',
  'src/components/email/OriginalEmailModal.jsx',
  'src/components/RowActionMenuItems.jsx',
  'src/components/export/ExportUpsellModal.jsx',
  'src/components/email/FullViewEmailModal.jsx',
  'src/components/export/ExportDialog.jsx',
  'src/components/MoveToFolderDropdown.jsx',
  'src/components/email/ThreadView.jsx',
  'src/components/EmailRow.jsx',
  'src/components/BulkSelectionBubble.jsx',
  'src/components/ThreadRow.jsx',
  'src/components/email/EmailSenderInfo.jsx',
  'src/components/BulkSaveProgress.jsx',
  'src/components/RowActionMenu.jsx',
  'src/components/email/SenderInfoPopover.jsx',
  'src/App.jsx',
  'src/components/TimeCapsule.jsx',
  'src/components/BulkOperationsModal.jsx',
  'src/components/ShareUnlockModal.jsx',
  'src/components/MigrationToast.jsx',
  'src/components/ChatBubbleView.jsx',
  'src/components/UpdateModal.jsx',
  'src/components/Onboarding.jsx',
  'src/components/BugReportDialog.jsx',
  'src/components/OutboxTray.jsx',
  'src/components/SpellcheckHelpDialog.jsx',
  'src/components/RestoreModal.jsx',
  'src/components/BulkOperationProgress.jsx',
  'src/components/ChatSenderList.jsx',
  'src/components/BackupUpsellModal.jsx',
  'src/components/ShortcutsModal.jsx',
  'src/components/LinkSafetyModal.jsx',
  'src/components/ReplyToAlertIcon.jsx',
  'src/components/LinkAlertIcon.jsx',
  'src/components/TransferLimitBanner.jsx',
  'src/components/SettingsPage.jsx',
  'src/components/SenderAlertIcon.jsx',
  'src/components/UndoSendToast.jsx',
  'src/components/ChunkErrorBoundary.jsx',
  'src/components/KeychainToast.jsx',
  'src/components/RestoreTray.jsx',
  'src/components/VaultAlertBanner.jsx',
  'src/components/Toast.jsx',
  'src/components/PremiumFeaturesLink.jsx',
  'src/components/ChatTopicsList.jsx',
  'src/components/TrackerAlertIcon.jsx',
];

function audit(mode, files) {
  try {
    execFileSync('node', [AUDIT, mode, ...files], { encoding: 'utf8' });
    return '';
  } catch (e) {
    return e.stdout || String(e);
  }
}

describe('extracted files stay drained', () => {
  it('has no hardcoded JSX strings left', () => {
    expect(audit('strings', DONE)).toBe('');
  });

  it('has no component calling t() without useT()', () => {
    expect(audit('hooks', DONE)).toBe('');
  });
});
