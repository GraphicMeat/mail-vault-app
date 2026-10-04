import React, { useEffect, useRef, useState } from 'react';
import { Loader } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import { buildExport } from '../../services/export/exportService';
import { ensurePrivacyDictionary } from '../../utils/privacy/privacyDictionary';

// Options settle before a build: a dragged slider is one build, not twenty.
const PREVIEW_SETTLE_MS = 300;
// Built previews kept per option set. A long thread's PNG pages are large.
const PREVIEW_CACHE_MAX = 4;

const remember = (map, key, value) => {
  map.delete(key);
  map.set(key, value);
  while (map.size > PREVIEW_CACHE_MAX) map.delete(map.keys().next().value);
};

// The message set by identity, not by array: the same messages handed over in
// a new array are the same preview.
const messagesKey = (messages) => messages
  .map(m => [m.accountId ?? m._accountId ?? '', m._mailbox ?? m.mailbox ?? '', m.uid ?? '', m.messageId ?? ''].join(':'))
  .join('|');

const decodeUtf8 = (base64) => new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0)));

// The files as the preview shows them: PNG pages as data: URLs, the HTML file
// as its text (decoded here, so a bad file is a failed build, not a crash).
function toShown(format, files) {
  if (format === 'html') return { html: decodeUtf8(files[0].base64) };
  return { images: files.map(f => `data:image/png;base64,${f.base64}`) };
}

/**
 * The PNG/HTML preview of the export dialog: buildExport over the current
 * options without attachments, debounced, one build at a time with the latest
 * options winning (a build finishing for older options is cached, never shown).
 * Previews are cached per option set and dropped on close or a different
 * message set. A redacted request never leaves an unredacted preview painted:
 * the check is made at render, not only when the options change.
 */
export function useExportPreview({ enabled, messages, format, layout, mirror, redact, redactStyle, width, account, mailbox }) {
  const ids = messagesKey(messages);
  const style = format === 'html' ? 'bar' : redactStyle;
  const key = enabled
    ? JSON.stringify([ids, format, layout, mirror, !!redact, redact ? style : '', format === 'image' ? width : '', account ?? '', mailbox ?? ''])
    : null;
  const [shown, setShown] = useState(null); // { key, redacted, html | images }
  const [failedKey, setFailedKey] = useState(null);
  const cache = useRef(new Map());
  const epoch = useRef(0);
  const latest = useRef(null);
  const flight = useRef({ running: false, next: null });

  // Closed, or other messages: nothing built before applies, in flight included.
  useEffect(() => {
    epoch.current += 1;
    cache.current = new Map();
    flight.current.next = null;
    setShown(null);
    setFailedKey(null);
  }, [ids, enabled]);

  const start = (req) => {
    flight.current.running = true;
    const run = async () => {
      // Not captureMask, as in the export itself: the live UI stays unmasked.
      const redactOpts = req.redact ? { style: req.style, dict: await ensurePrivacyDictionary() } : null;
      const result = await buildExport({
        messages: req.messages, format: req.format, layout: req.layout, mirror: req.mirror,
        account: req.account, mailbox: req.mailbox, attachments: false, redact: redactOpts,
        ...(req.format === 'image' ? { width: req.width } : {}),
      });
      if (!result?.ok || !result.files?.length) throw new Error(result?.reason || 'empty');
      return { key: req.key, redacted: req.redact, ...toShown(req.format, result.files) };
    };
    run()
      .then((entry) => {
        if (req.epoch !== epoch.current) return;
        remember(cache.current, req.key, entry);
        if (latest.current === req.key) { setShown(entry); setFailedKey(null); }
      })
      .catch(() => {
        if (req.epoch !== epoch.current || latest.current !== req.key) return;
        setShown(null);
        setFailedKey(req.key);
      })
      .finally(() => {
        flight.current.running = false;
        const next = flight.current.next;
        flight.current.next = null;
        if (next && next.epoch === epoch.current && next.key === latest.current && !cache.current.has(next.key)) start(next);
      });
  };

  useEffect(() => {
    latest.current = key;
    if (!key) return undefined;
    const hit = cache.current.get(key);
    if (hit) {
      remember(cache.current, key, hit);
      setShown(hit);
      setFailedKey(null);
      return undefined;
    }
    // Redaction on: the unredacted preview goes now, not when the new one lands.
    if (redact) setShown(s => (s && !s.redacted ? null : s));
    const req = { key, epoch: epoch.current, messages, format, layout, mirror, redact: !!redact, style, width, account, mailbox };
    const timer = setTimeout(() => {
      if (flight.current.running) flight.current.next = req;
      else start(req);
    }, PREVIEW_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [key]);

  const visible = shown && (!redact || shown.redacted) ? shown : null;
  return {
    shown: visible,
    failed: !!key && failedKey === key,
    pending: !!key && shown?.key !== key && failedKey !== key,
  };
}

/** The preview box: PNG pages stacked to the box's width, or the HTML file in a script-less frame. */
export function ExportPreview({ preview }) {
  const t = useT();
  const { shown, failed, pending } = preview;
  return (
    <div className="relative min-w-0">
      <div aria-busy={pending} className="flex flex-col gap-2 overflow-auto rounded-xl bg-mail-bg border border-mail-border p-2 h-[436px]">
        {shown?.html != null && (
          <iframe sandbox="" srcDoc={shown.html} title={t('export.social.preview')}
            className="w-full flex-1 min-h-0 rounded-md border-0 bg-white" />
        )}
        {shown?.images?.map((src, i) => (
          <img key={i} src={src} alt={t('export.social.preview')} className="block w-full h-auto shrink-0 rounded-md" />
        ))}
        {!shown && failed && (
          <p className="m-auto px-4 text-center text-xs text-mail-text-muted">{t('export.dialog.previewUnavailable')}</p>
        )}
        {!shown && !failed && <Loader size={18} className="m-auto animate-spin text-mail-text-muted" />}
      </div>
      {shown && pending && (
        <Loader size={14} aria-hidden="true" className="absolute top-3 right-3 animate-spin text-mail-text-muted" />
      )}
    </div>
  );
}
