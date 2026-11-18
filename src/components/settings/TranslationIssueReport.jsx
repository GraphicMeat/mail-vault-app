import React from 'react';
import { openInBrowser } from '../../services/billingApi';
import { getLocale } from '../../i18n/index.js';
import { version } from '../../../package.json';
import { translationReportUrl } from '../../utils/translationReport.js';
import { TranslationIssueReportView } from './views/LanguageView';
import { DesktopViewEnv } from './DesktopViewEnv';

/** Desktop's container: the report opens in the browser (`openInBrowser`). */
export function TranslationIssueReport() {
  return (
    <DesktopViewEnv>
      <TranslationIssueReportView initialLang={getLocale()}
        onSubmit={({ lang, wrong, fix, where }) => { openInBrowser(translationReportUrl({ lang, version, wrong, fix, where })).catch(() => {}); }} />
    </DesktopViewEnv>
  );
}
