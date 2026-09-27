import React, { useId } from 'react';
import { Check } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { SettingRow } from '../ui/SettingRow';
import { SegmentedChoice } from '../ui/SegmentedChoice';
import { APP_FONTS, TEXT_SCALES, fontStack } from '../../utils/appFont';
import { getLocale, useT } from '../../i18n';

// Each option is drawn in its own face. Family names are proper nouns and
// stay untranslated; only "System font" and the group headings are copy.
export function FontOptions({ value, onChange }) {
  const t = useT();
  const id = useId();
  return <div className="font-options">
    {[['ui', 'settings.text.interfaceFonts', false], ['mono', 'settings.text.codingFonts', true]].map(([kind, key, mono]) =>
      <div key={kind} role="group" aria-labelledby={`${id}-${kind}`}>
        <p id={`${id}-${kind}`} className="font-options-heading">{t(key)}</p>
        <div className="settings-visual-options">
          {APP_FONTS.filter(font => !!font.mono === mono).map(font =>
            <button key={font.id} type="button" data-testid={`font-${font.id}`} aria-pressed={value === font.id}
              onClick={() => onChange(font.id)} style={{ fontFamily: fontStack(font.id) }}>
              <span className="settings-visual-option-label">{font.family || t('settings.text.systemFont')}{value === font.id && <Check size={14} aria-hidden="true" />}</span>
            </button>)}
        </div>
      </div>)}
  </div>;
}

export function TextSizeChoice({ label, value, onChange }) {
  const percent = new Intl.NumberFormat(getLocale(), { style: 'percent' });
  return <SegmentedChoice label={label} value={value} onChange={onChange}
    options={TEXT_SCALES.map(scale => ({ value: scale, label: percent.format(scale) }))} />;
}

export function TextSettings() {
  const t = useT();
  const appFont = useSettingsStore(s => s.appFont);
  const setAppFont = useSettingsStore(s => s.setAppFont);
  const textScale = useSettingsStore(s => s.textScale);
  const setTextScale = useSettingsStore(s => s.setTextScale);
  return (
    <section className="settings-preference-group" aria-labelledby="text-settings-heading">
      <h4 id="text-settings-heading">{t('settings.appearance.section.text')}</h4>
      <SettingRow label={t('settings.text.size')} description={t('settings.text.sizeHint')}>
        <TextSizeChoice label={t('settings.text.size')} value={textScale} onChange={setTextScale} />
      </SettingRow>
      <SettingRow label={t('settings.text.font')} description={t('settings.text.fontHint')}>
        <FontOptions value={appFont} onChange={setAppFont} />
      </SettingRow>
    </section>
  );
}
