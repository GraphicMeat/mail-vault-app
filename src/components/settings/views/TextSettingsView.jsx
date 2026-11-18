// Settings > Appearance > Text as a view: text size and the app font. The app hands in its own
// font list and stacks (desktop utils/appFont, the phone's prefs.js copy) and, on desktop, the
// "More fonts" block (`moreFonts`), which downloads through the daemon.
import React, { useId } from 'react';
import { Check } from 'lucide-react';
import { SettingRow } from '../../ui/SettingRow';
import { SegmentedChoice } from '../../ui/SegmentedChoice';
import { useViewEnv, useViewT } from './viewContext';

// Each option is drawn in its own face. Family names are proper nouns and
// stay untranslated; only "System font" and the group headings are copy.
// Downloaded families (`downloaded`: `[{ id, family }]`) get a group of their
// own, shown once there is one.
export function FontOptionsView({ fonts, fontStack, value, onChange, downloaded = [] }) {
  const t = useViewT();
  const id = useId();
  return <div className="font-options">
    {[['ui', 'settings.text.interfaceFonts', false], ['mono', 'settings.text.codingFonts', true]].map(([kind, key, mono]) =>
      <div key={kind} role="group" aria-labelledby={`${id}-${kind}`}>
        <p id={`${id}-${kind}`} className="font-options-heading">{t(key)}</p>
        <div className="settings-visual-options">
          {fonts.filter(font => !!font.mono === mono).map(font =>
            <button key={font.id} type="button" data-testid={`font-${font.id}`} aria-pressed={value === font.id}
              onClick={() => onChange(font.id)} style={{ fontFamily: fontStack(font.id) }}>
              <span className="settings-visual-option-label">{font.family || t('settings.text.systemFont')}{value === font.id && <Check size={14} aria-hidden="true" />}</span>
            </button>)}
        </div>
      </div>)}
    {downloaded.length > 0 && <div role="group" aria-labelledby={`${id}-google`}>
      <p id={`${id}-google`} className="font-options-heading">{t('settings.text.downloadedFonts')}</p>
      <div className="settings-visual-options">
        {downloaded.map(({ id: fontId, family }) =>
          <button key={family} type="button" data-testid={`font-${fontId}`} aria-pressed={value === fontId}
            onClick={() => onChange(fontId)} style={{ fontFamily: fontStack(fontId) }}>
            <span className="settings-visual-option-label">{family}{value === fontId && <Check size={14} aria-hidden="true" />}</span>
          </button>)}
      </div>
    </div>}
  </div>;
}

export function TextSizeChoiceView({ label, value, onChange, scales }) {
  const { locale } = useViewEnv();
  const percent = new Intl.NumberFormat(locale, { style: 'percent' });
  return <SegmentedChoice label={label} value={value} onChange={onChange}
    options={scales.map(scale => ({ value: scale, label: percent.format(scale) }))} />;
}

/** `fontOptions`: FontOptionsView's props; `moreFonts`: rendered under the font choices. */
export function TextSettingsView({ textScale, onTextScale, scales, fontOptions, moreFonts = null }) {
  const t = useViewT();
  return (
    <section className="settings-preference-group" aria-labelledby="text-settings-heading">
      <h4 id="text-settings-heading">{t('settings.appearance.section.text')}</h4>
      <SettingRow label={t('settings.text.size')} description={t('settings.text.sizeHint')}>
        <TextSizeChoiceView label={t('settings.text.size')} value={textScale} onChange={onTextScale} scales={scales} />
      </SettingRow>
      <SettingRow label={t('settings.text.font')} description={t('settings.text.fontHint')}>
        <div>
          <FontOptionsView {...fontOptions} />
          {moreFonts}
        </div>
      </SettingRow>
    </section>
  );
}
