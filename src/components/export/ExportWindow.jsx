import React, { useEffect, useMemo, useRef, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { ExportFilesPanel } from './ExportFilesPanel';
import { useExportOptions } from './useExportOptions';
import { useThemeStore } from '../../stores/themeStore';
import { usePrivacyStore } from '../../stores/privacyStore';
import { startPrivacySync } from '../../utils/privacy/privacySync';
import { useT } from '../../i18n/index.js';

const token = new URLSearchParams(window.location.search).get('export');
// A long thread mirrors its remote images before it renders: no short timeout.
const REQUEST_TIMEOUT_MS = 120_000;

const hydrated = store => store.persist?.hasHydrated?.() ? Promise.resolve() : new Promise(resolve => {
  const stop = store.persist?.onFinishHydration?.(() => { stop?.(); resolve(); });
  if (!stop) resolve();
});

/**
 * The Image and HTML export in a window of its own (useExportWindow is the
 * main window's half). The panel is the dialog's; its files come from the main
 * window, already redacted there, and are saved here. "Back to app" hands the
 * choices back to the export dialog.
 */
export function ExportWindow() {
  const [boot, setBoot] = useState(null); // { initial, messages }
  const [error, setError] = useState('');
  const pending = useRef(new Map());

  useEffect(() => startPrivacySync(), []);

  useEffect(() => {
    let disposed = false;
    let stops = [];
    const start = async () => {
      stops.push(await listen('export-window-reply', ({ payload }) => {
        if (payload?.token !== token) return;
        const item = pending.current.get(payload.requestId);
        if (!item) return;
        pending.current.delete(payload.requestId);
        clearTimeout(item.timeout);
        if (payload.ok) item.resolve(payload.result);
        else item.reject(Object.assign(new Error(payload.error || 'render failed'), { code: payload.error }));
      }));
      stops.push(await listen('export-window-payload', async ({ payload }) => {
        if (disposed || payload?.token !== token) return;
        await hydrated(useThemeStore);
        if (disposed) return;
        // Writes are off in a child window (safeStorage): this stays in memory.
        useThemeStore.setState(payload.theme);
        useThemeStore.getState().initTheme();
        setBoot({ initial: payload.initial || {}, messages: payload.messages || [] });
      }));
      if (!disposed) await emit('export-window-ready', { token, label: getCurrentWebviewWindow().label });
    };
    void start().catch(cause => setError(cause?.message || String(cause)));
    return () => {
      disposed = true;
      stops.forEach(stop => stop());
      pending.current.forEach(({ reject, timeout }) => { clearTimeout(timeout); reject(new Error('closed')); });
      pending.current.clear();
    };
  }, []);

  const build = useMemo(() => ({ format, layout, mirror, attachments, redact, width }) => new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      pending.current.delete(requestId);
      reject(new Error('timed out'));
    }, REQUEST_TIMEOUT_MS);
    pending.current.set(requestId, { resolve, reject, timeout });
    void emit('export-window-request', {
      token, requestId, options: { format, layout, mirror, attachments, redact, ...(width ? { width } : {}) },
    }).catch(reject);
  }), []);

  if (error) return <p role="alert" className="p-4 text-mail-danger">{error}</p>;
  if (!boot) return <div className="h-screen bg-mail-bg" aria-busy="true" />;
  return <Loaded boot={boot} build={build} />;
}

function Loaded({ boot, build }) {
  const t = useT();
  const { initial, messages } = boot;
  const opts = useExportOptions(initial);
  const [popInSlot, setPopInSlot] = useState(null);
  const privacyOn = usePrivacyStore(s => s.enabled);
  // Turned on mid-window: the export follows, as it does in the dialog.
  useEffect(() => {
    if (privacyOn) opts.turnRedact(true);
  }, [privacyOn]);
  const close = () => { void getCurrentWebviewWindow().destroy(); };
  return (
    <main className="h-screen flex flex-col gap-4 p-5 bg-mail-surface text-mail-text">
      <header className="flex items-center justify-between gap-3 shrink-0">
        <h1 className="text-lg font-semibold text-mail-text">
          {messages.length > 1 ? t('export.dialog.exportMessagesTitle', { count: messages.length }) : t('export.dialog.exportMessageTitle')}
        </h1>
        <div ref={setPopInSlot} className="flex items-center gap-1" />
      </header>
      <ExportFilesPanel detached opts={opts} format={initial.format || 'image'} messages={messages}
        build={build} onDone={close} headerSlot={popInSlot}
        onPopIn={choices => { void emit('export-window-dock', { token, initial: choices }); }} />
    </main>
  );
}
