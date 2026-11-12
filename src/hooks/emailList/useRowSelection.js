import { useCallback, useEffect, useRef } from 'react';
import { selectionKey } from '../../stores/slices/unifiedHelpers';
import { useMailStore } from '../../stores/mailStore';
import { emailsInRowRange } from '../../utils/emailParser';

export function useRowSelection({ threadedDisplay, setEmailsSelected, selectedEmailIds, activeAccountId, activeMailbox }) {
  // Through the helper: a uid is unique only inside one mailbox of one account,
  // and a key built here by hand is a key the store cannot read back.
  // Stable: it reads the store at call time, and the explorer's Unread cut
  // memoizes on it.
  const selKey = useCallback((email) => selectionKey(email, useMailStore.getState()), []);

  // Checkbox ticks. Shift held ticks every row between the last box ticked
  // (or, before any, the open message) and this one. Refs keep the callbacks
  // stable: the rows are memoized.
  const rowsRef = useRef(threadedDisplay);
  rowsRef.current = threadedDisplay;
  const selectionAnchorRef = useRef(null);
  const checkRows = useCallback((emails, selected, shiftKey) => {
    const target = selKey(emails[0]);
    const anchor = selectionAnchorRef.current ?? useMailStore.getState().selectedEmailId;
    const range = shiftKey && anchor ? emailsInRowRange(rowsRef.current, anchor, target, selKey) : null;
    setEmailsSelected(range || emails, range ? true : selected);
    selectionAnchorRef.current = target;
  }, [selKey, setEmailsSelected]);
  const checkEmailRow = useCallback((uid, accountId, mailbox, shiftKey) => {
    const email = { uid, _accountId: accountId || undefined, _mailbox: mailbox || undefined };
    checkRows([email], !useMailStore.getState().selectedEmailIds.has(selKey(email)), shiftKey);
  }, [checkRows, selKey]);
  useEffect(() => { if (selectedEmailIds.size === 0) selectionAnchorRef.current = null; }, [selectedEmailIds]);
  useEffect(() => { selectionAnchorRef.current = null; }, [activeAccountId, activeMailbox]);

  return { selKey, checkRows, checkEmailRow };
}
