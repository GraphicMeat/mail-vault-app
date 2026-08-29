import React from 'react';
import { Check } from 'lucide-react';
import { LOCALES, setLocale, useT } from '../../i18n/index.js';
import { useSettingsStore } from '../../stores/settingsStore';
import { TranslationIssueReport } from './TranslationIssueReport';

/**
 * The language is picked by hand and defaults to English — the OS locale is
 * never sniffed. A machine-translated UI appearing unasked-for on first run is
 * a worse first impression than English.
 */
export function LanguageSettings() {
  const t = useT();
  const active = useSettingsStore(s => s.language);

  return (
    <div className="space-y-8">
      <div>
        <h4 className="text-sm font-semibold text-mail-text mb-1">{t('settings.language.title')}</h4>
        <p className="text-xs text-mail-text-muted mb-4">{t('settings.language.subtitle')}</p>

        <div role="radiogroup" aria-label={t('settings.language.title')} className="space-y-1">
          {LOCALES.map(l => {
            const selected = l.code === active;
            return (
              <button
                key={l.code}
                role="radio"
                aria-checked={selected}
                data-testid={`language-row-${l.code}`}
                onClick={() => { setLocale(l.code).catch(() => {}); }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left
                            transition-colors border
                            ${selected
                              ? 'bg-mail-accent/10 border-mail-accent text-mail-accent-text'
                              : 'border-transparent text-mail-text-muted hover:bg-mail-surface-hover hover:text-mail-text'}`}
              >
                <span className="text-lg leading-none" aria-hidden="true">{l.flag}</span>
                <span className="text-sm font-medium text-mail-text">{l.native}</span>
                <span className="text-xs text-mail-text-muted">{l.english}</span>
                {selected && <Check size={16} className="ml-auto text-mail-accent-text" />}
              </button>
            );
          })}
        </div>
      </div>

      <TranslationIssueReport />
    </div>
  );
}
