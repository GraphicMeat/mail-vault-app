// ── workflows/transferAccounts — encrypted account transfer (export / import) ──
//
// The daemon owns the file format and the crypto (`transfer.*` RPCs); this
// module gathers what goes in and applies what comes out. The app stays the
// only keychain writer. Errors reach the caller as the daemon's own message,
// which starts with its `E_*` code, or as `E_KEYCHAIN_UNAVAILABLE` from here.
// Never log a password, a bundle, the base64 payload or an account object.

import { daemonCall } from '../daemonClient';
import { getAccounts, saveAccounts, accountLogicalKey } from '../db';
import * as keychainSession from '../keychainSession';
import { collectSettings, applySettings } from '../transfer/settingsTransfer';
import { useSettingsStore, getAccountColor } from '../../stores/settingsStore';
import { useThemeStore } from '../../stores/themeStore';

async function appVersion() {
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch {
    return undefined; // informational only
  }
}

/** Encrypt the chosen accounts (with secrets) and settings. Returns base64. */
export async function exportTransfer({ accountIds, includeAppSettings, password }) {
  const accounts = await getAccounts();
  // A denied/locked keychain hands back accounts without secrets; the daemon
  // would name them E_TRANSFER_INCOMPLETE, but the real cause is the keychain.
  // 'empty' (a successful read that found no stored credentials, e.g. every
  // account was added by hand this session) is not a failure to read.
  if (!['granted', 'empty'].includes(keychainSession.getStatus())) throw new Error(keychainSession.E_KEYCHAIN_UNAVAILABLE);

  const settings = collectSettings(accountIds);
  const bundle = {
    formatVersion: 1,
    exportedAt: Date.now(),
    appVersion: await appVersion(),
    accounts: accounts.filter(a => accountIds.includes(a.id)),
    ...settings,
    appSettings: includeAppSettings ? settings.appSettings : null,
    theme: includeAppSettings ? settings.theme : null,
  };
  const { data } = await daemonCall('transfer.export', { password, bundle, includeAppConfig: !!includeAppSettings });
  console.log('[transfer] exported', bundle.accounts.length, 'account(s)');
  return data;
}

/**
 * Seal every account (with secrets) and the desktop's phone-relevant settings for the phone. The
 * daemon maps, fits the settings into the code (dropping templates, then images in signatures,
 * then signatures), encrypts and renders the QR frames:
 * `{ frames: [svg], count, skipped: [{ email, reason }] }`.
 * Same keychain gate as exportTransfer: a locked keychain would otherwise
 * read as every account "no saved password". The accounts go in the order the
 * desktop lists them, each with the color it shows, the name it sends mail with and whether it is
 * hidden, so the phone matches.
 */
export async function phoneQr({ password }) {
  const accounts = await getAccounts();
  if (!['granted', 'empty'].includes(keychainSession.getStatus())) throw new Error(keychainSession.E_KEYCHAIN_UNAVAILABLE);
  const s = useSettingsStore.getState();
  const { getOrderedAccounts, accountColors = {}, displayNames = {}, hiddenAccounts = {} } = s;
  const shown = getOrderedAccounts(accounts).map(a => ({
    ...a,
    color: getAccountColor(accountColors, a),
    // The name the desktop sends with (sendAsSuggestions: alias name, else this, else the form's).
    name: displayNames[a.id] || a.name,
    hidden: !!hiddenAccounts[a.id],
    phoneSettings: phoneAccountSettings(s, a),
  }));
  return daemonCall('transfer.phone_qr', { password, accounts: shown, settings: phoneGlobalSettings(s, useThemeStore.getState()) });
}

// The desktop settings the phone takes (the phone applies them on its first import that carries
// them). Never: backup*, snapshot*, cleanupRules, transferLimits, billing, AI keys, PGP, sound,
// badge, refreshInterval, daemon*, onboarding, layout or other UI memory.
const PHONE_GLOBAL_KEYS = [
  'language', 'emailViewerTheme', 'dateFormat', 'customDateFormat', 'timeFormat', 'threadMode', 'threadSortOrder',
  'markAsReadMode', 'markAsReadDelay', 'confirmBeforeDelete', 'afterDeleteSelect', 'swipeLeftAction', 'swipeRightAction',
  'sendDelay', 'autoSaveDrafts', 'attachmentReminder', 'defaultSignatureEnabled', 'holdExternalContent',
  'linkSafetyEnabled', 'linkSafetyClickConfirm', 'trackerBlockingEnabled',
];

function phoneGlobalSettings(s, theme) {
  const out = Object.fromEntries(PHONE_GLOBAL_KEYS.filter(k => s[k] !== undefined && s[k] !== null).map(k => [k, s[k]]));
  if (theme?.theme) out.theme = theme.theme;
  if (theme?.palette) out.palette = theme.palette;
  const n = s.notificationSettings || {};
  if (typeof n.showPreview === 'boolean') out.notificationPreview = n.showPreview;
  if (Array.isArray(n.importantSenders)) {
    out.importantSenders = n.importantSenders
      .filter(e => e && typeof e.match === 'string')
      .map(e => ({ match: e.match, throughQuietHours: !!e.throughQuietHours }));
  }
  if (Array.isArray(s.emailTemplates) && s.emailTemplates.length) {
    out.templates = s.emailTemplates
      .filter(tpl => tpl && typeof tpl.body === 'string')
      .map(tpl => ({ name: String(tpl.name || ''), body: tpl.body }));
  }
  return out;
}

function phoneAccountSettings(s, account) {
  const id = account.id;
  const out = {};
  const sig = s.signatures?.[id];
  if (sig && (sig.html || sig.text)) out.signature = { html: sig.html || '', text: sig.text || '', enabled: sig.enabled !== false };
  const sendAs = s.sendAsAddresses?.[id];
  if (typeof sendAs === 'string' && sendAs) out.sendAs = sendAs;
  const aliases = s.aliases?.[id];
  if (Array.isArray(aliases) && aliases.length) {
    out.aliases = aliases.filter(a => a?.address).map(a => ({ address: a.address, name: a.name || '' }));
  }
  if (account.sentFolderOverride) out.sentFolderOverride = account.sentFolderOverride;
  const notify = s.notificationSettings?.accounts?.[id];
  if (notify && typeof notify === 'object') {
    out.notifications = {
      ...(typeof notify.enabled === 'boolean' ? { enabled: notify.enabled } : {}),
      ...(Array.isArray(notify.folders) ? { folders: notify.folders } : {}),
      ...(notify.quietHours ? { quietHours: notify.quietHours } : {}),
    };
  }
  const mode = s.fetchModes?.[id] || s.fetchMode;
  if (mode) out.fetchMode = mode;
  if (typeof s.localCacheDurationMonths === 'number') out.cacheMonths = s.localCacheDurationMonths;
  return out;
}

/** Decrypt a transfer file's base64 contents into its bundle. */
export async function decryptTransfer({ password, data }) {
  return daemonCall('transfer.decrypt', { password, data });
}

/**
 * What an import would do, for the picker: one row per file account.
 * `targetId` is the existing account's id for one already here, else null
 * (applyImport assigns it, minting a fresh id only on an id collision).
 */
export function planImport(bundle, existingAccounts) {
  const byKey = new Map(existingAccounts.map(a => [accountLogicalKey(a), a]));
  return {
    rows: (bundle.accounts || []).map(a => {
      const match = byKey.get(accountLogicalKey(a));
      return {
        fileId: a.id,
        email: a.email,
        provider: a.oauth2Provider || a.imapHost || null,
        alreadyAdded: !!match,
        targetId: match ? match.id : null,
      };
    }),
  };
}

/**
 * Import the selected accounts, their settings and (optionally) app settings
 * plus app.db config. Accounts already here (same logical key) are never
 * re-saved and their file settings are dropped; they still map to the local
 * id so imported views/fields that name them keep working.
 * `aiKeyError`, `contactsError` and `settingsError` are soft warnings (the AI
 * key did not reach the keychain / the contacts did not import / the settings
 * file write failed); the accounts are saved.
 */
export async function applyImport(bundle, { selectedIds, applyAppSettings }) {
  const existing = await getAccounts();
  const existingByKey = new Map(existing.map(a => [accountLogicalKey(a), a]));
  const existingIds = new Set(existing.map(a => a.id));

  const idMap = {};
  const importedIds = new Set();
  let toSave = [];
  for (const file of bundle.accounts || []) {
    const key = accountLogicalKey(file);
    const match = existingByKey.get(key);
    if (match) { idMap[file.id] = match.id; continue; }
    if (!selectedIds.includes(file.id)) continue;
    const targetId = existingIds.has(file.id) ? crypto.randomUUID() : file.id;
    idMap[file.id] = targetId;
    importedIds.add(file.id);
    toSave.push({ ...file, id: targetId, createdAt: Date.now() });
    // A file that lists the same account twice must not save it twice.
    existingByKey.set(key, { id: targetId });
    existingIds.add(targetId);
  }

  // Throws E_KEYCHAIN_UNAVAILABLE before any write, E_KEYCHAIN_WRITE if a write fails.
  let accepted = await saveAccounts(toSave);
  if (accepted.outcome === 'retiredIdsRefused') {
    const remapped = new Map(accepted.retiredIds.map(id => [id, crypto.randomUUID()]));
    for (const [fileId, targetId] of Object.entries(idMap)) {
      if (remapped.has(targetId)) idMap[fileId] = remapped.get(targetId);
    }
    toSave = toSave.map(row => remapped.has(row.id) ? { ...row, id: remapped.get(row.id) } : row);
    for (const [oldId, newId] of remapped) {
      existingIds.delete(oldId);
      existingIds.add(newId);
    }
    accepted = await saveAccounts(toSave);
    if (accepted.outcome === 'retiredIdsRefused') {
      throw new Error(`${keychainSession.E_KEYCHAIN_WRITE}: errors.keychainBusy`);
    }
  }
  const acceptedIds = new Set(accepted.accepted);
  for (const [fileId, targetId] of Object.entries(idMap)) {
    if (Object.hasOwn(accepted.skipped, targetId)) idMap[fileId] = accepted.skipped[targetId];
    if (importedIds.has(fileId) && !acceptedIds.has(targetId)) importedIds.delete(fileId);
  }

  const importedMap = Object.fromEntries(Object.entries(idMap).filter(([id]) => importedIds.has(id)));
  const { settingsError } = await applySettings(bundle, importedMap, { applyGlobal: applyAppSettings, existingIds: existing.map(a => a.id) });

  let aiKeyError = false;
  let contactsError = false;
  if (applyAppSettings && bundle.appConfig) {
    const report = await daemonCall('transfer.apply_config', {
      appConfig: bundle.appConfig,
      accountMap: idMap,
      aiEndpointKey: bundle.aiEndpointKey ?? undefined,
    });
    aiKeyError = !!report?.aiKeyError;
    contactsError = !!report?.contactsError;
  }
  console.log('[transfer] imported', accepted.accepted.length, 'account(s)');
  return { imported: accepted.accepted.length, aiKeyError, contactsError, settingsError };
}
