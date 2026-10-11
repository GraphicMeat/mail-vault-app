import { useEffect, useState } from 'react';
import { useSettingsStore } from '../stores/settingsStore';

/**
 * What the window does with the Rust side's `update-available`, emitted after
 * every check (the startup probe and the menu's manual check): show the
 * update dialog, keep quiet on an automatic check the user snoozed or whose
 * version they skipped, or, on the first check after a restart taken to
 * finish an install Sparkle's installer failed (UpdateInstallFailedPrompt),
 * hand the already-downloaded update straight to Sparkle, which offers it
 * ready to install. That flag is spent on the first check either way, so a
 * stale one costs one ordinary feed check, never a loop.
 *
 * MAS builds rely on the App Store for updates: the event is never emitted
 * there, and skipping the listener keeps the Sparkle plugin module out.
 */
export function useUpdateAvailable() {
  const [updateInfo, setUpdateInfo] = useState(null);

  useEffect(() => {
    if (import.meta.env.VITE_MV_APPSTORE === '1') return;
    let unlisten;
    let active = true;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('update-available', (event) => {
        const { version: newVersion, isManualCheck } = event.payload;
        const { updateSnoozeUntil, updateSkippedVersion, updateResumeAfterRestart } = useSettingsStore.getState();

        if (updateResumeAfterRestart) {
          useSettingsStore.setState({ updateResumeAfterRestart: false });
          import('tauri-plugin-sparkle-updater-api')
            .then(({ checkForUpdates }) => checkForUpdates())
            .catch(e => console.warn('[update] could not resume the install after the restart:', e));
          return;
        }

        // An automatic check respects a snooze and a skipped version.
        if (!isManualCheck) {
          if (updateSnoozeUntil && Date.now() < updateSnoozeUntil) {
            console.log('[App] Update snoozed until', new Date(updateSnoozeUntil).toISOString());
            return;
          }
          if (updateSkippedVersion === newVersion) {
            console.log('[App] Version', newVersion, 'skipped by user');
            return;
          }
        }

        // A manual check clears a stale snooze or skip so the dialog always shows.
        if (isManualCheck) {
          useSettingsStore.getState().clearUpdateSnooze();
          if (updateSkippedVersion === newVersion) {
            useSettingsStore.getState().clearSkippedVersion();
          }
        }

        // The dialog already up for this version stays as it is.
        setUpdateInfo(prev => (prev && prev.version === newVersion ? prev : event.payload));
      }).then(fn => {
        if (!active) fn();
        else unlisten = fn;
      });
    }).catch(() => {});
    return () => { active = false; if (unlisten) unlisten(); };
  }, []);

  return { updateInfo, setUpdateInfo };
}
