import React from 'react';
import { setLocale } from '../../i18n/index.js';
import { useSettingsStore } from '../../stores/settingsStore';
import { TranslationIssueReport } from './TranslationIssueReport';
import { LanguageView } from './views/LanguageView';
import { DesktopViewEnv } from './DesktopViewEnv';

/**
 * The language is picked by hand and defaults to English — the OS locale is
 * never sniffed. A machine-translated UI appearing unasked-for on first run is
 * a worse first impression than English.
 */
export function LanguageSettings() {
  const active = useSettingsStore(s => s.language);
  return (
    <DesktopViewEnv>
      <LanguageView active={active} onPick={code => { setLocale(code).catch(() => {}); }}>
        <TranslationIssueReport />
      </LanguageView>
    </DesktopViewEnv>
  );
}
