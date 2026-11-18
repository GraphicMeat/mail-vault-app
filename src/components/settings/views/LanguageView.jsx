// Settings > Appearance > Language as a view: the nine languages and the translation issue report.
// The language is picked by hand and defaults to English (desktop) or the system's (phone).
import React, { useState } from 'react';
import { Check } from 'lucide-react';
import { Button } from '../../ui/Button';
import { SettingsPageLayout } from '../../ui/SettingsForm';
import { LOCALES } from '../../../i18n/languages.js';
import { translationReportReady } from '../../../utils/translationReport.js';
import { useT } from './viewContext';

/** `active`: the language in use; `onPick(code)` switches to another. */
export function LanguageView({ active, onPick, children }) {
  const t = useT();
  return (
    <SettingsPageLayout>
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
                tabIndex={selected ? 0 : -1}
                onKeyDown={event => {
                  const index = LOCALES.indexOf(l);
                  const next = ['ArrowDown', 'ArrowRight'].includes(event.key) ? (index + 1) % LOCALES.length
                    : ['ArrowUp', 'ArrowLeft'].includes(event.key) ? (index - 1 + LOCALES.length) % LOCALES.length
                    : event.key === 'Home' ? 0 : event.key === 'End' ? LOCALES.length - 1 : null;
                  if (next === null) return;
                  event.preventDefault();
                  event.currentTarget.parentElement.children[next].focus();
                  onPick(LOCALES[next].code);
                }}
                data-testid={`language-row-${l.code}`}
                onClick={() => onPick(l.code)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left
                            transition-colors border
                            ${selected
                              ? 'bg-mail-accent/10 border-mail-accent text-mail-accent-text'
                              : 'border-transparent text-mail-text-muted hover:bg-mail-surface-hover hover:text-mail-text'}`}
              >
                <span className="text-lg leading-none" aria-hidden="true">{l.flag}</span>
                <span className="text-sm font-medium text-mail-text">{l.native}</span>
                {l.english !== l.native && <span className="text-xs text-mail-text-muted">{l.english}</span>}
                {selected && <Check size={16} className="ml-auto text-mail-accent-text" />}
              </button>
            );
          })}
        </div>
      </div>

      {children}
    </SettingsPageLayout>
  );
}

/**
 * A public thread beats an email: it is searchable by the next person who trips
 * over the same wording, and it lands where the fix gets made. Same reasoning
 * BugReportDialog already documents for ranking a public thread above email.
 *
 * `initialLang`: the language in use; `onSubmit({ lang, wrong, fix, where })` opens the report
 * (the app opens the browser), then the fields clear.
 */
export function TranslationIssueReportView({ initialLang, onSubmit }) {
  const t = useT();
  const [lang, setLang] = useState(initialLang);
  const [wrong, setWrong] = useState('');
  const [fix, setFix] = useState('');
  const [where, setWhere] = useState('');

  const ready = translationReportReady({ wrong, fix });

  const submit = () => {
    onSubmit({ lang, wrong, fix, where });
    setWrong(''); setFix(''); setWhere('');
  };

  const field = 'w-full px-3 py-2 text-sm rounded-lg bg-mail-surface border border-mail-border text-mail-text';

  return (
    <div className="pt-6 border-t border-mail-border">
      <h4 className="text-sm font-semibold text-mail-text mb-1">{t('settings.language.report.title')}</h4>
      <p className="text-xs text-mail-text-muted mb-4">{t('settings.language.report.subtitle')}</p>

      <div className="space-y-3">
        <label className="block">
          <span className="block text-xs text-mail-text-muted mb-1">{t('settings.language.report.language')}</span>
          <select data-testid="tr-lang" className={field} value={lang} onChange={e => setLang(e.target.value)}>
            {LOCALES.map(l => <option key={l.code} value={l.code}>{l.native}</option>)}
          </select>
        </label>

        <label className="block">
          <span className="block text-xs text-mail-text-muted mb-1">{t('settings.language.report.wrong')}</span>
          <textarea data-testid="tr-wrong" rows={2} className={field} value={wrong} onChange={e => setWrong(e.target.value)} />
        </label>

        <label className="block">
          <span className="block text-xs text-mail-text-muted mb-1">{t('settings.language.report.fix')}</span>
          <textarea data-testid="tr-fix" rows={2} className={field} value={fix} onChange={e => setFix(e.target.value)} />
        </label>

        <label className="block">
          <span className="block text-xs text-mail-text-muted mb-1">{t('settings.language.report.where')}</span>
          <input data-testid="tr-where" className={field} value={where} onChange={e => setWhere(e.target.value)} />
        </label>

        <Button data-testid="tr-submit" variant="primary" size="sm" disabled={!ready} onClick={submit}>
          {t('settings.language.report.submit')}
        </Button>
      </div>
    </div>
  );
}
