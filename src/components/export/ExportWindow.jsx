import React, { useEffect, useMemo, useRef, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { ExportFilesPanel } from './ExportFilesPanel';
import { ExportFormatTabs } from './ExportFormatTabs';
import { SocialExportPanel } from './SocialExportPanel';
import { useExportOptions } from './useExportOptions';
import { useSettingsStore } from '../../stores/settingsStore';
import { useThemeStore } from '../../stores/themeStore';
import { usePrivacyStore } from '../../stores/privacyStore';
import { composeSocialFile } from '../../services/export/social/buildSocialExport';
import { startPrivacySync } from '../../utils/privacy/privacySync';
import { useT } from '../../i18n/index.js';

const token = new URLSearchParams(window.location.search).get('export');
// A long thread mirrors its remote images before it renders: no short timeout.
const REQUEST_TIMEOUT_MS = 120_000;

const hydrated = store => store.persist?.hasHydrated?.() ? Promise.resolve() : new Promise(resolve => {
  const stop = store.persist?.onFinishHydration?.(() => { stop?.(); resolve(); });
  if (!stop) resolve();
});

// The PNG the main window rendered, as a bitmap to compose from. No blob: URL
// (the app's CSP admits none): createImageBitmap reads the bytes directly.
async function decodePng(base64) {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
}

/**
 * The export in a window of its own (useExportWindow is the main window's
 * half): Image, HTML or Social, switched by tab. The panels are the dialog's;
 * what they show comes from the main window, already redacted there (files,
 * or the Social PNG, composed and saved here so the preview can be as big as
 * the window). "Back to app" hands the choices back to the export dialog.
 */
export function ExportWindow() {
  const [boot, setBoot] = useState(null); // { initial, messages }
  const [error, setError] = useState('');
  const pending = useRef(new Map());
  const names = useRef(new WeakMap()); // Social content bitmap -> the file name main offered

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
        await Promise.all([hydrated(useSettingsStore), hydrated(useThemeStore)]);
        if (disposed) return;
        // Writes are off in a child window (safeStorage): these stay in memory.
        if (payload.settings) useSettingsStore.setState(payload.settings);
        useThemeStore.setState(payload.theme);
        useThemeStore.getState().initTheme();
        setBoot({ initial: payload.initial || {}, messages: payload.messages || [], socialDefaults: payload.socialDefaults });
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

  const request = useMemo(() => (options) => new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      pending.current.delete(requestId);
      reject(new Error('timed out'));
    }, REQUEST_TIMEOUT_MS);
    pending.current.set(requestId, { resolve, reject, timeout });
    void emit('export-window-request', { token, requestId, options }).catch(reject);
  }), []);

  const build = useMemo(() => ({ format, layout, mirror, attachments, redact, width }) => request({
    format, layout, mirror, attachments, redact, ...(width ? { width } : {}),
  }), [request]);

  const social = useMemo(() => ({
    buildContent: options => request({ ...options, format: 'social' }).then(async ({ base64, name }) => {
      const bitmap = await decodePng(base64);
      names.current.set(bitmap, name);
      return bitmap;
    }),
    save: (options, content) => composeSocialFile({ content, options, name: names.current.get(content) || 'MailVault - social.png' }),
  }), [request]);

  if (error) return <p role="alert" className="p-4 text-mail-danger">{error}</p>;
  if (!boot) return <div className="h-screen bg-mail-bg" aria-busy="true" />;
  return <Loaded boot={boot} build={build} social={social} />;
}

function Loaded({ boot, build, social }) {
  const t = useT();
  const { initial, messages, socialDefaults } = boot;
  const isThread = messages.length > 1;
  // `initial` is { format, files, social? }: each panel's choices under its own name.
  const [format, setFormat] = useState(initial.format === 'social' && isThread ? 'image' : initial.format || 'image');
  const opts = useExportOptions(initial.files);
  // The pop-out's style seeds Social once. After that the window's own settings,
  // kept current below, are the truth: a seed read again would undo a change made here.
  const socialSeed = useRef(initial.social);
  const pick = next => {
    if (format === 'social' && socialSeed.current?.prefs) socialSeed.current = { ...socialSeed.current, prefs: undefined };
    setFormat(next);
  };
  const dock = choices => { void emit('export-window-dock', { token, initial: choices }); };
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
      <ExportFormatTabs value={format} onChange={pick} socialDisabled={isThread} />
      {format === 'social' ? (
        <SocialExportPanel detached source={social} initial={{ revealSender: socialDefaults?.revealSender ?? false, ...socialSeed.current }}
          onDone={close} headerSlot={popInSlot}
          onPrefsChange={patch => {
            useSettingsStore.getState().setSocialExport(patch);
            void emit('export-window-prefs', { token, patch });
          }}
          onPopIn={choices => dock({ format: 'social', files: opts.choices('image'), social: choices })} />
      ) : (
        <ExportFilesPanel detached opts={opts} format={format} messages={messages}
          build={build} onDone={close} headerSlot={popInSlot}
          onPopIn={choices => dock({ format, files: choices })} />
      )}
    </main>
  );
}
