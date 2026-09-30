import React, { useEffect, useId, useState } from 'react';
import { Check, Type } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { SettingRow } from '../ui/SettingRow';
import { SegmentedChoice } from '../ui/SegmentedChoice';
import { Button } from '../ui/Button';
import { APP_FONTS, DEFAULT_APP_FONT, TEXT_SCALES, fontStack } from '../../utils/appFont';
import { googleFamilyOf, googleFontId } from '../../utils/googleFonts';
import { refreshFonts, useFontStore } from '../../services/fontService';
import { GoogleFontPicker } from './GoogleFontPicker';
import { getLocale, useT } from '../../i18n';

// Each option is drawn in its own face. Family names are proper nouns and
// stay untranslated; only "System font" and the group headings are copy.
// Downloaded Google families get a group of their own, shown once there is
// one (or the saved font is one).
export function FontOptions({ value, onChange }) {
  const t = useT();
  const id = useId();
  const installed = useFontStore(s => s.installed);
  useEffect(() => { void refreshFonts(); }, []);
  const current = googleFamilyOf(value);
  const downloaded = current && !installed.includes(current) ? [...installed, current] : installed;
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
    {downloaded.length > 0 && <div role="group" aria-labelledby={`${id}-google`}>
      <p id={`${id}-google`} className="font-options-heading">{t('settings.text.downloadedFonts')}</p>
      <div className="settings-visual-options">
        {downloaded.map(family => {
          const fontId = googleFontId(family);
          return <button key={family} type="button" data-testid={`font-${fontId}`} aria-pressed={value === fontId}
            onClick={() => onChange(fontId)} style={{ fontFamily: fontStack(fontId) }}>
            <span className="settings-visual-option-label">{family}{value === fontId && <Check size={14} aria-hidden="true" />}</span>
          </button>;
        })}
      </div>
    </div>}
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
  const [picking, setPicking] = useState(false);
  // Removing the font in use puts the default back rather than leave every
  // window drawing a fallback for a font that is gone.
  const removed = family => {
    if (useSettingsStore.getState().appFont === googleFontId(family)) setAppFont(DEFAULT_APP_FONT);
  };
  return (
    <section className="settings-preference-group" aria-labelledby="text-settings-heading">
      <h4 id="text-settings-heading">{t('settings.appearance.section.text')}</h4>
      <SettingRow label={t('settings.text.size')} description={t('settings.text.sizeHint')}>
        <TextSizeChoice label={t('settings.text.size')} value={textScale} onChange={setTextScale} />
      </SettingRow>
      <SettingRow label={t('settings.text.font')} description={t('settings.text.fontHint')}>
        <div>
          <FontOptions value={appFont} onChange={setAppFont} />
          <div className="mt-3 flex flex-col items-start gap-1">
            <Button variant="secondary" size="sm" onClick={() => setPicking(true)}>
              <Type size={14} aria-hidden="true" />{t('settings.text.moreFonts')}
            </Button>
            <p className="text-xs text-mail-text-muted">{t('settings.text.googleFontsNote')}</p>
          </div>
          <GoogleFontPicker open={picking} onClose={() => setPicking(false)} onRemoved={removed}
            onPick={family => { setAppFont(googleFontId(family)); setPicking(false); }} />
        </div>
      </SettingRow>
    </section>
  );
}
