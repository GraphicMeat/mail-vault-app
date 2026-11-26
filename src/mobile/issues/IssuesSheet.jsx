// Every account problem in one sheet: per account, what happened and the next step that fits it.
//   signIn        "Sign in" runs the account's reauth (the store's one, shared with the switcher);
//                 its busy state and error show on that account's row
//   refused       "Try again" asks the engine for exactly one dial (servers block an address after
//                 a few failed logins); "Update password" opens the account's settings. A try
//                 that is refused again ticks an error haptic, once the pass ends
//   passwordLost  "Update password" only: the password is entered on the Mail Server page
// "Hide until something changes" hides the issue row (the same as its X) and closes the sheet.
import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button.jsx';
import Sheet from '../Sheet.jsx';
import { Avatar } from '../AccountSwitcher.jsx';
import { useT } from '../i18n.js';
import { errorKey } from '../errors.js';
import { haptic } from '../haptics.js';
import { issueTitle } from './accountIssues.js';

const WHAT = {
  signIn: 'mobile.issues.signInWhat',
  refused: 'mobile.issues.refusedWhat',
  passwordLost: 'mobile.issues.passwordLostWhat',
};

function IssueAccount({ issue, account, reauthState, retrying, onReauth, onRetry, onUpdatePassword }) {
  const t = useT();
  const mine = reauthState && reauthState.accountId === issue.accountId ? reauthState : null;
  const busy = Boolean(reauthState?.busy);
  return (
    <li className="mv-issue-account" data-mv-issue-account={issue.accountId}>
      <div className="mv-issue-account__head">
        <Avatar account={account || { id: issue.accountId, email: issue.email }} />
        <div className="mv-issue-account__text">
          <span className="mv-issue-account__email" dir="auto">{issue.email}</span>
          <small>{t(WHAT[issue.kind])}</small>
        </div>
      </div>
      {mine?.code && !mine.busy && <p className="mv-issue-account__error" role="alert">{t(errorKey(mine.code))}</p>}
      <div className="mv-issue-account__actions">
        {issue.kind === 'signIn' && (
          <Button variant="primary" size="touch" data-mv-issue-action="signIn" disabled={busy} aria-busy={mine?.busy || undefined} onClick={() => onReauth(issue.accountId)}>
            {mine?.busy ? t('mobile.add.signingIn') : t('mobile.issues.signIn')}
          </Button>
        )}
        {issue.kind === 'refused' && (
          <Button variant="secondary" size="touch" data-mv-issue-action="retry" disabled={retrying} aria-busy={retrying || undefined} onClick={() => onRetry(issue.accountId)}>
            {t('mobile.refused.retry')}
          </Button>
        )}
        {issue.kind !== 'signIn' && (
          <Button variant={issue.kind === 'passwordLost' ? 'primary' : 'secondary'} size="touch" data-mv-issue-action="password" onClick={() => onUpdatePassword(issue.accountId)}>
            {t('mobile.issues.updatePassword')}
          </Button>
        )}
      </div>
    </li>
  );
}

export default function IssuesSheet({ issues, accounts = [], reauthState, syncState = {}, onReauth, onRetry, onUpdatePassword, onHide, onClose }) {
  const t = useT();
  // accountId -> when the user asked for the try: it ends when that account's pass reports.
  const [retrying, setRetrying] = useState({});
  const tried = useRef({});
  tried.current = retrying;
  const title = issueTitle(issues);

  const retry = async (id) => {
    setRetrying((r) => ({ ...r, [id]: Date.now() }));
    const result = await onRetry(id);
    if (result && result.ok === false) {
      haptic.notify('error');
      setRetrying((r) => { const { [id]: _done, ...rest } = r; return rest; });
    }
  };

  // The pass that follows a try: refused again is an error tick, anything else ends the wait.
  useEffect(() => {
    const done = [];
    for (const [id, since] of Object.entries(tried.current)) {
      const s = syncState?.[id];
      if (!s || s.state === 'syncing' || !(s.at >= since)) continue;
      if (s.state === 'error') haptic.notify('error');
      done.push(id);
    }
    if (done.length) setRetrying((r) => Object.fromEntries(Object.entries(r).filter(([id]) => !done.includes(id))));
  }, [syncState]);

  return (
    <Sheet kind="sheet" label={t(title.key, title.params)} onClose={onClose}>
      <div className="mv-sheet__grip" aria-hidden="true" />
      <h2 className="mv-sheet__title" dir="auto">{t(title.key, title.params)}</h2>
      <p className="mv-issues__note">{t('mobile.issues.note')}</p>
      <ul className="mv-issue-list">
        {issues.map((issue) => (
          <IssueAccount
            key={issue.accountId}
            issue={issue}
            account={accounts.find((a) => a.id === issue.accountId)}
            reauthState={reauthState}
            retrying={retrying[issue.accountId] != null}
            onReauth={onReauth}
            onRetry={retry}
            onUpdatePassword={onUpdatePassword}
          />
        ))}
      </ul>
      <Button variant="secondary" size="touch" fullWidth className="mv-issues__hide" data-mv-issue-hide onClick={onHide}>
        {t('mobile.issues.hide')}
      </Button>
    </Sheet>
  );
}
