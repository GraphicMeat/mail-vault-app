import { useEffect, useRef, useState } from 'react';

export function useDraftState({ initialData }) {
  // Stable logical identity is independent of the native accepted location.
  const draftIdRef = useRef(initialData?._draftId || null);
  const draftUidRef = useRef(initialData?._draftUid || null);
  const draftMailboxRef = useRef(initialData?._draftMailbox || null);
  const draftAccountRef = useRef(initialData?._draftAccountId || initialData?._accountId || null);
  const acceptedRevisionRef = useRef(initialData?._draftAcceptedRevision || 0);
  const acceptanceUnknownRef = useRef(Boolean(initialData?._draftAcceptanceUnknown));
  const issuedDraftRef = useRef({
    revision: initialData?._draftRevision || 0,
    content: initialData?._draftContent || null,
    signature: initialData?._draftUiSignature || (initialData?._draftContent ? JSON.stringify(initialData._draftContent) : null),
  });
  const initialNativeContentRef = useRef(null);
  const recoveredContentRef = useRef(initialData?._draftRecoveredContent || null);
  const recoveryUiBaselineRef = useRef(null);
  const recoveredKnownRef = useRef(initialData?._draftRecoveredKnown || null);
  const acceptedContentRef = useRef(!initialData?._draftAcceptanceUnknown && initialData?._draftRevision > 0 && initialData._draftRevision === initialData._draftAcceptedRevision
    ? initialData._draftContent || null : null);
  const saveChainRef = useRef(Promise.resolve());
  const queuedDraftRef = useRef(null);
  const terminalIntentRef = useRef(null);
  const terminalOperationRef = useRef(null);
  const [terminalState, setTerminalState] = useState(null);
  const [draftSaveError, setDraftSaveError] = useState(null);
  const [draftRetry, setDraftRetry] = useState(0);
  const [draftOmitted, setDraftOmitted] = useState(null);
  const draftFailuresRef = useRef(0);
  const draftRetryTimerRef = useRef(null);
  // Only words this window issued may go above a revision it never saw. A
  // restored snapshot can be older than the vault (the app died before it
  // reached disk), and resending it would overwrite the newer copy.
  const wordsIssuedHereRef = useRef(false);
  useEffect(() => () => clearTimeout(draftRetryTimerRef.current), []);

  return { draftIdRef, draftUidRef, draftMailboxRef, draftAccountRef, acceptedRevisionRef, acceptanceUnknownRef, issuedDraftRef, initialNativeContentRef, recoveredContentRef, recoveryUiBaselineRef, recoveredKnownRef, acceptedContentRef, saveChainRef, queuedDraftRef, terminalIntentRef, terminalOperationRef, terminalState, setTerminalState, draftSaveError, setDraftSaveError, draftRetry, setDraftRetry, draftOmitted, setDraftOmitted, draftFailuresRef, draftRetryTimerRef, wordsIssuedHereRef };
}
