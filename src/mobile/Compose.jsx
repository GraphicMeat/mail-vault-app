// The compose screen: a full-screen layer for a new message, a reply, a reply to all or a forward.
// Plain text only. From is the account. Recipients are chips (RecipientField.jsx); Send stays off
// until there is a To and every address reads (the engine refuses Bcc only, so the screen does
// too). A reply or forward is prefilled by `mobile.compose.prepare` from mobile.db: fields the
// user already touched are never overwritten by a late answer. The quote goes under the body as
// plain text (`quoteText`; the HTML `quote` is not used). A forward's attachments not yet
// downloaded (`pending`) are fetched through the attachment jobs, then prepare is asked again;
// one that fails, or shows no progress for STALL_MS, is marked failed and left out with a note;
// a part still downloading can be removed (its job is cancelled). `draftId` reopens a saved draft
// (`mobile.drafts.get`): the fields stay read-only until it is loaded, and only then does
// autosave run, under that draft's id. A draft that cannot be loaded is never saved or deleted
// from here: the screen says so and Back just closes. A draft keeps the mode it was started as
// (its title).
//
// Drafts are local (`mobile.drafts.*`): saved 1.5 s after the last edit, when the app goes to the
// background and when the user leaves with "Save draft"; a draft emptied and left is deleted.
// Back with content asks: Save draft, Discard or Keep editing. Send first stops autosave and waits
// for a save in flight, so no late save can bring back the draft the send deletes; a refused send
// (TOO_LARGE, ATTACHMENT_MISSING, INVALID) stays on the screen with its reason and autosave runs
// again. A queued send leaves at once: the outbox (store `outbox`) takes it from there.
//
// Send later (plan 4 Task 8): the clock beside Send opens the time sheet (SendLater.jsx); the
// chosen time goes with the send as `sendAtMs` and the message waits in the outbox's Scheduled
// section. A time past 5 minutes without Premium opens the paywall instead; the engine's refusal
// (PREMIUM_REQUIRED, SCHEDULE_TOO_FAR) is shown in place like any other.
//
// Follow-up reminder (plan 4 Task 9): "Remind me if no reply" under the subject (off, 1 day, 3 days,
// 1 week) goes with the send as `remindAfterDays`; the engine records the reminder once the message
// went out. A choice without Premium opens the paywall instead and stays off. Not offered on a
// Graph account (desktop parity). The engine's refusal (PREMIUM_REQUIRED) is shown in place.
//
// Keyboard: the screen is laid on the visible part of the screen above the keyboard and only its
// fields scroll (keyboardViewport.js); targets are 44 pt.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboardViewport } from './keyboardViewport.js';
import { displayText } from '../utils/bidiText.js';
import { daemonCall, pickFiles } from './transport.js';
import { ensureAttachmentEvents, watchJob } from './attachmentJobs.js';
import { fieldsOf, initialText, isEmpty, isValidEntry, sendError, splitList } from './compose.js';
import RecipientField, { commitText } from './RecipientField.jsx';
import Sheet from './Sheet.jsx';
import SendLater from './SendLater.jsx';
import { openPaywall, usePremium } from './premium.js';
import { formatFullDate, formatSize } from './format.js';
import { useBackLayer } from './backStack.js';
import { useMobileStore } from './store.js';
import { useT } from './i18n.js';

/** Quiet time after the last edit before the draft is saved. */
export const AUTOSAVE_MS = 1500;
/** A forwarded part with no progress for this long is given up on. */
export const STALL_MS = 60_000;

/** The reminder choices: days, and the label's key. */
const REMIND_CHOICES = Object.freeze([
  [0, 'compose.remind.off'],
  [1, 'compose.remind.days1'],
  [3, 'compose.remind.days3'],
  [7, 'compose.remind.days7'],
]);

const TITLE_KEYS = Object.freeze({
  new: 'mobile.compose.newTitle',
  reply: 'emailActionBar.reply',
  replyAll: 'emailActionBar.replyAll',
  forward: 'emailActionBar.forward',
});

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7L9.2 17.2a1.7 1.7 0 0 1-2.4-2.4L14.5 7" />
    </svg>
  );
}

/** Waits for one attachment job: true once it is in the cache, false when it failed or stalled. */
function fetchPart(accountId, folder, uid, section, cancels) {
  return daemonCall('mobile.attachment.fetch', { accountId, folder, uid, section }).then(
    (reply) => new Promise((resolve) => {
      const jobId = reply?.jobId;
      if (jobId == null) {
        resolve(false);
        return;
      }
      let stop = null;
      let ended = false;
      let stall = null;
      const end = (ok) => {
        if (ended) return;
        ended = true;
        clearTimeout(stall);
        stop?.();
        resolve(ok);
      };
      const cancel = () => {
        if (ended) return;
        daemonCall('mobile.attachment.cancel', { jobId }).catch(() => {});
        end(false);
      };
      const arm = () => {
        clearTimeout(stall);
        stall = setTimeout(cancel, STALL_MS);
      };
      // The user removed the part while it downloads: the job goes too.
      cancels.set(section, cancel);
      if (cancels.removed?.has(section)) {
        cancel();
        return;
      }
      arm();
      stop = watchJob(jobId, (kind) => {
        if (kind === 'progress') arm();
        else end(kind === 'done');
      });
      if (ended) stop();
    }),
    () => false,
  );
}

export default function Compose({ accountId, fromEmail, mode = 'new', original = null, draftId: openDraft = null, onClose }) {
  const t = useT();
  const [to, setTo] = useState({ entries: [], text: '' });
  const [cc, setCc] = useState({ entries: [], text: '' });
  const [bcc, setBcc] = useState({ entries: [], text: '' });
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState([]); // [{ handle, name, size, mime, forwarded? }]
  const [fetching, setFetching] = useState([]); // forwarded parts: [{ section, filename, size, failed? }]
  const [notes, setNotes] = useState([]); // translated one-liners: a left-out forward, an unreadable pick
  const [error, setError] = useState(null); // a message key, or a send refusal's { key, vars }
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [later, setLater] = useState(false);
  const [remind, setRemind] = useState(0); // follow-up reminder in days, 0 for none
  const premium = usePremium();
  const remindOffered = useMobileStore((s) => s.accounts.find((a) => a.id === accountId)?.kind !== 'graph');
  const [edits, setEdits] = useState(0);

  const threading = useRef({ inReplyTo: '', references: '' });
  const touched = useRef(new Set());
  // The draft's id only once its stored version is loaded: nothing may save over it before.
  const draftId = useRef(null);
  const [loading, setLoading] = useState(Boolean(openDraft));
  const [shownMode, setShownMode] = useState(mode);
  const modeRef = useRef(mode);
  modeRef.current = shownMode;
  const cancels = useRef(Object.assign(new Map(), { removed: new Set() }));
  const timer = useRef(null);
  const stopped = useRef(false);
  const chain = useRef(Promise.resolve());
  const removedSections = cancels.current.removed;
  const live = useRef(true);
  const sheet = useRef(null);
  const scroller = useRef(null);

  // What a save or a send carries, typed-but-uncommitted addresses included.
  const committed = (field) => commitText(field.entries, field.text, { all: true }).entries;
  const current = () => ({
    to: committed(latest.current.to),
    cc: committed(latest.current.cc),
    bcc: committed(latest.current.bcc),
    subject: latest.current.subject,
    text: latest.current.text,
    attachments: latest.current.attachments,
    ...threading.current,
  });
  const latest = useRef(null);
  latest.current = { to, cc, bcc, subject, text, attachments };

  const locked = useRef(Boolean(openDraft));
  const edit = (name) => {
    if (locked.current) return;
    touched.current.add(name);
    setEdits((n) => n + 1);
  };

  // ── Drafts ────────────────────────────────────────────────────────────────
  const saveNow = useCallback(() => {
    clearTimeout(timer.current);
    // Resolves true once saved (or nothing needed saving), false when the engine refused.
    const run = chain.current.then(async () => {
      if (stopped.current) return true;
      const fields = current();
      if (isEmpty(fields)) return true; // leaving deletes it; nothing worth a row meanwhile
      try {
        const reply = await daemonCall('mobile.drafts.save', {
          ...(draftId.current ? { id: draftId.current } : {}),
          accountId,
          ...fieldsOf(fields),
          mode: modeRef.current,
        });
        if (reply?.id) draftId.current = reply.id;
        return true;
      } catch {
        // Autosave is a safety net: the next edit tries again.
        return false;
      }
    });
    chain.current = run.then(() => undefined);
    return run;
  }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Stops autosave for good (until a refused send re-arms it) and waits for a save in flight. */
  const stopSaving = useCallback(() => {
    stopped.current = true;
    clearTimeout(timer.current);
    return chain.current;
  }, []);

  useEffect(() => {
    if (edits === 0 || stopped.current) return undefined;
    clearTimeout(timer.current);
    timer.current = setTimeout(saveNow, AUTOSAVE_MS);
    return undefined;
  }, [edits, saveNow]);

  // The app going to the background saves at once; leaving the screen otherwise is decided below.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onHide = () => {
      if (document.visibilityState === 'hidden' && touched.current.size && !stopped.current) saveNow();
    };
    const onPageHide = () => { if (touched.current.size && !stopped.current) saveNow(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [saveNow]);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      clearTimeout(timer.current);
      // Unmounted without leaving through the screen (the account went away): keep what was typed.
      if (touched.current.size && !stopped.current) saveNow();
    };
  }, [saveNow]);

  // ── A saved draft, reopened ───────────────────────────────────────────────
  useEffect(() => {
    if (!openDraft) return;
    (async () => {
      let d = null;
      try {
        d = await daemonCall('mobile.drafts.get', { id: openDraft });
      } catch {
        d = null;
      }
      if (!live.current) return;
      if (!d) {
        // The stored draft stays as it is: no save, no delete, nothing to send from here.
        stopped.current = true;
        setLoading(false);
        setError('mobile.drafts.loadFailed');
        return;
      }
      threading.current = { inReplyTo: d.inReplyTo || '', references: d.references || '' };
      setTo({ entries: splitList(d.to), text: '' });
      setCc({ entries: splitList(d.cc), text: '' });
      setBcc({ entries: splitList(d.bcc), text: '' });
      if (splitList(d.cc).length || splitList(d.bcc).length) setShowCc(true);
      setSubject(d.subject || '');
      setText(d.text || '');
      setAttachments((Array.isArray(d.attachments) ? d.attachments : []).map((a) => ({ handle: a.handle, name: a.name, size: a.size, mime: a.mime })));
      if (Object.hasOwn(TITLE_KEYS, d.mode)) setShownMode(d.mode);
      draftId.current = openDraft;
      locked.current = false;
      setLoading(false);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Prepare (reply, reply all, forward) ───────────────────────────────────
  useEffect(() => {
    if (mode === 'new' || !original) return undefined;
    ensureAttachmentEvents();
    const params = {
      accountId,
      mode,
      folder: original.folder,
      uid: original.uid,
      originalLabel: t('mobile.compose.originalMessage'),
      ...(original.dateMs ? { dateLabel: formatFullDate(original.dateMs) } : {}),
      fromLabel: t('common.from'),
      dateFieldLabel: t('mobile.compose.quoteDate'),
      subjectLabel: t('compose.subject'),
    };
    const fill = (field, value, setter) => { if (!touched.current.has(field)) setter(value); };
    const forwardsOf = (list) => (Array.isArray(list) ? list : [])
      .map((a) => ({ handle: a.handle, name: a.name, size: a.size, mime: a.mime, section: a.section, forwarded: true }));

    (async () => {
      let p;
      try {
        p = await daemonCall('mobile.compose.prepare', params);
      } catch {
        if (live.current) setNotes((n) => [...n, t('mobile.compose.prepareFailed')]);
        return;
      }
      if (!live.current || !p) return;
      threading.current = { inReplyTo: p.inReplyTo || '', references: p.references || '' };
      fill('to', { entries: splitList(p.to), text: '' }, setTo);
      const ccEntries = splitList(p.cc);
      fill('cc', { entries: ccEntries, text: '' }, setCc);
      if (ccEntries.length) setShowCc(true);
      fill('subject', p.subject || '', setSubject);
      fill('text', initialText(p.quoteText || ''), setText);
      setAttachments((list) => [...list, ...forwardsOf(p.attachments)]);
      const pending = Array.isArray(p.pending) ? p.pending : [];
      if (!pending.length) return;

      setFetching(pending.map((a) => ({ section: a.section, filename: a.filename, size: a.size })));
      const results = await Promise.all(pending.map((a) => fetchPart(accountId, original.folder, original.uid, a.section, cancels.current).then((ok) => {
        // A failed or stalled part shows as failed at once (removable); Send waits for no one.
        if (!ok && live.current) setFetching((list) => list.map((f) => (f.section === a.section ? { ...f, failed: true } : f)));
        return ok;
      })));
      if (!live.current) return;
      let again = null;
      if (results.some(Boolean)) {
        try {
          again = await daemonCall('mobile.compose.prepare', params);
        } catch {
          again = null;
        }
      }
      if (!live.current) return;
      const missing = again && Array.isArray(again.pending) ? again.pending.map((a) => a.section) : pending.map((a) => a.section);
      if (again) {
        // The second answer lists every forwarded part again; the user's removals still hold.
        const kept = forwardsOf(again.attachments).filter((a) => a.section == null || !removedSections.has(a.section));
        setAttachments((list) => [...list.filter((a) => !a.forwarded), ...kept]);
      }
      const left = pending.filter((a) => missing.includes(a.section) && !removedSections.has(a.section));
      if (left.length) {
        setNotes((n) => [...n, ...left.map((a) => t('mobile.compose.forwardMissing', { name: displayText(a.filename, '') || t('mobile.viewer.attachment') }))]);
      }
      setFetching([]);
    })();
    return undefined;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Attach ────────────────────────────────────────────────────────────────
  const pick = async (kind) => {
    setAttaching(false);
    let items;
    try {
      items = await pickFiles(kind);
    } catch (err) {
      if (live.current && err?.code !== 'BUSY') setNotes((n) => [...n, t('mobile.compose.pickFailed')]);
      return;
    }
    if (!live.current) return;
    const good = items.filter((a) => !a.error);
    const bad = items.filter((a) => a.error);
    if (bad.length) setNotes((n) => [...n, ...bad.map((a) => t('mobile.compose.unreadable', { name: displayText(a.name, '') || t('mobile.viewer.attachment') }))]);
    if (good.length) {
      setAttachments((list) => [...list, ...good]);
      edit('attachments');
    }
  };
  const removeFetching = (part) => {
    removedSections.add(part.section);
    cancels.current.get(part.section)?.();
    setFetching((list) => list.filter((f) => f.section !== part.section));
  };
  const removeAttachment = (at) => {
    if (locked.current) return;
    const gone = attachments[at];
    if (gone?.forwarded && gone.section != null) removedSections.add(gone.section);
    setAttachments((list) => list.filter((_, i) => i !== at));
    edit('attachments');
  };

  // ── Send ──────────────────────────────────────────────────────────────────
  const toAll = useMemo(() => commitText(to.entries, to.text, { all: true }).entries, [to]);
  const ccAll = useMemo(() => commitText(cc.entries, cc.text, { all: true }).entries, [cc]);
  const bccAll = useMemo(() => commitText(bcc.entries, bcc.text, { all: true }).entries, [bcc]);
  const invalid = [...toAll, ...ccAll, ...bccAll].some((e) => !isValidEntry(e));
  const noTo = toAll.length === 0;
  const canSend = !sending && !locked.current && !noTo && !invalid && !fetching.some((f) => !f.failed);

  /** Sends now, or at `sendAtMs` (unix ms) when given. */
  const send = async (sendAtMs = null) => {
    setLater(false);
    if (!canSend) return;
    // What is still in an input goes out as a chip.
    setTo({ entries: toAll, text: '' });
    setCc({ entries: ccAll, text: '' });
    setBcc({ entries: bccAll, text: '' });
    setSending(true);
    setError(null);
    await stopSaving();
    const id = draftId.current;
    try {
      await daemonCall('mobile.compose.send', {
        accountId, ...(id ? { draftId: id } : {}), ...fieldsOf(current()), ...(sendAtMs != null ? { sendAtMs } : {}),
        ...(remind > 0 && remindOffered ? { remindAfterDays: remind } : {}),
      });
    } catch (err) {
      if (!live.current) return;
      stopped.current = false;
      setSending(false);
      // Premium ended since the reminder was chosen (a send-later time is checked first).
      const reminderRefused = err?.code === 'PREMIUM_REQUIRED' && remind > 0 && sendAtMs == null;
      setError(reminderRefused ? 'compose.remind.upsell' : sendError(err));
      scroller.current?.scrollTo?.({ top: 0 });
      return;
    }
    useMobileStore.getState().loadOutbox();
    onClose();
  };

  // ── Leave ─────────────────────────────────────────────────────────────────
  const discard = useCallback(async () => {
    setConfirming(false);
    await stopSaving();
    const id = draftId.current;
    draftId.current = null;
    if (id) await daemonCall('mobile.drafts.delete', { id }).catch(() => {});
    onClose();
  }, [stopSaving, onClose]);

  const saveAndLeave = useCallback(async () => {
    setConfirming(false);
    setError(null);
    const ok = await saveNow();
    if (!live.current) return;
    if (!ok) {
      // Leaving now would lose the message: stay, and say why.
      setError('mobile.compose.saveFailed');
      scroller.current?.scrollTo?.({ top: 0 });
      return;
    }
    stopped.current = true;
    onClose();
  }, [saveNow, onClose]);

  const requestLeave = useCallback(() => {
    if (touched.current.size === 0) {
      // Nothing changed here: a reopened draft stays as it was.
      stopSaving().then(onClose);
      return;
    }
    if (isEmpty(current())) discard();
    else setConfirming(true);
  }, [discard, stopSaving, onClose]); // eslint-disable-line react-hooks/exhaustive-deps
  const keepEditing = useCallback(() => setConfirming(false), []);
  const closeAttach = useCallback(() => setAttaching(false), []);
  const closeLater = useCallback(() => setLater(false), []);

  useBackLayer(!confirming && !attaching && !later, requestLeave);
  useBackLayer(confirming, keepEditing);
  useBackLayer(attaching, closeAttach);
  useBackLayer(later, closeLater);
  useKeyboardViewport(sheet, scroller);

  const title = t(TITLE_KEYS[shownMode] || TITLE_KEYS.new);
  let hint = null;
  if (invalid) hint = t('mobile.compose.invalidAddress');
  else if (noTo && (ccAll.length || bccAll.length)) hint = t('mobile.compose.needTo');

  return (
    <section ref={sheet} className="mv-compose" role="dialog" aria-modal="true" aria-label={title}>
      <header className="mv-compose__bar">
        <button type="button" className="mv-compose__back" data-mv-compose-close onClick={requestLeave}>
          {t('common.back')}
        </button>
        <h1 className="mv-compose__title">{title}</h1>
        <button type="button" className="mv-iconbtn" aria-label={t('mobile.compose.attach')} disabled={locked.current} onClick={() => setAttaching(true)}>
          <PaperclipIcon />
        </button>
        <button type="button" className="mv-iconbtn" data-mv-send-later-open aria-label={t('mobile.compose.sendLater')} disabled={!canSend} onClick={() => setLater(true)}>
          <ClockIcon />
        </button>
        <button
          type="button"
          className={`mv-compose__send${sending ? ' mv-compose__send--busy' : ''}`}
          data-mv-send
          aria-label={sending ? t('mobile.compose.sending') : t('compose.send')}
          aria-busy={sending ? 'true' : undefined}
          disabled={!canSend}
          onClick={() => send()}
        >
          {sending && <span className="mv-chip__spinner" aria-hidden="true" />}
          {sending ? t('mobile.compose.sending') : t('compose.send')}
        </button>
      </header>
      <div ref={scroller} className="mv-compose__scroll">
        {error && <p className="mv-compose__error" role="alert">{typeof error === 'string' ? t(error) : t(error.key, error.vars)}</p>}
        <div className="mv-compose__line">
          <span className="mv-compose__label">{t('common.from')}</span>
          <span className="mv-compose__from" dir="auto">{fromEmail}</span>
        </div>
        <RecipientField label={t('common.to')} entries={to.entries} text={to.text} readOnly={loading || locked.current} onChange={(v) => { if (!locked.current) { setTo(v); edit('to'); } }} />
        {showCc ? (
          <>
            <RecipientField label={t('mobile.compose.cc')} entries={cc.entries} text={cc.text} readOnly={loading || locked.current} onChange={(v) => { if (!locked.current) { setCc(v); edit('cc'); } }} />
            <RecipientField label={t('mobile.compose.bcc')} entries={bcc.entries} text={bcc.text} readOnly={loading || locked.current} onChange={(v) => { if (!locked.current) { setBcc(v); edit('bcc'); } }} />
          </>
        ) : (
          <button type="button" className="mv-compose__more" onClick={() => setShowCc(true)}>{t('mobile.compose.showCc')}</button>
        )}
        {hint && <p className="mv-compose__hint">{hint}</p>}
        <div className="mv-compose__line">
          <label className="mv-compose__label" htmlFor="mv-compose-subject">{t('compose.subject')}</label>
          <input
            id="mv-compose-subject"
            className="mv-compose__input"
            dir="auto"
            value={subject}
            readOnly={loading || locked.current}
            onChange={(e) => { if (!locked.current) { setSubject(e.target.value); edit('subject'); } }}
          />
        </div>
        {remindOffered && (
          <div className="mv-compose__line" data-mv-remind>
            <label className="mv-compose__label mv-compose__remind-label" htmlFor="mv-compose-remind">
              {t('compose.remind.title')}
              {!premium && <span className="mv-schedule__premium">{t('common.premium')}</span>}
            </label>
            <select
              id="mv-compose-remind"
              className="mv-compose__select"
              value={remind}
              disabled={locked.current}
              onChange={(e) => {
                const days = Number(e.target.value) || 0;
                if (days > 0 && !premium) {
                  setRemind(0);
                  openPaywall('followUp');
                  return;
                }
                setRemind(days);
              }}
            >
              {REMIND_CHOICES.map(([days, key]) => <option key={days} value={days}>{t(key)}</option>)}
            </select>
          </div>
        )}
        {(attachments.length > 0 || fetching.length > 0) && (
          <ul className="mv-compose__files" aria-label={t('common.attachmentCount', { count: attachments.length + fetching.length })}>
            {attachments.map((a, i) => (
              <li key={a.handle} className="mv-compose__file">
                <span className="mv-compose__file-name" dir="auto">{displayText(a.name, '') || t('mobile.viewer.attachment')}</span>
                <span className="mv-compose__file-size">{formatSize(a.size)}</span>
                <button type="button" className="mv-rcpt__remove mv-compose__file-remove" aria-label={t('mobile.compose.removeAttachment', { name: a.name || '' })} onClick={() => removeAttachment(i)}>
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
                    <path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              </li>
            ))}
            {fetching.map((a) => {
              const name = displayText(a.filename, '') || t('mobile.viewer.attachment');
              return (
                <li key={`fetch:${a.section}`} className={`mv-compose__file mv-compose__file--pending${a.failed ? ' mv-compose__file--failed' : ''}`} data-mv-fetching={a.section}>
                  <span className="mv-compose__file-name" dir="auto">{name}</span>
                  <span className="mv-compose__file-size" role="status">{a.failed ? t('mobile.compose.downloadFailed') : t('mobile.compose.downloading')}</span>
                  <button type="button" className="mv-rcpt__remove mv-compose__file-remove" aria-label={t('mobile.compose.removeAttachment', { name })} onClick={() => removeFetching(a)}>
                    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
                      <path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {notes.map((note, i) => (
          // eslint-disable-next-line react/no-array-index-key -- notes only grow
          <p key={i} className="mv-compose__note" role="status">{note}</p>
        ))}
        <textarea
          className="mv-compose__body"
          aria-label={t('mobile.compose.body')}
          dir="auto"
          value={text}
          readOnly={loading || locked.current}
          placeholder={loading ? t('mobile.drafts.loading') : undefined}
          onChange={(e) => { if (!locked.current) { setText(e.target.value); edit('text'); } }}
        />
      </div>
      {confirming && (
        <Sheet kind="sheet" label={t('mobile.compose.leaveTitle')} onClose={keepEditing}>
          <div className="mv-sheet__grip" aria-hidden="true" />
          <h2 className="mv-sheet__title">{t('mobile.compose.leaveTitle')}</h2>
          <div className="mv-sheet__actions">
            <button type="button" className="mv-sheet__action" onClick={saveAndLeave}>{t('mobile.compose.saveDraft')}</button>
            <button type="button" className="mv-sheet__action mv-sheet__action--danger" onClick={discard}>{t('common.discard')}</button>
            <button type="button" className="mv-sheet__action" onClick={keepEditing}>{t('mobile.compose.keepEditing')}</button>
          </div>
        </Sheet>
      )}
      {later && <SendLater title={t('mobile.compose.sendLater')} onPick={(at) => send(at)} onClose={closeLater} />}
      {attaching && (
        <Sheet kind="sheet" label={t('mobile.compose.attach')} onClose={closeAttach}>
          <div className="mv-sheet__grip" aria-hidden="true" />
          <h2 className="mv-sheet__title">{t('mobile.compose.attach')}</h2>
          <div className="mv-sheet__actions">
            <button type="button" className="mv-sheet__action" onClick={() => pick('photos')}>{t('mobile.compose.pickPhotos')}</button>
            <button type="button" className="mv-sheet__action" onClick={() => pick('files')}>{t('mobile.compose.pickFiles')}</button>
            <button type="button" className="mv-sheet__action" onClick={closeAttach}>{t('common.cancel')}</button>
          </div>
        </Sheet>
      )}
    </section>
  );
}
