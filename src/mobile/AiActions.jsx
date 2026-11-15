// The AI actions' page side (the engine's `ai.rs` builds every prompt and decides what may be
// sent): the review sheet desktop's `AiContextPreview` is, the hook that runs an action through
// it, and the result sheet. An action is first asked of `mobile.ai.run` without review only when
// "Skip review before sending" is on (the engine still refuses it, `REVIEW_REQUIRED`, until this
// endpoint was reviewed once); otherwise `mobile.ai.prompt` answers the exact text and where it
// goes, the sheet shows it, and Send runs it `confirmed`.
import React, { useCallback, useRef, useState } from 'react';
import { daemonCall } from './transport.js';
import { useMobileStore } from './store.js';
import { useBackLayer } from './backStack.js';
import { useT } from './i18n.js';
import Sheet from './Sheet.jsx';

/** The catalog key of an engine refusal (`{ok: false, code}`). */
export function aiErrorKey(code) {
  switch (code) {
    case 'AI_OFF': return 'ai.actions.disabledOff';
    case 'AI_NOT_CONFIGURED': return 'mobile.ai.notConfigured';
    case 'E_GOOGLE_MAIL_ON_DEVICE_ONLY': return 'mobile.ai.googleRefused';
    default: return 'ai.actions.generateFailed';
  }
}

/** The deterministic quick replies of a message shape (desktop's `tier1Starters`). */
export const QUICK_REPLY_KEYS = Object.freeze({
  proposedTime: ['ai.quickReply.time.accept', 'ai.quickReply.time.decline', 'ai.quickReply.time.propose'],
  question: ['ai.quickReply.question.yes', 'ai.quickReply.question.no', 'ai.quickReply.question.checkBack'],
  request: ['ai.quickReply.request.ack'],
});

/** The review: the exact text, where it goes, and Cancel / Send. */
export function AiReview({ review, busy, onCancel, onConfirm }) {
  const t = useT();
  return (
    <Sheet kind="sheet" label={t('ai.preview.title')} onClose={onCancel}>
      <div className="mv-sheet__grip" aria-hidden="true" />
      <h2 className="mv-sheet__title">{t('ai.preview.title')}</h2>
      <p className="mv-sheet__text" data-mv-ai-destination>
        {t('ai.preview.destination', { destination: review.leavesDevice ? review.destination : t('ai.preview.destinationDevice') })}
      </p>
      {review.leavesDevice && <p className="mv-sheet__text" role="note">{t('ai.preview.leavesDevice')}</p>}
      <pre className="mv-ai__text" data-mv-ai-prompt dir="auto">{review.prompt}</pre>
      <div className="mv-acct__actions mv-ai__buttons">
        <button type="button" className="mv-textbtn" onClick={onCancel}>{t('common.cancel')}</button>
        <button type="button" className="mv-textbtn" data-mv-ai-send disabled={busy} onClick={onConfirm}>
          {busy ? t('compose.sending') : t('compose.send')}
        </button>
      </div>
    </Sheet>
  );
}

/**
 * Runs AI actions: `start(params, onText)` with the engine's action params (`{action, accountId,
 * folder?, uid?, text?, tone?}`). `onText(text)` gets the result; a refusal or failure lands in
 * `error` (a catalog key). Render `sheet` (the review, while one is open).
 */
export function useAiAction() {
  const skip = useMobileStore((s) => s.prefs.aiSkipPreview === true);
  const [review, setReview] = useState(null); // { prompt, destination, leavesDevice, params, onText }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const live = useRef(true);
  React.useEffect(() => () => { live.current = false; }, []);
  const cancel = useCallback(() => setReview(null), []);
  useBackLayer(Boolean(review), cancel);

  const finish = (reply, onText) => {
    if (reply?.ok) {
      setError(null);
      onText(reply.text || '');
    } else {
      setError(aiErrorKey(reply?.code));
    }
  };

  const start = useCallback(async (params, onText) => {
    setError(null);
    setBusy(true);
    try {
      if (skip) {
        const reply = await daemonCall('mobile.ai.run', params);
        if (!live.current) return;
        if (reply?.code !== 'REVIEW_REQUIRED') {
          finish(reply, onText);
          return;
        }
      }
      const preview = await daemonCall('mobile.ai.prompt', params);
      if (!live.current) return;
      if (!preview?.ok) {
        setError(aiErrorKey(preview?.code));
        return;
      }
      setReview({ ...preview, params, onText });
    } catch {
      if (live.current) setError(aiErrorKey());
    } finally {
      if (live.current) setBusy(false);
    }
  }, [skip]);

  const confirm = useCallback(async () => {
    if (!review) return;
    setBusy(true);
    try {
      const reply = await daemonCall('mobile.ai.run', { ...review.params, confirmed: true });
      if (!live.current) return;
      setReview(null);
      finish(reply, review.onText);
    } catch {
      if (live.current) {
        setReview(null);
        setError(aiErrorKey());
      }
    } finally {
      if (live.current) setBusy(false);
    }
  }, [review]);

  const sheet = review && <AiReview review={review} busy={busy} onCancel={cancel} onConfirm={confirm} />;
  return { start, busy, error, clearError: () => setError(null), sheet };
}

/** A generated text to read, with Close and, when given, "Use in reply". */
export function AiResult({ title, text, onClose, onUse }) {
  const t = useT();
  return (
    <Sheet kind="sheet" label={title} onClose={onClose}>
      <div className="mv-sheet__grip" aria-hidden="true" />
      <h2 className="mv-sheet__title">{title}</h2>
      <p className="mv-ai__text" data-mv-ai-result dir="auto">{text}</p>
      <div className="mv-acct__actions mv-ai__buttons">
        <button type="button" className="mv-textbtn" onClick={onClose}>{t('common.close')}</button>
        {onUse && <button type="button" className="mv-textbtn" data-mv-ai-use onClick={onUse}>{t('ai.actions.useInReply')}</button>}
      </div>
    </Sheet>
  );
}
