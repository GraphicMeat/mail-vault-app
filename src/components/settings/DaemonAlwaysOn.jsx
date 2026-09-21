import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { SettingRow } from './SettingRow';
import { ToggleSwitch } from './ToggleSwitch';
import { useSettingsStore } from '../../stores/settingsStore';
import { useT } from '../../i18n/index.js';

// `reason` keys the backend returns → catalog keys. The backend holds no copy;
// it reports which mechanism is missing, this says what that means to a person.
const REASON_KEYS = {
  snap: 'settings.daemon.alwaysOn.unsupportedSnap',
  'no-stable-executable': 'settings.daemon.alwaysOn.unsupportedNoStableExecutable',
  'macos-version': 'settings.daemon.alwaysOn.unsupportedMacosVersion',
  'not-bundled': 'settings.daemon.alwaysOn.unsupportedNotBundled',
  platform: 'settings.daemon.alwaysOn.unsupportedPlatform',
};

/**
 * "Keep running in the background" — the login item plus the daemon outliving
 * app quit.
 *
 * The switch reflects what the OS reports, never what was clicked: registering
 * a login item can be refused, and on macOS it can land in "waiting for your
 * approval in System Settings", which looks on but starts nothing. So every
 * change re-reads the real state, and the store is written from *that*.
 *
 * The store copy is not decoration — Rust reads `daemonAlwaysOn` out of the
 * persisted settings file during app exit, when the webview is already gone,
 * to decide whether to stop the daemon it spawned.
 */
export function DaemonAlwaysOn() {
  const alwaysOn = useSettingsStore((s) => s.daemonAlwaysOn);
  const setDaemonAlwaysOn = useSettingsStore((s) => s.setDaemonAlwaysOn);
  const t = useT();
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const sync = useCallback(async (command, args = {}) => {
    const { invoke } = await import('@tauri-apps/api/core');
    const next = await invoke(command, args);
    setState(next);
    // The OS is the source of truth. A refused or approval-pending
    // registration must not leave the persisted flag claiming success.
    setDaemonAlwaysOn(!!next.enabled);
    return next;
  }, [setDaemonAlwaysOn]);

  useEffect(() => {
    // No backend (browser preview, an older build): the row stays hidden
    // rather than offering a switch that reaches nothing.
    sync('autostart_state').catch(() => setState(null));
  }, [sync]);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await sync('set_autostart', { enabled: !alwaysOn });
    } catch (e) {
      setError(String(e?.message || e));
      // Re-read rather than assume the failure changed nothing.
      await sync('autostart_state').catch(() => {});
    }
    setBusy(false);
  };

  if (!state) return null;

  const reasonKey = REASON_KEYS[state.reason];

  return (
    <div className="settings-section">
      <SettingRow
        label={t('settings.daemon.alwaysOn.label')}
        description={t('settings.daemon.alwaysOn.description')}
      >
        <ToggleSwitch
          active={alwaysOn}
          disabled={!state.supported || busy}
          onClick={toggle}
          testId="daemon-always-on"
          label={t('settings.daemon.alwaysOn.label')}
        />
      </SettingRow>

      {!state.supported && reasonKey && (
        <p className="mt-2 text-xs text-mail-text-muted">{t(reasonKey)}</p>
      )}

      {state.needsApproval && (
        <p className="mt-2 text-xs text-mail-warning flex items-start gap-1.5">
          <AlertTriangle size={14} className="mt-px shrink-0" />
          {t('settings.daemon.alwaysOn.needsApproval')}
        </p>
      )}

      {error && (
        <p className="mt-2 text-xs text-mail-danger" role="alert">
          {t('settings.daemon.alwaysOn.failed', { error })}
        </p>
      )}
    </div>
  );
}
