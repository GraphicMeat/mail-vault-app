// The translation report both apps open: a prefilled GitHub discussion (desktop's
// TranslationIssueReport.jsx and the phone's TranslationReport.jsx). Pure, so the two send the
// same thread format.

const NEW_DISCUSSION = 'https://github.com/GraphicMeat/mail-vault-app/discussions/new';
// No `translations` category exists yet. When one does, this is the only line that changes.
const CATEGORY = 'bug-reports';

/** Both texts are needed before a report can go. */
export function translationReportReady({ wrong, fix }) {
  return String(wrong ?? '').trim() !== '' && String(fix ?? '').trim() !== '';
}

/** The discussion URL for `{lang, version, wrong, fix, where?}`. */
export function translationReportUrl({ lang, version, wrong, fix, where = '' }) {
  const w = String(wrong ?? '').trim();
  const f = String(fix ?? '').trim();
  const at = String(where ?? '').trim();
  const body = [
    `**Language:** ${lang}`,
    `**App version:** ${version}`,
    '',
    '**Current text**',
    '```', w, '```',
    '',
    '**Suggested correction**',
    '```', f, '```',
    ...(at ? ['', `**Where:** ${at}`] : []),
  ].join('\n');

  const url = new URL(NEW_DISCUSSION);
  url.searchParams.set('category', CATEGORY);
  url.searchParams.set('title', `[i18n ${lang}] ${w.slice(0, 60)}`);
  url.searchParams.set('body', body);
  return url.toString();
}
