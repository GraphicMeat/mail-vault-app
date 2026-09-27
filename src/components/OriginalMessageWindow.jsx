import React, { useEffect, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useThemeStore } from '../stores/themeStore';
import { OriginalFrame, OriginalThemeToggle, useDefaultEmailDark } from './OriginalFrame';
import { useT } from '../i18n/index.js';

const token = new URLSearchParams(window.location.search).get('original');

export function OriginalMessageWindow() {
  const t = useT();
  const [html, setHtml] = useState(null);
  // Opens in the theme the compose pane was showing; the toggle is this
  // window's own.
  const defaultDark = useDefaultEmailDark();
  const [darkOverride, setDarkOverride] = useState(null);
  const dark = darkOverride ?? defaultDark;

  useEffect(() => {
    let disposed = false;
    let unlisten;
    useThemeStore.getState().initTheme();
    void listen('original-message-payload', event => {
      if (disposed || event.payload?.token !== token) return;
      setHtml(event.payload.html);
      if (typeof event.payload.dark === 'boolean') setDarkOverride(event.payload.dark);
    }).then(stop => {
      if (disposed) stop();
      else {
        unlisten = stop;
        void emit('original-message-ready', { token, label: getCurrentWebviewWindow().label });
      }
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  return <main className="flex h-screen flex-col gap-2 bg-mail-bg p-3" aria-busy={!html}>
    {html && <>
      <div className="flex shrink-0 justify-end">
        <OriginalThemeToggle dark={dark} onToggle={() => setDarkOverride(!dark)} testid="original-window-theme" />
      </div>
      <OriginalFrame html={html} dark={dark} autoSize={false} padding="20px 24px" title={t('compose.originalMessage')}
        className="min-h-0 flex-1 border border-mail-border" />
    </>}
  </main>;
}
