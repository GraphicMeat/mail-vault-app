// The one row between the header and the list that stands for every account problem: a sign-in
// that lapsed, a password the server refused, a password that was lost. It names the account (or
// counts them), Fix opens the issues sheet, and the X hides the row until the set of issues
// changes (useAccountIssues.js). One quiet row, never a stack of red banners.
import React from 'react';
import { KeyRound, X } from 'lucide-react';
import { Button } from '../../components/ui/Button.jsx';
import { useT } from '../i18n.js';
import { issueTitle } from './accountIssues.js';

export default function IssueRow({ issues, onFix, onDismiss }) {
  const t = useT();
  if (!issues?.length) return null;
  const title = issueTitle(issues);
  return (
    <div className="mv-issue" data-mv-issue-row role="group" aria-label={t('mobile.issues.label')}>
      <KeyRound size={20} className="mv-issue__icon" aria-hidden="true" />
      <div className="mv-issue__text">
        <b dir="auto">{t(title.key, title.params)}</b>
        <span>{t('mobile.issues.paused')}</span>
      </div>
      <Button variant="accentTint" size="touch" className="mv-issue__fix" data-mv-issue-fix onClick={onFix}>
        {t('mobile.issues.fix')}
      </Button>
      <Button variant="ghost" size="touch" icon data-mv-issue-dismiss aria-label={t('mobile.issues.dismiss')} onClick={onDismiss}>
        <X size={18} aria-hidden="true" />
      </Button>
    </div>
  );
}
