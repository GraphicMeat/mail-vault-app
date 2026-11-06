// The message viewer. The header (subject, sender, recipients, date) comes from the list row, so it
// paints on the tap; the body follows from `mobile.message.body` and is drawn in an iframe whose
// document `buildMailFrame` builds (mailFrame.js: CSP first, links out of the frame, hostile parts
// taken out). The frame is sandboxed with popups only, so a link opens in the system browser and
// the mail can never run script or reach the app's origin. Remote images stay blocked by the CSP
// until the user taps "Load images", which mounts a new frame with https: images allowed.
// The perf probe's tap-to-paint mark (`viewerPainted`) is raised after the first paint of the
// header, never on the body: the gate measures navigation, not the network.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { displayText } from '../utils/bidiText.js';
import { daemonCall } from './transport.js';
import { buildMailFrame } from './mailFrame.js';
import { formatFullDate, formatSize } from './format.js';
import { ERROR_KEYS, errorKey } from './errors.js';
import { afterNextPaint, viewerPainted } from './perf.js';
import { useT } from './i18n.js';

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

export default function Viewer({ accountId, folder, row, onClose }) {
  const t = useT();
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
  const srcDoc = useMemo(
    () => (hasContent ? buildMailFrame({ html: body.html, text: body.text, allowRemote, theme, trackerLabel }) : null),
    [body, hasContent, allowRemote, theme, trackerLabel],
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
        />
      )}
    </section>
  );
}
