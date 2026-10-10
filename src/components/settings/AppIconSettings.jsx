import React from 'react';
import { Check } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { APP_ICONS, applyAppIcon, normalizeAppIcon } from '../../utils/appIcon';
import { SettingRow } from '../ui/SettingRow';
import { useT } from '../../i18n';

export function AppIconSettings() {
  const t = useT();
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
  return <SettingRow label={t('settings.icons.title')} description={t('settings.icons.hint')}
    preview={<figure aria-label={t('settings.icons.title')}><img src={APP_ICONS[selected]} width="80" height="80" alt="" /><figcaption>{t(`settings.icons.${selected}`)}</figcaption></figure>}>
    <div>
      <div role="group" aria-label={t('settings.icons.title')} className="settings-visual-options">
        {Object.entries(APP_ICONS).map(([value, src]) => <button type="button" key={value}
          disabled={pending} aria-label={t(`settings.icons.${value}`)} aria-pressed={selected === value}
          onClick={() => choose(value)}>
          <img src={src} width="80" height="80" alt="" style={{ margin: '12px auto', display: 'block' }} />
          <span className="settings-visual-option-label">{t(`settings.icons.${value}`)}{selected === value && <Check size={14} aria-hidden="true" />}</span>
        </button>)}
      </div>
      {error && <p role="alert">{t('settings.icons.error')}</p>}
    </div>
  </SettingRow>;
}
