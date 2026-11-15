// "Report a translation issue" under Appearance's language row, as desktop's Language page has it
// (TranslationIssueReport.jsx): the language, the text as it reads now, what it should say and
// where, sent as a prefilled GitHub discussion (`translationReportUrl`, the format both apps use).
// It goes as a plain https anchor: the shell's navigation guard hands it to the system browser,
// the one path every link takes. Nothing is sent from the app itself.
import React, { useState } from 'react';
import { useT, getMobileLocale } from './i18n.js';
import { LOCALES } from '../i18n/languages.js';
import { translationReportReady, translationReportUrl } from '../utils/translationReport.js';

const APP_VERSION = import.meta.env?.MV_APP_VERSION || '';

export default function TranslationReport({ version = APP_VERSION }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState(getMobileLocale());
  const [wrong, setWrong] = useState('');
  const [fix, setFix] = useState('');
  const [where, setWhere] = useState('');
  const ready = translationReportReady({ wrong, fix });

  if (!open) {
    return (
      <div className="mv-settings__list">
        <button type="button" className="mv-setting" data-mv-tr-open onClick={() => setOpen(true)}>
          <span className="mv-setting__text">
            <span className="mv-setting__label">{t('settings.language.report.title')}</span>
            <span className="mv-setting__hint">{t('settings.language.report.subtitle')}</span>
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="mv-trreport" data-mv-tr-form>
      <h2 className="mv-settings__heading">{t('settings.language.report.title')}</h2>
      <p className="mv-setting__hint">{t('settings.language.report.subtitle')}</p>
      <label className="mv-premium__field">
        <span>{t('settings.language.report.language')}</span>
        <select data-mv-tr="lang" value={lang} onChange={(e) => setLang(e.target.value)}>
          {LOCALES.map((l) => <option key={l.code} value={l.code}>{l.native}</option>)}
        </select>
      </label>
      <label className="mv-premium__field">
        <span>{t('settings.language.report.wrong')}</span>
        <textarea data-mv-tr="wrong" rows={2} value={wrong} onChange={(e) => setWrong(e.target.value)} />
      </label>
      <label className="mv-premium__field">
        <span>{t('settings.language.report.fix')}</span>
        <textarea data-mv-tr="fix" rows={2} value={fix} onChange={(e) => setFix(e.target.value)} />
      </label>
      <label className="mv-premium__field">
        <span>{t('settings.language.report.where')}</span>
        <input data-mv-tr="where" value={where} onChange={(e) => setWhere(e.target.value)} />
      </label>
      <div className="mv-premium__row">
        <button type="button" className="mv-textbtn" onClick={() => setOpen(false)}>{t('common.cancel')}</button>
        {ready ? (
          <a
            className="mv-premium__primary"
            data-mv-tr-submit
            href={translationReportUrl({ lang, version, wrong, fix, where })}
            target="_blank"
            rel="noopener noreferrer"
            // Cleared after the tap's navigation has read the link.
            onClick={() => setTimeout(() => { setWrong(''); setFix(''); setWhere(''); }, 0)}
          >
            {t('settings.language.report.submit')}
          </a>
        ) : (
          <button type="button" className="mv-premium__primary" data-mv-tr-submit disabled>
            {t('settings.language.report.submit')}
          </button>
        )}
      </div>
    </div>
  );
}
