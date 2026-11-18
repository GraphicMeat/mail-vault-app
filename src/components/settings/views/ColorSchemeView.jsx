// Settings > Appearance > Colors as a view: theme, palette, the app icon (a slot) and the email
// viewer's theme. Desktop: ColorSchemeSettings.jsx; phone: src/mobile/settings/ColorScheme.jsx.
import React from 'react';
import { Check, Moon, Smartphone, Sun } from 'lucide-react';
import { SettingRow } from '../../ui/SettingRow';
import { ColorOptionPreview, EmailThemePreviewView } from './PreviewViews';
import { useT } from './viewContext';

const THEME_ICONS = { light: Sun, dark: Moon, system: Smartphone };

/**
 * `themes`: the theme choices (desktop light and dark; the phone adds `system`, drawn in
 * `systemTheme`, the one the system shows now). `palettes`: the palette ids. `appIcon`: the app
 * icon row, or nothing. `emailPreview`: `{ effectiveTheme, colors }` for the email theme example.
 * `afterEmailTheme`: rows other parts of the app add after the email theme row.
 */
export function ColorSchemeView({ themes = ['light', 'dark'], theme, systemTheme = 'dark', onTheme, palettes, palette, onPalette,
  appIcon = null, emailViewerTheme, onEmailViewerTheme, emailPreview, afterEmailTheme = null }) {
  const t = useT();
  const current = palette || 'indigo';
  const drawn = value => (value === 'system' ? systemTheme : value);
  const themeLabel = value => (value === 'system' ? t('settings.section.system') : t(`settings.colors.${value}`));
  return (
    <section className="settings-preference-group" aria-labelledby="color-scheme-heading">
      <h4 id="color-scheme-heading">{t('settings.colors.title')}</h4>
      <SettingRow label={t('settings.appearance.theme')}>
        <div role="group" className="settings-visual-options">
          {themes.map(value => {
            const Icon = THEME_ICONS[value];
            return (
              <button key={value} type="button" aria-label={themeLabel(value)} aria-pressed={theme === value} onClick={() => onTheme(value)}>
                <ColorOptionPreview theme={drawn(value)} palette={current} />
                <span className="settings-visual-option-label"><Icon size={15} aria-hidden="true" />{themeLabel(value)}{theme === value && <Check size={14} aria-hidden="true" />}</span>
              </button>
            );
          })}
        </div>
      </SettingRow>
      <SettingRow label={t('settings.colors.palette')} description={t(`settings.colors.${current}Description`)}>
        <div role="group" className="settings-visual-options">
          {palettes.map(value => (
            <button type="button" key={value} aria-label={t(`settings.colors.${value}`)}
              aria-pressed={current === value} onClick={() => onPalette(value)}>
              <ColorOptionPreview theme={drawn(theme)} palette={value} />
              <span className="settings-visual-option-label">{t(`settings.colors.${value}`)}{current === value && <Check size={14} aria-hidden="true" />}</span>
            </button>
          ))}
        </div>
      </SettingRow>
      {appIcon}
      <SettingRow label={t('settings.appearance.emailViewerTheme')} description={t('settings.colors.emailThemeHint')}
        preview={emailPreview && <EmailThemePreviewView {...emailPreview} />}>
        <select value={emailViewerTheme} onChange={event => onEmailViewerTheme(event.target.value)}>
          <option value="system">{t('settings.appearance.matchAppTheme')}</option>
          <option value="light">{t('settings.appearance.alwaysLight')}</option>
          <option value="dark">{t('settings.appearance.alwaysDark')}</option>
        </select>
      </SettingRow>
      {afterEmailTheme}
    </section>
  );
}
