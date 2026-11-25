import { useRef } from 'react';
import { tErr, useT } from '../../i18n/index.js';
import { composeSnapshotForTransfer } from '../../services/composeWindow';
import { htmlToText } from '../RichTextEditor';
import { checkCompose, composeCheckInput } from '../../services/composePrep';
import { useMailStore } from '../../stores/mailStore';
import { isGraphAccount } from '../../services/graphConfig';
import { hasPremiumAccess, useSettingsStore } from '../../stores/settingsStore';
import { createComposeSend, scheduleCompose } from '../../services/composeSend';

// A send cut short by a change from outside the editor re-checks the clicked
// content this many times before it says it could not.
const EXTERNAL_RECHECKS = 3;

export function useComposeSend({ externalInvalidations, submission, detaching, terminalIntentRef, aliveRef, preparationReadyRef, needsPreparation, preparedContext, currentPreparation, setError, sendGeneration, confirmation, nextAttempt, latestSnapshotRef, selectedAccount, senderNameFor, setShowAttachmentReminder, setSizeWarningLimit, setSending, saveChainRef, prepareSendCheck, mode, finalizeSendCheck, onSchedule, onDraftCleanup, onSend, onClose, onQueueSend, actionReplyTo, initialData, selectedAccountId, initialSnapshot, invalidate }) {
  const t = useT();
  const latest = useRef(null);
  // Send and Shift+Enter both land here; the armed plan picks the path.
  // "Send anyway" on the attachment reminder comes back with `sendAnyway`.
  // `recheck` carries the clicked snapshot into a re-check after an outside
  // change (account refresh, settings push) retired the attempt.
  const handleSend = async (event, sendAnyway = false, recheck = null) => {
    event?.preventDefault();
    if (submission.current || detaching || terminalIntentRef.current || !aliveRef.current) return;
    if (!preparationReadyRef.current || needsPreparation && (preparedContext.current?.source !== currentPreparation.current.source || preparedContext.current?.identityGeneration !== currentPreparation.current.identityGeneration)) { setError(t('compose.preparationUnavailable')); return; }
    const generation = sendGeneration.current;
    const confirmed = sendAnyway && confirmation.current?.generation === generation ? confirmation.current : null;
    const attempt = ++nextAttempt.current;
    const claim = { attempt, generation };
    submission.current = claim;
    const current = () => aliveRef.current && !terminalIntentRef.current && submission.current === claim && sendGeneration.current === generation;
    // Retired only by outside changes: no edit, close or second submission.
    const external = externalInvalidations.current;
    const retiredFromOutside = () => aliveRef.current && !terminalIntentRef.current && submission.current === claim
      && sendGeneration.current - generation === externalInvalidations.current - external;
    let again = false;
    // composeSnapshot/captureDraft synchronously pins the issued content and cleanup bound.
    const snapshot = composeSnapshotForTransfer(recheck?.snapshot || confirmed?.snapshot || latestSnapshotRef.current());
    const accountSource = selectedAccount;
    const account = composeSnapshotForTransfer(accountSource);
    const senderSettings = { displayName: senderNameFor(accountSource, snapshot._fromAddress) };
    const timeZone = confirmed?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    let draft;
    const outcome = result => {
      if (result.kind === 'invalid') { confirmation.current = null; setError(t(result.key, result.args)); return false; }
      if (result.kind === 'confirm_attachment') {
        confirmation.current = { snapshot, generation, timeZone, attempt };
        setShowAttachmentReminder(true); return false;
      }
      if (result.kind === 'confirm_size') {
        confirmation.current = { snapshot, generation, timeZone, attempt };
        setSizeWarningLimit(result.limitBytes); return false;
      }
      if (result.kind !== 'ready') throw new Error('compose.preparationUnavailable');
      return true;
    };
    setSending(true);
    setError(null);
    try {
      await saveChainRef.current.catch(() => {});
      if (!current()) { again = retiredFromOutside(); return; }
      const result = prepareSendCheck
        ? await prepareSendCheck({ attempt, editorGeneration: generation, ...(confirmed
          ? { confirmationAttempt: confirmed.attempt }
          : { snapshot, authoredBodyText: htmlToText(snapshot.body), timeZone }) })
        : await checkCompose(composeCheckInput({ snapshot, mode, authoredBodyText: htmlToText(snapshot.body), timeZone, sendAnyway: !!confirmed }), { isCurrent: current });
      if (!current()) { again = retiredFromOutside(); return; }
      if (!outcome(result)) return;
      // Preserve moved-schedule failure recovery through detached finalization.
      draft = result.route.draft;
      if (finalizeSendCheck) {
        const final = await finalizeSendCheck({ attempt, editorGeneration: generation }, !!result.route.draft);
        if (!current()) return;
        if (final) outcome(final);
        return;
      }
      // No await between current authority comparison and entering the existing owner.
      if (useMailStore.getState().accounts?.find(a => a.id === snapshot._accountId) !== accountSource
        || senderNameFor(accountSource, snapshot._fromAddress) !== senderSettings.displayName) throw new Error('compose.preparationUnavailable');
      const handoff = composeSnapshotForTransfer(snapshot);
      handoff._composeDelay = result.route.delay;
      if (draft) handoff._scheduleDraft = draft;
      handoff._remindDays = snapshot._remindDays > 0 && !isGraphAccount(account) && hasPremiumAccess(useSettingsStore.getState().billingProfile) ? snapshot._remindDays : 0;
      confirmation.current = null;
      if (draft) {
        if (onSchedule) await onSchedule(handoff);
        else {
          await scheduleCompose({ snapshot: handoff, account, settings: senderSettings, cleanupDraft: onDraftCleanup });
          onSend?.(); onClose();
        }
      } else if (onQueueSend) await onQueueSend(handoff, result.route.delay);
      else {
        const composeState = { mode, replyTo: handoff._replyTo || actionReplyTo, initialData: handoff };
        useMailStore.getState().queueSend(composeState,
          createComposeSend({ snapshot: handoff, mode, replyTo: composeState.replyTo, account, settings: senderSettings, cleanupDraft: onDraftCleanup }), result.route.delay);
        onSend?.(); onClose();
      }
    } catch (err) {
      if (!current()) { again = retiredFromOutside(); return; }
      confirmation.current = null;
      if (draft && initialData?._editScheduledId && initialData._editScheduledRow?.accountId !== selectedAccountId) initialSnapshot.current = null;
      setError(err?.message ? tErr(err) : t('scheduled.errors.scheduleFailed'));
      invalidate();
    } finally {
      if (submission.current === claim) submission.current = null;
      if (aliveRef.current) setSending(false);
      if (again) {
        const count = (recheck?.count || 0) + 1;
        // The next render's handler: it holds the refreshed account.
        if (count <= EXTERNAL_RECHECKS) setTimeout(() => latest.current?.(null, false, { snapshot, count }), 0);
        else setError(t('compose.preparationUnavailable'));
      }
    }
  };
  latest.current = handleSend;

  return { handleSend };
}
