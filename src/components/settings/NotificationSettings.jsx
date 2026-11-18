import React, { useState, useEffect } from 'react';
import { useSettingsStore, getAccountInitial, getAccountColor } from '../../stores/settingsStore';
import { getNotificationDecisions, clearNotificationDecisions } from '../../stores/focusStore';
import { decodeImapUtf7 } from '../../utils/imapUtf7';
import { NOTIFICATION_SOUNDS, normalizeNotificationSound } from '../../utils/notificationSounds';
import { previewNotificationSound } from '../../services/api';
import { DesktopViewEnv } from './DesktopViewEnv';
import { NotificationsView } from './views/NotificationsView';

// The folders an account can notify for (desktop's fixed names).
const COMMON_FOLDERS = ['INBOX', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive'];

/**
 * Desktop's container: the settings store over NotificationsView, with the
 * Mac's named sounds, the decision log (focusStore), backup notifications and
 * the dock badge.
 */
export function NotificationSettings({ accounts }) {
  const {
    notificationSettings,
    setNotificationEnabled,
    setNotificationShowPreview,
    setNotificationSound,
    setAccountNotificationEnabled,
    setAccountNotificationFolders,
    setAccountQuietHours,
    addImportantSender,
    removeImportantSender,
    setImportantSenderThroughQuietHours,
    badgeEnabled,
    setBadgeEnabled,
    badgeMode,
    setBadgeMode,
    accountColors,
    isAccountHidden,
    getDisplayName,
    getOrderedAccounts,
    backupNotifyOnSuccess,
    backupNotifyOnFailure,
    setBackupNotifyOnSuccess,
    setBackupNotifyOnFailure,
  } = useSettingsStore();

  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [decisions, setDecisions] = useState([]);
  const isMac = typeof navigator !== 'undefined' && navigator.platform?.startsWith('Mac');
  const selectedSound = normalizeNotificationSound(notificationSettings.sound);

  // The log is a plain in-memory ring, not a store — refresh on open and on
  // demand. // ponytail: not live-updating; good enough for a settings panel.
  const refreshDecisions = () => setDecisions(getNotificationDecisions().slice().reverse());
  useEffect(() => { refreshDecisions(); }, []);

  const previewSound = async () => {
    setPreviewing(true);
    setPreviewError(false);
    try {
      await previewNotificationSound(selectedSound);
    } catch {
      setPreviewError(true);
    } finally {
      setPreviewing(false);
    }
  };

  const shownAccounts = getOrderedAccounts(accounts).filter(a => !isAccountHidden(a.id)).map(account => {
    const name = getDisplayName(account.id) || account.email;
    return {
      id: account.id,
      name,
      color: getAccountColor(accountColors, account),
      initial: getAccountInitial(account, name),
      config: notificationSettings.accounts[account.id] || { enabled: true, folders: ['INBOX'] },
      folderOptions: COMMON_FOLDERS.map(path => ({ path, label: decodeImapUtf7(path) })),
    };
  });

  return (
    <DesktopViewEnv>
      <NotificationsView
        enabled={notificationSettings.enabled} onEnabled={setNotificationEnabled}
        showPreview={notificationSettings.showPreview} onShowPreview={setNotificationShowPreview}
        sound={isMac ? {
          kind: 'choice', value: selectedSound, sounds: NOTIFICATION_SOUNDS, previewing, previewError, onPreview: previewSound,
          onChange: (value) => { setNotificationSound(value); setPreviewError(false); },
        } : null}
        accounts={shownAccounts} onAccountEnabled={setAccountNotificationEnabled}
        onAccountFolders={setAccountNotificationFolders} onAccountQuietHours={setAccountQuietHours}
        importantSenders={notificationSettings.importantSenders || []} onAddSender={addImportantSender}
        onRemoveSender={removeImportantSender} onSenderThroughQuietHours={setImportantSenderThroughQuietHours}
        decisionLog={{ decisions, onRefresh: refreshDecisions, onClear: () => { clearNotificationDecisions(); refreshDecisions(); } }}
        backup={{ onSuccess: backupNotifyOnSuccess, onFailure: backupNotifyOnFailure, setOnSuccess: setBackupNotifyOnSuccess, setOnFailure: setBackupNotifyOnFailure }}
        badge={{ enabled: badgeEnabled, mode: badgeMode, onEnabled: setBadgeEnabled, onMode: setBadgeMode }} />
    </DesktopViewEnv>
  );
}
