// The issue row's state: the accounts' issues, and whether the user has dismissed this very set.
// A dismissal is kept for the session (sessionStorage: it ends with the app being closed, so a
// problem that is still there is shown again on the next launch) and holds only while the set of
// issues stays the one that was dismissed; a new or a fixed one shows the row again.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { accountIssues, dismissedFor, issueKey } from './accountIssues.js';

const STORAGE = 'mv.issues.dismissed';
let memory = null;

function read() {
  try {
    return window.sessionStorage.getItem(STORAGE);
  } catch {
    return memory;
  }
}

function write(key) {
  memory = key;
  try {
    if (key == null) window.sessionStorage.removeItem(STORAGE);
    else window.sessionStorage.setItem(STORAGE, key);
  } catch {
    /* the in-memory copy still holds for this page */
  }
}

/** `{ issues, shown, dismiss }` for the accounts on show (hidden accounts are left out by the caller). */
export function useAccountIssues(accounts) {
  const issues = useMemo(() => accountIssues(accounts), [accounts]);
  const key = issueKey(issues);
  const [dismissed, setDismissed] = useState(read);
  // Nothing wrong any more: the next problem, even the same one, is new.
  useEffect(() => {
    if (!issues.length && dismissed != null) {
      write(null);
      setDismissed(null);
    }
  }, [issues.length, dismissed]);
  const dismiss = useCallback(() => {
    write(key);
    setDismissed(key);
  }, [key]);
  return { issues, shown: issues.length > 0 && !dismissedFor(issues, dismissed), dismiss };
}
