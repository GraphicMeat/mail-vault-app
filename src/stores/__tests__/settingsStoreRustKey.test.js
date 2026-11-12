/**
 * The Rust side (daemon, shell, core) reads this store straight out of
 * `frontend-settings.json` at `<persist name>.state.<key>`, through the one
 * constant `settings_doc::STORE` (src-core/src/settings_doc.rs). Renaming the
 * store, or a migration that renames, drops or retypes a key a Rust reader
 * uses, must fail here, not as a silently ignored setting.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../safeStorage', () => {
  const store = {};
  return {
    safeStorage: {
      getItem: (key) => store[key] || null,
      setItem: (key, val) => { store[key] = val; },
      removeItem: (key) => { delete store[key]; },
    },
  };
});

const { useSettingsStore } = await import('../settingsStore');
const rust = readFileSync('src-core/src/settings_doc.rs', 'utf8');

/**
 * Every `state` key a Rust reader takes from the store, with the type of its
 * default here, and where it is read. Found from the readers of
 * `settings_doc::app_state` and `<STORE>.state` and what they hand the state
 * to. Add a key when a Rust reader starts using one.
 */
const RUST_READS = {
  // src-core/src/autostart.rs (the shell at quit and close)
  daemonAlwaysOn: 'boolean',
  closeToTray: 'boolean',
  // src-core/src/log_redact.rs
  logVerbosity: 'string',
  // src-core/src/transfer_limits.rs, handlers/policy.rs, backup_worker.rs
  transferLimits: 'object',
  // daemon arrival.rs, handlers/alias_store.rs, handlers/compose_prep.rs
  sendAsAddresses: 'object',
  aliases: 'object',
  dismissedAliases: 'object',
  displayNames: 'object',
  notificationSettings: 'object',
  // src-core/src/backup_schedule.rs, backup_worker.rs, handlers/backup_schedule.rs
  backupState: 'object',
  backupHistory: 'object',
  snapshotLastTimes: 'object',
  backupGlobalEnabled: 'boolean',
  backupGlobalConfig: 'object',
  backupSchedules: 'object',
  backupMailboxConcurrency: 'number',
  backupNotifyOnSuccess: 'boolean',
  backupNotifyOnFailure: 'boolean',
  snapshotAutoEnabled: 'boolean',
  snapshotCadence: 'string',
  hiddenAccounts: 'object',
  // cleanup_worker.rs
  cleanupLastRun: 'null',
  externalBackupLocation: 'null',
  // src-core/src/body_scan (RowSettings::from_state, handlers/body.rs)
  linkAlerts: 'object',
  linkSafetyEnabled: 'boolean',
  trackerAlerts: 'object',
  // src-core/src/fetch_mode.rs (FetchPolicy::from_settings)
  fetchMode: 'string',
  fetchModePremium: 'boolean',
  fetchModes: 'object',
  localCacheDurationMonths: 'number',
  // ordinary_runner.rs
  autoDownloadAttachments: 'boolean',
  // refresh_worker.rs
  graphFolderKeysAdopted: 'object',
  graphFolderKeysAdoptedFromListing: 'object',
  // handlers/settings.rs (a change wakes the backup worker)
  billingProfile: 'null',
  shareGrant: 'object',
  // src-tauri/src/settings.rs, src-tauri/src/updater.rs
  showMenuBar: 'boolean',
  updateTrack: 'null',
};

const kind = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

describe('the Rust readers of the persisted settings store', () => {
  it('use the persist name this store writes', () => {
    const { name } = useSettingsStore.persist.getOptions();
    expect(rust).toContain(`pub const STORE: &str = "${name}";`);
  });

  it.each(Object.entries(RUST_READS))('find %s in the store defaults as a %s', (key, type) => {
    const state = useSettingsStore.getState();
    expect(Object.hasOwn(state, key), key).toBe(true);
    expect(kind(state[key]), key).toBe(type);
  });
});
