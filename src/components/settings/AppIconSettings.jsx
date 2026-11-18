import React from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { APP_ICONS, applyAppIcon, normalizeAppIcon } from '../../utils/appIcon';
import { AppIconView } from './views/AppIconView';
import { DesktopViewEnv } from './DesktopViewEnv';

/** Desktop's container: switches the dock icon (`applyAppIcon`), then stores it. */
export function AppIconSettings() {
  const selected = useSettingsStore(s => normalizeAppIcon(s.appIcon));
  const setAppIcon = useSettingsStore(s => s.setAppIcon);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState(false);
  const choose = async icon => {
    setPending(true);
    setError(false);
    try {
      await applyAppIcon(icon);
      setAppIcon(icon);
    } catch { setError(true); }
    finally { setPending(false); }
  };
  return <DesktopViewEnv><AppIconView icons={APP_ICONS} selected={selected} pending={pending} error={error} onChoose={choose} /></DesktopViewEnv>;
}
