// One attachment of the open message, as a chip in the viewer's attachment row.
//   idle         name and size; tap downloads it (`mobile.attachment.fetch`)
//   downloading  a progress ring from `mobile.attachment.progress`; tap cancels
//   ready        tap opens it in the system previewer, a long press offers the share sheet
//   failed       the reason, translated; tap tries again
// The file never crosses the bridge: the shell is handed the path `mobile.attachment.local`
// answers right before each open or share (a file evicted meanwhile answers null: fetch again),
// checks it is a file of the attachment cache, and gives the previewer a named copy.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { displayText } from '../utils/bidiText.js';
import { daemonCall, openFile, shareFile } from './transport.js';
import { ensureAttachmentEvents, watchJob } from './attachmentJobs.js';
import { formatPercent, formatSize } from './format.js';
import { useT } from './i18n.js';

/** Held this long, a press on a ready chip shares instead of opening. */
export const LONG_PRESS_MS = 500;
/** A press that moves this far is a scroll of the chip row, not a long press. */
const MOVE_SLOP_PX = 10;

// The engine's failure codes (accounts mapper codes plus GONE, CANCELLED, INVALID), each to a
// short reason that fits a chip. Literal keys, so the catalog tests can see every one.
const REASON_KEYS = Object.freeze({
  HOST_UNREACHABLE: 'mobile.attachment.error.network',
  TIMEOUT: 'mobile.attachment.error.network',
  TLS_FAILED: 'mobile.attachment.error.network',
  AUTH_FAILED: 'mobile.attachment.error.auth',
  GONE: 'mobile.attachment.error.gone',
  // The engine's INVALID on a job is a disk failure (the cache file could not be written).
  INVALID: 'mobile.attachment.error.storage',
  NO_APP: 'mobile.attachment.error.noApp',
  OPEN_FAILED: 'mobile.attachment.error.openFailed',
  INTERNAL: 'mobile.attachment.error.internal',
});

function reasonKey(code) {
  return Object.hasOwn(REASON_KEYS, code) ? REASON_KEYS[code] : REASON_KEYS.INTERNAL;
}

/** A failed RPC: the engine answers a network failure as `INTERNAL` with the code as message. */
function codeOf(err) {
  if (err?.code === 'INTERNAL' && Object.hasOwn(REASON_KEYS, err.message)) return err.message;
  return err?.code || 'INTERNAL';
}

/** A refused fetch (INVALID: unsynced folder, bad section) is not the disk failure a job's
 *  INVALID means: it reads as the generic failure. */
function refusedFetchCode(err) {
  const code = codeOf(err);
  return code === 'INVALID' ? 'INTERNAL' : code;
}

const R = 9;
const CIRCUMFERENCE = 2 * Math.PI * R;

function ChipIcon({ phase, fraction }) {
  const common = { viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': 'true', focusable: 'false' };
  if (phase === 'downloading') {
    const known = fraction != null;
    return (
      <svg {...common} className="mv-attach__ring" data-mv-progress={known ? String(Math.round(fraction * 1000) / 1000) : 'indeterminate'}>
        <circle cx="12" cy="12" r={R} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.4" />
        <circle
          cx="12" cy="12" r={R} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"
          className={known ? undefined : 'mv-attach__ring-spin'}
          strokeDasharray={`${(known ? fraction : 0.25) * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
          transform="rotate(-90 12 12)"
        />
        <rect x="9.5" y="9.5" width="5" height="5" rx="1" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' };
  if (phase === 'ready') {
    // A page with a folded corner: the file is on the device.
    return <svg {...common}><path {...stroke} d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path {...stroke} d="M14 3v5h5" /><path {...stroke} d="M9 14h6M9 17h4" /></svg>;
  }
  if (phase === 'failed') {
    // Try again.
    return <svg {...common}><path {...stroke} d="M20 12a8 8 0 1 1-2.3-5.6" /><path {...stroke} d="M20 4v5h-5" /></svg>;
  }
  // A paper clip: on the server, not on the device yet.
  return <svg {...common}><path {...stroke} d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7L9.2 17.2a1.7 1.7 0 0 1-2.4-2.4L14.5 7" /></svg>;
}

export default function AttachmentChip({ accountId, folder, uid, attachment }) {
  const t = useT();
  const { section, filename, mime, size } = attachment;
  const key = useMemo(() => ({ accountId, folder, uid, section }), [accountId, folder, uid, section]);
  // idle | downloading {received, total} | ready {notice} | failed {code}
  const [state, setState] = useState({ phase: 'idle' });
  const live = useRef(true);
  // The running job: `{ id, stop }`, or `{ id: null, cancelled }` until the fetch reply lands.
  const job = useRef(null);
  const busy = useRef(false);
  const press = useRef(null);
  const longFired = useRef(false);

  const endJob = useCallback(() => {
    const j = job.current;
    job.current = null;
    j?.stop?.();
  }, []);

  useEffect(() => {
    live.current = true;
    ensureAttachmentEvents();
    // A file fetched earlier (or whose `done` this page missed) starts ready.
    daemonCall('mobile.attachment.local', key).then(
      (r) => { if (live.current && r?.path) setState((s) => (s.phase === 'idle' ? { phase: 'ready' } : s)); },
      () => {},
    );
    return () => {
      live.current = false;
      endJob();
      clearTimeout(press.current?.timer);
    };
  }, [key, endJob]);

  const start = useCallback(async () => {
    endJob();
    const mine = { id: null, cancelled: false, stop: null };
    job.current = mine;
    setState({ phase: 'downloading', received: 0, total: size || 0 });
    let reply;
    try {
      reply = await daemonCall('mobile.attachment.fetch', key);
    } catch (err) {
      if (live.current && job.current === mine) {
        job.current = null;
        setState({ phase: 'failed', code: refusedFetchCode(err) });
      }
      return;
    }
    const id = reply?.jobId;
    if (mine.cancelled) {
      if (id != null) daemonCall('mobile.attachment.cancel', { jobId: id }).catch(() => {});
      return;
    }
    if (!live.current || job.current !== mine || id == null) return;
    mine.id = id;
    let ended = false;
    const onEvent = (kind, p) => {
      if (ended || !live.current || job.current !== mine) return;
      if (kind === 'progress') {
        setState({ phase: 'downloading', received: Number(p.received) || 0, total: Number(p.total) || size || 0 });
        return;
      }
      ended = true;
      job.current = null;
      if (kind === 'done') setState({ phase: 'ready' });
      else setState(p.code === 'CANCELLED' ? { phase: 'idle' } : { phase: 'failed', code: p.code });
      mine.stop?.();
    };
    // Events that came before this reply are replayed inside `watchJob`.
    mine.stop = watchJob(id, onEvent);
    if (ended) mine.stop();
  }, [key, size, endJob]);

  const cancel = useCallback(() => {
    const j = job.current;
    job.current = null;
    setState({ phase: 'idle' });
    if (!j) return;
    if (j.id == null) {
      j.cancelled = true;
      return;
    }
    j.stop?.();
    daemonCall('mobile.attachment.cancel', { jobId: j.id }).catch(() => {});
  }, []);

  const handOut = useCallback(async (share) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const r = await daemonCall('mobile.attachment.local', key);
      if (!live.current) return;
      if (!r?.path) {
        start();
        return;
      }
      const args = { path: r.path, name: filename || '', mime: mime || '' };
      await (share ? shareFile(args) : openFile(args));
      if (live.current) setState({ phase: 'ready' });
    } catch (err) {
      if (!live.current) return;
      const code = codeOf(err);
      if (code === 'GONE') start();
      else if (code !== 'BUSY') setState({ phase: 'ready', notice: code === 'NO_APP' ? 'NO_APP' : 'OPEN_FAILED' });
    } finally {
      busy.current = false;
    }
  }, [key, filename, mime, start]);

  const onClick = () => {
    if (longFired.current) {
      longFired.current = false;
      return;
    }
    if (state.phase === 'downloading') cancel();
    else if (state.phase === 'ready') handOut(false);
    else start();
  };

  const clearPress = () => {
    clearTimeout(press.current?.timer);
    press.current = null;
  };
  const onPointerDown = (e) => {
    longFired.current = false;
    clearPress();
    if (state.phase !== 'ready') return;
    press.current = {
      x: e.clientX,
      y: e.clientY,
      timer: setTimeout(() => {
        press.current = null;
        longFired.current = true;
        handOut(true);
      }, LONG_PRESS_MS),
    };
  };
  const onPointerMove = (e) => {
    const p = press.current;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_SLOP_PX) clearPress();
  };

  const name = displayText(filename, '') || t('mobile.viewer.attachment');
  const sizeText = formatSize(size);
  let meta = sizeText;
  let label;
  let fraction = null;
  if (state.phase === 'downloading') {
    fraction = state.total > 0 ? Math.min(1, state.received / state.total) : null;
    const percent = formatPercent(fraction ?? 0);
    meta = fraction == null ? sizeText : percent;
    label = t('mobile.attachment.labelDownloading', { name, percent });
  } else if (state.phase === 'failed') {
    meta = t(reasonKey(state.code));
    label = t('mobile.attachment.labelFailed', { name, reason: meta });
  } else if (state.phase === 'ready') {
    if (state.notice) meta = t(reasonKey(state.notice));
    label = state.notice
      ? t('mobile.attachment.labelReadyNotice', { name, reason: meta })
      : t('mobile.attachment.labelReady', { name, size: sizeText });
  } else {
    label = t('mobile.attachment.labelIdle', { name, size: sizeText });
  }
  const alert = state.phase === 'failed' || Boolean(state.notice);

  return (
    <li className="mv-viewer__chip-item">
      <button
        type="button"
        className={`mv-viewer__chip mv-viewer__chip--${state.phase}${state.notice ? ' mv-viewer__chip--notice' : ''}`}
        data-mv-attachment={section}
        data-mv-attachment-state={state.phase}
        aria-label={label}
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={clearPress}
        onPointerCancel={clearPress}
        onPointerLeave={clearPress}
        onContextMenu={(e) => e.preventDefault()}
      >
        <ChipIcon phase={state.phase} fraction={fraction} />
        <span className="mv-viewer__chip-name" dir="auto">{name}</span>
        <span className={`mv-viewer__chip-size${alert ? ' mv-viewer__chip-size--alert' : ''}`} aria-hidden="true">{meta}</span>
      </button>
      {/* The button's label changes silently; a failure is also said out loud. */}
      <span className="mv-visually-hidden" aria-live="polite">{alert ? label : ''}</span>
    </li>
  );
}
