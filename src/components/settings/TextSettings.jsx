import React, { useEffect, useState } from 'react';
import { Loader2, Type } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { Button } from '../ui/Button';
import { APP_FONTS, DEFAULT_APP_FONT, TEXT_SCALES, fontStack } from '../../utils/appFont';
import { googleFamilyOf, googleFontId } from '../../utils/googleFonts';
import { refreshFonts, useFontStore } from '../../services/fontService';
import { GoogleFontPicker, GoogleFontsTrackingNote, fontErrorText, useGoogleFontChoice } from './GoogleFontPicker';
import { useT } from '../../i18n';
import { DesktopViewEnv } from './DesktopViewEnv';
import { FontOptionsView, TextSettingsView, TextSizeChoiceView } from './views/TextSettingsView';

/** Desktop's font choices: the bundled fonts and the downloaded Google families (fontService). */
export function FontOptions({ value, onChange }) {
  const installed = useFontStore(s => s.installed);
  useEffect(() => { void refreshFonts(); }, []);
  const current = googleFamilyOf(value);
  const downloaded = current && !installed.includes(current) ? [...installed, current] : installed;
  return <DesktopViewEnv>
    <FontOptionsView fonts={APP_FONTS} fontStack={fontStack} value={value} onChange={onChange}
      downloaded={downloaded.map(family => ({ id: googleFontId(family), family }))} />
  </DesktopViewEnv>;
}

export function TextSizeChoice({ label, value, onChange }) {
  return <DesktopViewEnv><TextSizeChoiceView label={label} value={value} onChange={onChange} scales={TEXT_SCALES} /></DesktopViewEnv>;
}

export function TextSettings() {
  const t = useT();
  const appFont = useSettingsStore(s => s.appFont);
  const setAppFont = useSettingsStore(s => s.setAppFont);
  const textScale = useSettingsStore(s => s.textScale);
  const setTextScale = useSettingsStore(s => s.setTextScale);
  const [picking, setPicking] = useState(false);
  // The family last chosen in the picker: its download may outlive the
  // picker, so its progress or failure shows here too.
  const [chosen, setChosen] = useState(null);
  const progress = useFontStore(s => (chosen ? s.progress[chosen] : null));
  const errorCode = useFontStore(s => (chosen ? s.errors[chosen] : null));
  const pick = useGoogleFontChoice(family => {
    setAppFont(googleFontId(family));
    setPicking(false);
    setChosen(null);
  });
  // Removing the font in use puts the default back rather than leave every
  // window drawing a fallback for a font that is gone.
  const removed = family => {
    if (useSettingsStore.getState().appFont === googleFontId(family)) setAppFont(DEFAULT_APP_FONT);
  };
  const installed = useFontStore(s => s.installed);
  useEffect(() => { void refreshFonts(); }, []);
  const current = googleFamilyOf(appFont);
  const downloaded = current && !installed.includes(current) ? [...installed, current] : installed;
  return (
    <DesktopViewEnv>
      <TextSettingsView textScale={textScale} onTextScale={setTextScale} scales={TEXT_SCALES}
        fontOptions={{ fonts: APP_FONTS, fontStack, value: appFont, onChange: setAppFont,
          downloaded: downloaded.map(family => ({ id: googleFontId(family), family })) }}
        moreFonts={<>
          <div className="mt-3 flex flex-col items-start gap-1">
            <Button variant="secondary" size="sm" onClick={() => setPicking(true)}>
              <Type size={14} aria-hidden="true" />{t('settings.text.moreFonts')}
            </Button>
            <p className="text-xs text-mail-text-muted">{t('settings.text.googleFontsNote')}</p>
            <GoogleFontsTrackingNote />
            {chosen && (progress || errorCode) && (
              <p data-testid="font-download-status" role="status" className={`flex items-center gap-1.5 text-xs ${progress ? 'text-mail-text-muted' : 'text-mail-danger'}`}>
                {progress && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
                <span className="font-medium">{chosen}</span>
                <span>{progress ? t('fonts.picker.downloading') : fontErrorText(t, errorCode)}</span>
                {!progress && <Button variant="link" size="xs" onClick={() => void pick(chosen)}>{t('common.retry')}</Button>}
              </p>
            )}
          </div>
          <GoogleFontPicker open={picking} onClose={() => setPicking(false)} onRemoved={removed} onChoose={setChosen}
            onPick={family => { setAppFont(googleFontId(family)); setPicking(false); setChosen(null); }} />
        </>} />
    </DesktopViewEnv>
  );
}
