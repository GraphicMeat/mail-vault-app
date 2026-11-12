import { useT } from '../../i18n/index.js';
import { useEffect } from 'react';
import { saveLocalDraft } from '../../services/localDrafts';

// A refused save retries by itself for as long as the window is open. Most
// refusals are momentary (a sync or backup holding the same mailbox), so the
// user hears about it only once they persist. From then on the same words also
// go out under a new revision, since some refusals are about the revision.
const DRAFT_SAVE_QUIET_FAILURES = 3;
const draftRetryDelay = failures => Math.min(500 * 2 ** (failures - 1), 30000);

export function useDraftAutosave({ maySaveDraft, sending, terminalIntentRef, selectedAccount, captureDraft, acceptedContentRef, draftSaveError, queuedDraftRef, draftIdRef, publishSnapshot, saveChainRef, acceptedRevisionRef, draftAccountRef, draftMailboxRef, draftUidRef, issuedDraftRef, acceptanceUnknownRef, draftFailuresRef, setDraftSaveError, setDraftOmitted, wordsIssuedHereRef, aliveRef, draftRetryTimerRef, setDraftRetry, draftSignature, selectedAccountId, draftRetry }) {
  const t = useT();
  // Issue complete revisions at the existing 300 ms pause. The request is
  // immutable while queued; native code alone chooses folders and physical UIDs.
  useEffect(() => {
    if (!maySaveDraft || sending || terminalIntentRef.current || !selectedAccount) return;
    const timer = setTimeout(() => {
      if (terminalIntentRef.current) return;
      const issued = captureDraft();
      if (!issued.content || (issued.content === acceptedContentRef.current && !draftSaveError) || queuedDraftRef.current === issued) return;
      const request = JSON.parse(JSON.stringify({ draftId: draftIdRef.current, revision: issued.revision, ...issued.content }));
      queuedDraftRef.current = issued;
      publishSnapshot();
      saveChainRef.current = saveChainRef.current.then(async () => {
        let superseded = false;
        try {
          if (terminalIntentRef.current) return;
          const result = await saveLocalDraft(request);
          superseded = result?.disposition === 'superseded';
          const current = result?.current;
          const revision = current?.entry?.revision ?? result?.revision;
          if (result?.draftId === draftIdRef.current && current && revision >= acceptedRevisionRef.current) {
            acceptedRevisionRef.current = revision;
            draftAccountRef.current = current.identity.accountId;
            draftMailboxRef.current = current.identity.mailbox;
            draftUidRef.current = current.identity.uid;
          }
          if (result?.draftId !== request.draftId || result.disposition === 'superseded' || revision !== request.revision || revision < acceptedRevisionRef.current) {
            throw new Error(t('compose.draftContentNotAccepted'));
          }
          acceptedContentRef.current = issued.content;
          if (issuedDraftRef.current === issued) {
            acceptanceUnknownRef.current = false;
            draftFailuresRef.current = 0;
            // The words are saved. An old copy still waiting to retire is the
            // daemon's to finish on a later save, not something to alarm about.
            setDraftSaveError(null);
            setDraftOmitted(result.omittedAttachments?.length ? result.omittedAttachments.join(', ') : null);
          }
        } catch (err) {
          console.warn('[compose:autosave_fail]', err);
          // Restored words the vault has already moved past: nothing is lost,
          // and the next edit lands above the revision adopted just now.
          if (superseded && !wordsIssuedHereRef.current) return;
          if (issuedDraftRef.current === issued && aliveRef.current) {
            const failures = ++draftFailuresRef.current;
            const persisting = failures >= DRAFT_SAVE_QUIET_FAILURES;
            // A superseded revision can never land, so it does not wait its turn.
            if ((superseded || persisting) && wordsIssuedHereRef.current) {
              issuedDraftRef.current = { ...issued, revision: Math.max(issued.revision, acceptedRevisionRef.current) + 1 };
            }
            if (persisting) setDraftSaveError(t('compose.draftContentNotAccepted'));
            clearTimeout(draftRetryTimerRef.current);
            draftRetryTimerRef.current = setTimeout(() => setDraftRetry(value => value + 1), draftRetryDelay(failures));
          }
        } finally {
          if (queuedDraftRef.current === issued) queuedDraftRef.current = null;
          publishSnapshot();
        }
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [draftSignature, maySaveDraft, sending, selectedAccountId, draftRetry, publishSnapshot]);
}
