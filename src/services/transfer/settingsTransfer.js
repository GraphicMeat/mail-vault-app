// ── transfer/settingsTransfer — which frontend settings travel in an account transfer file ──

import { useSettingsStore } from '../../stores/settingsStore';
import { useThemeStore } from '../../stores/themeStore';
import { flushSafeStorage } from '../../stores/safeStorage';

// Deliberately NOT transferred:
// - cleanupRules: destructive automation must never silently arm on a new machine.
// - backup*, snapshot*, transferLimits, externalBackupLocation, vaultStatus: machine-bound.
// - migration*, restore*: in-flight state of this machine.
// - billing*, premiumPricing, shareGrant: licence state belongs to the account server.
// - search/filter history, graphFolderKeysAdopted*, lastMailboxPerAccount,
//   expandedFolders, pane sizes: local UI memory keyed to this machine's state.
// - daemonMode, daemonAlwaysOn, onboarding flags, localMailLabels*: per install.
export const GLOBAL_SETTINGS_ALLOWLIST = [
  'aiSettings', 'defaultSignatureEnabled', 'undoSendEnabled', 'undoSendDelay', 'sendDelay',
  'autoSaveDrafts', 'autoSaveInterval', 'spellcheckEnabled', 'composeContextVisible', 'composeOpenMode',
  'refreshInterval', 'refreshOnLaunch', 'badgeEnabled', 'badgeMode', 'markAsReadMode',
  'markAsReadDelay', 'confirmBeforeDelete', 'afterDeleteSelect', 'updateTrack',
  'autoDownloadAttachments', 'layoutMode', 'viewStyle', 'emailListStyle', 'emailListGrouping',
  'emailListView', 'listTimelineVisible', 'explorerGrouping', 'explorerDateDepth',
  'insightsPreferences', 'threadReaderLayout', 'threadSortOrder', 'threadMode',
  'emailRowHighlight', 'dateFormat', 'customDateFormat', 'timeFormat', 'language',
  'signatureDisplay', 'actionButtonDisplay', 'emailViewerTheme', 'sidebarStyle',
  'sidebarLayout', 'sidebarDensity', 'sidebarBackupStatusLocation', 'searchHistoryLimit',
  'emailTemplates', 'quickActions', 'keyboardShortcuts', 'keyboardShortcutsEnabled',
  'linkSafetyEnabled', 'linkSafetyClickConfirm', 'trackerBlockingEnabled',
  'searchIndexEnabled', 'searchIndexBodies', 'searchIndexAttachments', 'searchIndexImageText',
  'cacheLimitMB', 'localCacheDurationMonths', 'customCategories',
  'backupNotifyOnSuccess', 'backupNotifyOnFailure',
];
// notificationSettings is handled specially: globals copied, .accounts filtered per account.
export const PER_ACCOUNT_MAPS = ['signatures', 'displayNames', 'sendAsAddresses', 'accountColors', 'hiddenAccounts'];

const pickIds = (map, ids) =>
  Object.fromEntries(ids.filter(id => map && Object.hasOwn(map, id)).map(id => [id, map[id]]));

/**
 * Snapshot of the settings an export carries. Per-account entries only for
 * `accountIds`; `appSettings`/`theme` are always filled here and nulled by the
 * caller when the user leaves app settings out.
 */
export function collectSettings(accountIds) {
  const s = useSettingsStore.getState();
  const accountSettings = Object.fromEntries(PER_ACCOUNT_MAPS.map(key => [key, pickIds(s[key], accountIds)]));
  accountSettings.notificationSettings = { accounts: pickIds(s.notificationSettings?.accounts, accountIds) };

  const appSettings = Object.fromEntries(
    GLOBAL_SETTINGS_ALLOWLIST.filter(key => s[key] !== undefined).map(key => [key, s[key]]));
  const { accounts: _perAccount, ...notificationGlobals } = s.notificationSettings || {};
  appSettings.notificationSettings = notificationGlobals;

  return {
    accountSettings,
    accountOrder: (s.accountOrder || []).filter(id => accountIds.includes(id)),
    appSettings,
    theme: useThemeStore.getState().theme,
  };
}

/**
 * Apply a snapshot (a decrypted bundle) to this machine's settings.
 * `idMap` maps file account ids to target ids; per-account entries whose id is
 * not in it are dropped. Globals and theme only with `applyGlobal`.
 * `existingIds` seeds an empty account order so imported accounts land after
 * the ones already here instead of jumping to the top.
 * Resolves only after the settings file write has settled: the caller reloads
 * next. Never throws for a failed write (accounts are already saved by then);
 * returns `{ settingsError: true }` so the UI can warn instead.
 */
export async function applySettings(snapshot, idMap, { applyGlobal, existingIds = [] } = {}) {
  const s = useSettingsStore.getState();
  const remap = map => Object.fromEntries(
    Object.entries(map || {}).filter(([id]) => Object.hasOwn(idMap, id)).map(([id, value]) => [idMap[id], value]));
  const acct = snapshot.accountSettings || {};

  const patch = {};
  for (const key of PER_ACCOUNT_MAPS) patch[key] = { ...s[key], ...remap(acct[key]) };
  let notificationSettings = {
    ...s.notificationSettings,
    accounts: { ...s.notificationSettings?.accounts, ...remap(acct.notificationSettings?.accounts) },
  };

  if (applyGlobal && snapshot.appSettings) {
    for (const key of GLOBAL_SETTINGS_ALLOWLIST) {
      if (snapshot.appSettings[key] !== undefined) patch[key] = snapshot.appSettings[key];
    }
    // Mirrors settingsStore's setAiSettings: a different endpoint is never
    // pre-consented. An import must not grant consent either, even for the
    // CURRENT endpoint — only the target's own prior consent carries over,
    // never a `true` read from the file.
    if (patch.aiSettings) {
      const current = s.aiSettings || {};
      patch.aiSettings = {
        ...patch.aiSettings,
        endpointConsented: patch.aiSettings.endpointUrl === current.endpointUrl ? current.endpointConsented : false,
      };
    }
    const { accounts: _perAccount, ...globals } = snapshot.appSettings.notificationSettings || {};
    notificationSettings = { ...notificationSettings, ...globals };
  }
  patch.notificationSettings = notificationSettings;

  const fileOrder = snapshot.accountOrder || [];
  const rank = id => (fileOrder.includes(id) ? fileOrder.indexOf(id) : fileOrder.length);
  const added = Object.keys(idMap).sort((a, b) => rank(a) - rank(b)).map(id => idMap[id]);
  if (added.length) {
    const base = s.accountOrder?.length ? s.accountOrder : existingIds;
    patch.accountOrder = [...base, ...added.filter(id => !base.includes(id))];
  }

  useSettingsStore.setState(patch);
  if (applyGlobal && snapshot.theme) useThemeStore.getState().setTheme(snapshot.theme);
  try {
    await flushSafeStorage();
    return { settingsError: false };
  } catch (e) {
    console.warn('[transfer] settings file write failed:', String(e?.message ?? e));
    return { settingsError: true };
  }
}
