// The message viewer. The header (subject, sender, recipients, date) comes from the list row, so it
// paints on the tap; the body follows from `mobile.message.body` and is drawn in an iframe whose
// document `prepareMailBody` + `assembleMailFrame` build (mailFrame.js: CSP first, links out of the frame, hostile parts
// taken out). The frame is sandboxed with popups only, so a link opens in the system browser and
// the mail can never run script or reach the app's origin. Remote images stay blocked by the CSP
// until the user taps "Load images", which mounts a new frame with https: images allowed.
// The perf probe's tap-to-paint mark (`viewerPainted`) is raised after the first paint of the
// header, never on the body: the gate measures navigation, not the network.
// The toolbar at the bottom acts on the message: read or unread, flag, move (MovePicker.jsx over
// the account's folders) and delete; App.jsx sends the actions (store `act`).
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { displayText } from '../utils/bidiText.js';
import { daemonCall } from './transport.js';
import { assembleMailFrame, prepareMailBody } from './mailFrame.js';
import { formatFullDate, formatSize } from './format.js';
import { ERROR_KEYS, errorKey } from './errors.js';
import { afterNextPaint, bodyLoaded, notePrepare, viewerPainted } from './perf.js';
import { useT } from './i18n.js';
import MovePicker from './MovePicker.jsx';
import { useBackLayer } from './backStack.js';
import { EnvelopeIcon, FlagIcon, MoveIcon, TrashIcon } from './icons.jsx';

/** Exactly this, never more: no `allow-same-origin`, no `allow-scripts`. */
export const FRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

const LIGHT_QUERY = '(prefers-color-scheme: light)';

/** The app's theme: dark by default, light when the system is (mobile.css follows the same rule). */
function useAppTheme() {
  const query = useMemo(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(LIGHT_QUERY) : null), []);
  const [light, setLight] = useState(() => Boolean(query?.matches));
  useEffect(() => {
    if (!query?.addEventListener) return undefined;
    const onChange = (e) => setLight(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [query]);
  return light ? 'light' : 'dark';
}

/** The engine answers a network failure as `INTERNAL` with the accounts code as the message. */
function failureCode(err) {
  if (err?.code === 'INTERNAL' && Object.hasOwn(ERROR_KEYS, err.message)) return err.message;
  return err?.code;
}

function recipientsOf(row) {
  const to = Array.isArray(row.to) ? row.to : [];
  return to.map((a) => displayText(a?.name, '') || displayText(a?.address, '')).filter(Boolean).join(', ');
}

function Header({ row }) {
  const t = useT();
  const name = displayText(row.fromName, '');
  const address = displayText(row.fromAddress, '');
  const to = recipientsOf(row);
  const date = formatFullDate(row.dateMs);
  return (
    <div className="mv-viewer__header">
      <h1 className="mv-viewer__subject" dir="auto">{displayText(row.subject, t('common.noSubject'))}</h1>
      <dl className="mv-viewer__meta">
        <div className="mv-viewer__line">
          <dt>{t('common.from')}</dt>
          <dd dir="auto">
            <span className="mv-viewer__name">{name || address || t('explorer.unknownSender')}</span>
            {name && address && <span className="mv-viewer__address">{address}</span>}
          </dd>
        </div>
        {to && (
          <div className="mv-viewer__line">
            <dt>{t('common.to')}</dt>
            <dd dir="auto">{to}</dd>
          </div>
        )}
      </dl>
      {date && <time className="mv-viewer__date" dateTime={new Date(row.dateMs).toISOString()}>{date}</time>}
    </div>
  );
}

function Attachments({ items }) {
  const t = useT();
  if (items.length === 0) return null;
  return (
    <ul className="mv-viewer__chips" aria-label={t('common.attachmentCount', { count: items.length })}>
      {items.map((a) => (
        <li key={a.section} className="mv-viewer__chip">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7L9.2 17.2a1.7 1.7 0 0 1-2.4-2.4L14.5 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="mv-viewer__chip-name" dir="auto">{displayText(a.filename, '') || t('mobile.viewer.attachment')}</span>
          <span className="mv-viewer__chip-size">{formatSize(a.size)}</span>
        </li>
      ))}
    </ul>
  );
}

function Toolbar({ seen, flagged, onSeen, onFlag, onMove, onDelete }) {
  const t = useT();
  return (
    <div className="mv-viewer__toolbar" role="toolbar" aria-label={t('mobile.actions.toolbar')}>
      <button type="button" className="mv-tool" data-mv-tool="seen" aria-label={seen ? t('mobile.actions.markUnread') : t('mobile.actions.markRead')} onClick={onSeen}>
        <EnvelopeIcon open={seen} />
      </button>
      <button type="button" className="mv-tool" data-mv-tool="flag" aria-pressed={flagged ? 'true' : 'false'} aria-label={flagged ? t('mobile.actions.unflag') : t('mobile.actions.flag')} onClick={onFlag}>
        <FlagIcon filled={flagged} />
      </button>
      <button type="button" className="mv-tool" data-mv-tool="move" aria-label={t('mobile.actions.move')} onClick={onMove}>
        <MoveIcon />
      </button>
      <button type="button" className="mv-tool mv-tool--danger" data-mv-tool="delete" aria-label={t('common.delete')} onClick={onDelete}>
        <TrashIcon />
      </button>
    </div>
  );
}

const noop = () => {};

export default function Viewer({ accountId, folder, row, onClose, folders = [], onAction = noop, onMove = noop, onDelete = noop, initialPicking = false }) {
  const t = useT();
  const [seen, setSeen] = useState(row.seen !== false);
  const [flagged, setFlagged] = useState(Boolean(row.flagged));
  const [picking, setPicking] = useState(initialPicking);
  const closePicker = useCallback(() => setPicking(false), []);
  useBackLayer(picking, closePicker);
  const toggleSeen = () => {
    onAction(seen ? 'unseen' : 'seen');
    setSeen(!seen);
  };
  const toggleFlag = () => {
    onAction(flagged ? 'unflag' : 'flag');
    setFlagged(!flagged);
  };
  const pick = (target) => {
    setPicking(false);
    onMove(target);
  };
  const theme = useAppTheme();
  const [state, setState] = useState({ phase: 'loading' }); // loading | ready | gone | failed
  const [allowRemote, setAllowRemote] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useLayoutEffect(() => {
    if (typeof requestAnimationFrame === 'function' && typeof MessageChannel === 'function') {
      afterNextPaint(viewerPainted);
    }
  }, []);

  useEffect(() => {
    let live = true;
    setState({ phase: 'loading' });
    daemonCall('mobile.message.body', { accountId, folder, uid: row.uid }).then(
      (body) => {
        if (live) setState(body?.gone ? { phase: 'gone' } : { phase: 'ready', body });
      },
      (err) => {
        if (live) setState({ phase: 'failed', code: failureCode(err) });
      },
    );
    return () => { live = false; };
  }, [accountId, folder, row.uid, attempt]);

  const body = state.phase === 'ready' ? state.body : null;
  const hasContent = Boolean(body && ((body.html && body.html.trim()) || (body.text && body.text.trim())));
  const trackerLabel = t('mobile.viewer.trackerBlocked');
  // The expensive part (parse, clean, re-parse to a fixpoint, check) once per body; Load images
  // and a theme change only re-assemble our head around it (string work).
  const html = body?.html;
  const text = body?.text;
  const prepared = useMemo(() => {
    if (!hasContent) return null;
    const t0 = performance.now();
    const out = prepareMailBody({ html, text });
    notePrepare(performance.now() - t0, (html || text || '').length);
    return out;
  }, [html, text, hasContent]);
  const srcDoc = useMemo(
    () => (prepared ? assembleMailFrame(prepared, { allowRemote, theme, trackerLabel }) : null),
    [prepared, allowRemote, theme, trackerLabel],
  );
  // Every part is a chip, inline `cid:` images too: the frame does not draw those yet.
  const attachments = body?.attachments || [];
  const remoteImages = body?.remoteImages || 0;
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <section className="mv-viewer" aria-modal="true" role="dialog" aria-label={displayText(row.subject, t('common.noSubject'))}>
      <div className="mv-viewer__top">
        <header className="mv-viewer__bar">
          <button type="button" className="mv-viewer__back" data-mv-viewer-close style={{ minHeight: '44px', minWidth: '44px' }} onClick={onClose}>
            {t('common.back')}
          </button>
        </header>
        <Header row={row} />
        <Attachments items={attachments} />
      </div>
      {remoteImages > 0 && !allowRemote && (
        <div className="mv-viewer__images">
          <span>{t('mobile.viewer.imagesBlocked')}</span>
          <button type="button" data-mv-load-images style={{ minHeight: '44px' }} onClick={() => setAllowRemote(true)}>
            {t('mobile.viewer.loadImages', { count: remoteImages })}
          </button>
        </div>
      )}
      {state.phase === 'loading' && <p className="mv-viewer__notice" role="status">{t('mobile.viewer.loading')}</p>}
      {state.phase === 'gone' && <p className="mv-viewer__notice">{t('mobile.viewer.gone')}</p>}
      {state.phase === 'failed' && (
        <div className="mv-viewer__notice" role="alert">
          <p>{t('mobile.viewer.loadFailed', { reason: t(errorKey(state.code)) })}</p>
          <button type="button" style={{ minHeight: '44px' }} onClick={retry}>{t('common.retry')}</button>
        </div>
      )}
      {state.phase === 'ready' && !hasContent && <p className="mv-viewer__notice">{t('mobile.viewer.empty')}</p>}
      {srcDoc && (
        <iframe
          key={`${allowRemote ? 'remote' : 'local'}-${theme}`}
          className="mv-viewer__frame"
          title={t('mobile.viewer.frameTitle')}
          sandbox={FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
          onLoad={() => bodyLoaded(performance.now())}
        />
      )}
      {!srcDoc && <div className="mv-viewer__fill" />}
      <Toolbar seen={seen} flagged={flagged} onSeen={toggleSeen} onFlag={toggleFlag} onMove={() => setPicking(true)} onDelete={onDelete} />
      {picking && <MovePicker folders={folders} current={folder} onPick={pick} onClose={closePicker} />}
    </section>
  );
}
