import React, { useState } from 'react';
import { Button } from '../ui/Button';
import { openInBrowser } from '../../services/billingApi';
import { LOCALES, getLocale, useT } from '../../i18n/index.js';
import { version } from '../../../package.json';

const NEW_DISCUSSION = 'https://github.com/GraphicMeat/mail-vault-app/discussions/new';
// No `translations` category exists yet. When one does, this is the only line
// that changes.
const CATEGORY = 'bug-reports';

/**
 * A public thread beats an email: it is searchable by the next person who trips
 * over the same wording, and it lands where the fix gets made. Same reasoning
 * BugReportDialog already documents for putting email last.
 */
export function TranslationIssueReport() {
  const t = useT();
  const [lang, setLang] = useState(getLocale());
  const [wrong, setWrong] = useState('');
  const [fix, setFix] = useState('');
  const [where, setWhere] = useState('');

  const ready = wrong.trim() !== '' && fix.trim() !== '';

  const submit = () => {
    const body = [
      `**Language:** ${lang}`,
      `**App version:** ${version}`,
      '',
      '**Current text**',
      '```', wrong.trim(), '```',
      '',
      '**Suggested correction**',
      '```', fix.trim(), '```',
      ...(where.trim() ? ['', `**Where:** ${where.trim()}`] : []),
    ].join('\n');

    const url = new URL(NEW_DISCUSSION);
    url.searchParams.set('category', CATEGORY);
    url.searchParams.set('title', `[i18n ${lang}] ${wrong.trim().slice(0, 60)}`);
    url.searchParams.set('body', body);

    openInBrowser(url.toString()).catch(() => {});
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
