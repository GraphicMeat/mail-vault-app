// The issue row and its sheet, wired to the store: App.jsx renders this between the header and the
// list and nothing else. `accounts` are the ones on show (a hidden account stays out);
// `onUpdatePassword(accountId)` opens that account's Mail Server page (the shell owns Settings).
// The sheet closes by itself once the last issue is fixed.
import React, { useCallback, useEffect, useState } from 'react';
import { useMobileStore } from '../store.js';
import IssueRow from './IssueRow.jsx';
import IssuesSheet from './IssuesSheet.jsx';
import { useAccountIssues } from './useAccountIssues.js';

export default function IssuesHost({ accounts, onUpdatePassword }) {
  const { issues, shown, dismiss } = useAccountIssues(accounts);
  const reauthState = useMobileStore((s) => s.reauthState);
  const syncState = useMobileStore((s) => s.syncState);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!issues.length) setOpen(false);
  }, [issues.length]);

  const close = useCallback(() => setOpen(false), []);
  const hide = useCallback(() => {
    dismiss();
    setOpen(false);
  }, [dismiss]);
  const reauth = useCallback((id) => useMobileStore.getState().reauth(id), []);
  const retry = useCallback((id) => useMobileStore.getState().retrySignIn(id), []);
  const updatePassword = useCallback((id) => {
    setOpen(false);
    onUpdatePassword(id);
  }, [onUpdatePassword]);

  return (
    <>
      {shown && <IssueRow issues={issues} onFix={() => setOpen(true)} onDismiss={dismiss} />}
      {open && issues.length > 0 && (
        <IssuesSheet
          issues={issues}
          accounts={accounts}
          reauthState={reauthState}
          syncState={syncState}
          onReauth={reauth}
          onRetry={retry}
          onUpdatePassword={updatePassword}
          onHide={hide}
          onClose={close}
        />
      )}
    </>
  );
}
