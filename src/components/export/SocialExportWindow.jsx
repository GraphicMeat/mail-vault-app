import React, { useEffect, useMemo, useRef, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { SocialExportPanel } from './SocialExportPanel';
import { useSettingsStore } from '../../stores/settingsStore';
import { useThemeStore } from '../../stores/themeStore';
import { composeSocialFile } from '../../services/export/social/buildSocialExport';
import { startPrivacySync } from '../../utils/privacy/privacySync';
import { useT } from '../../i18n/index.js';

const token = new URLSearchParams(window.location.search).get('social');
// A long card mirrors its remote images before it renders: no short timeout.
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
 * The Social export panel in a window of its own (useSocialExportWindow is
 * the main window's half). It renders nothing itself: content comes from the
 * main window per choice, already redacted there, and is composed and saved
 * here so the preview can be as big as the window. "Back to app" hands the
 * per-open choices back to the export dialog.
 */
export function SocialExportWindow() {
  const t = useT();
  const [initial, setInitial] = useState(null);
  const [error, setError] = useState('');
  const pending = useRef(new Map());
  const names = useRef(new WeakMap()); // content bitmap -> the file name main offered

  useEffect(() => startPrivacySync(), []);

  useEffect(() => {
    let disposed = false;
    let stops = [];
    const boot = async () => {
      stops.push(await listen('social-window-reply', ({ payload }) => {
        if (payload?.token !== token) return;
        const item = pending.current.get(payload.requestId);
        if (!item) return;
        pending.current.delete(payload.requestId);
        clearTimeout(item.timeout);
        if (payload.ok) item.resolve(payload);
        else item.reject(Object.assign(new Error(payload.error || 'render failed'), { code: payload.error }));
      }));
      stops.push(await listen('social-window-payload', async ({ payload }) => {
        if (disposed || payload?.token !== token) return;
        await Promise.all([hydrated(useSettingsStore), hydrated(useThemeStore)]);
        if (disposed) return;
        // Writes are off in a child window (safeStorage): these stay in memory.
        useSettingsStore.setState(payload.settings);
        useThemeStore.setState(payload.theme);
        useThemeStore.getState().initTheme();
        setInitial(payload.initial || {});
      }));
      if (!disposed) await emit('social-window-ready', { token, label: getCurrentWebviewWindow().label });
    };
    void boot().catch(cause => setError(cause?.message || String(cause)));
    return () => {
      disposed = true;
      stops.forEach(stop => stop());
      pending.current.forEach(({ reject, timeout }) => { clearTimeout(timeout); reject(new Error('closed')); });
      pending.current.clear();
    };
  }, []);

  const source = useMemo(() => ({
    buildContent: (options) => new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timeout = setTimeout(() => {
        pending.current.delete(requestId);
        reject(new Error('timed out'));
      }, REQUEST_TIMEOUT_MS);
      pending.current.set(requestId, { resolve, reject, timeout });
      void emit('social-window-request', { token, requestId, options }).catch(reject);
    }).then(async ({ base64, name }) => {
      const bitmap = await decodePng(base64);
      names.current.set(bitmap, name);
      return bitmap;
    }),
    save: (options, content) => composeSocialFile({ content, options, name: names.current.get(content) || 'MailVault - social.png' }),
  }), []);

  if (error) return <p role="alert" className="p-4 text-mail-danger">{error}</p>;
  if (!initial) return <div className="h-screen bg-mail-bg" aria-busy="true" />;
  const close = () => { void getCurrentWebviewWindow().destroy(); };
  return (
    <main className="h-screen flex flex-col gap-4 p-5 bg-mail-surface text-mail-text">
      <h1 className="sr-only">{t('export.social.formatLabel')}</h1>
      <SocialExportPanel detached source={source} initial={initial} onDone={close}
        onPrefsChange={patch => { void emit('social-window-prefs', { token, patch }); }}
        onPopIn={choices => { void emit('social-window-dock', { token, initial: choices }); }} />
    </main>
  );
}
