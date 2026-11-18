// Settings > Appearance > Colors > App icon as a view. `icons`: `{ id: imageUrl }`; `onChoose(id)`
// switches it (the app does the switching); `pending` while it does, `error` when it failed.
import React from 'react';
import { Check } from 'lucide-react';
import { SettingRow } from '../../ui/SettingRow';
import { useViewT } from './viewContext';

export function AppIconView({ icons, selected, pending = false, error = false, onChoose }) {
  const t = useViewT();
  return <SettingRow label={t('settings.icons.title')} description={t('settings.icons.hint')}
    preview={<figure aria-label={t('settings.icons.title')}><img src={icons[selected]} width="80" height="80" alt="" /><figcaption>{t(`settings.icons.${selected}`)}</figcaption></figure>}>
    <div>
      <div role="group" aria-label={t('settings.icons.title')} className="settings-visual-options">
        {Object.entries(icons).map(([value, src]) => <button type="button" key={value}
          disabled={pending} aria-label={t(`settings.icons.${value}`)} aria-pressed={selected === value}
          onClick={() => onChoose(value)}>
          <img src={src} width="80" height="80" alt="" style={{ margin: '12px auto', display: 'block' }} />
          <span className="settings-visual-option-label">{t(`settings.icons.${value}`)}{selected === value && <Check size={14} aria-hidden="true" />}</span>
        </button>)}
      </div>
      {error && <p role="alert">{t('settings.icons.error')}</p>}
    </div>
  </SettingRow>;
}
