import React from 'react';
import { Check, Moon, Sun } from 'lucide-react';
import { useThemeStore } from '../../stores/themeStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { SettingRow } from './SettingRow';
import { ColorOptionPreview, EmailThemePreview } from './PreferencePreview';
import { useT } from '../../i18n';

export function ColorSchemeSettings() {
  const t = useT();
  const { theme, setTheme, palette, setPalette } = useThemeStore();
  const emailViewerTheme = useSettingsStore(s => s.emailViewerTheme);
  const setEmailViewerTheme = useSettingsStore(s => s.setEmailViewerTheme);
  return (
    <section className="settings-preference-group" aria-labelledby="color-scheme-heading">
      <h4 id="color-scheme-heading">{t('settings.colors.title')}</h4>
      <SettingRow label={t('settings.appearance.theme')}>
        <div role="group" className="settings-visual-options">
          {[{ value: 'light', Icon: Sun }, { value: 'dark', Icon: Moon }].map(({ value, Icon }) => (
            <button key={value} type="button" aria-label={t(`settings.colors.${value}`)} aria-pressed={theme === value} onClick={() => setTheme(value)}>
              <ColorOptionPreview theme={value} palette={palette || 'indigo'} />
              <span className="settings-visual-option-label"><Icon size={15} aria-hidden="true" />{t(`settings.colors.${value}`)}{theme === value && <Check size={14} aria-hidden="true" />}</span>
            </button>
          ))}
        </div>
      </SettingRow>
      <SettingRow label={t('settings.colors.palette')} description={t(`settings.colors.${palette || 'indigo'}Description`)}>
        <div role="group" className="settings-visual-options">
          {['indigo', 'graphite'].map(value => (
            <button type="button" key={value} aria-label={t(`settings.colors.${value}`)}
              aria-pressed={(palette || 'indigo') === value} onClick={() => setPalette(value)}>
              <ColorOptionPreview theme={theme} palette={value} />
              <span className="settings-visual-option-label">{t(`settings.colors.${value}`)}{(palette || 'indigo') === value && <Check size={14} aria-hidden="true" />}</span>
            </button>
          ))}
        </div>
      </SettingRow>
      <SettingRow label={t('settings.appearance.emailViewerTheme')} description={t('settings.colors.emailThemeHint')} preview={<EmailThemePreview />}>
        <select value={emailViewerTheme} onChange={event => setEmailViewerTheme(event.target.value)}>
          <option value="system">{t('settings.appearance.matchAppTheme')}</option>
          <option value="light">{t('settings.appearance.alwaysLight')}</option>
          <option value="dark">{t('settings.appearance.alwaysDark')}</option>
        </select>
      </SettingRow>
    </section>
  );
}
