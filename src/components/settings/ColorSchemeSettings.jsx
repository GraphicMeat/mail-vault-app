import React from 'react';
import { AppIconSettings } from './AppIconSettings';
import { useThemeStore, PALETTES } from '../../stores/themeStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { getEmailColors } from '../../utils/mailChrome';
import { ColorSchemeView } from './views/ColorSchemeView';
import { DesktopViewEnv } from './DesktopViewEnv';

/** Desktop's container: the theme store and the settings store over ColorSchemeView. */
export function ColorSchemeSettings({ afterEmailTheme = null }) {
  const { theme, setTheme, palette, setPalette } = useThemeStore();
  const emailViewerTheme = useSettingsStore(s => s.emailViewerTheme);
  const setEmailViewerTheme = useSettingsStore(s => s.setEmailViewerTheme);
  const effectiveTheme = emailViewerTheme === 'system' ? theme : emailViewerTheme;
  return (
    <DesktopViewEnv>
      <ColorSchemeView theme={theme} onTheme={setTheme} palettes={PALETTES} palette={palette} onPalette={setPalette}
        appIcon={<AppIconSettings />} emailViewerTheme={emailViewerTheme} onEmailViewerTheme={setEmailViewerTheme}
        emailPreview={{ effectiveTheme, colors: getEmailColors(effectiveTheme, palette) }} afterEmailTheme={afterEmailTheme} />
    </DesktopViewEnv>
  );
}
