import React, { useEffect, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { buildEmailIframeHtml } from '../utils/emailIframeTemplate';
import { useThemeStore } from '../stores/themeStore';
import { useT } from '../i18n/index.js';

const token = new URLSearchParams(window.location.search).get('original');

export function OriginalMessageWindow() {
  const t = useT();
  const [html, setHtml] = useState(null);

  useEffect(() => {
    let disposed = false;
    let unlisten;
    useThemeStore.getState().initTheme();
    void listen('original-message-payload', event => {
      if (!disposed && event.payload?.token === token) setHtml(event.payload.html);
    }).then(stop => {
      if (disposed) stop();
      else {
        unlisten = stop;
        void emit('original-message-ready', { token, label: getCurrentWebviewWindow().label });
      }
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  return <main className="h-screen bg-mail-bg p-3" aria-busy={!html}>
    {html && <iframe title={t('compose.originalMessage')} sandbox="allow-same-origin"
      srcDoc={buildEmailIframeHtml({ bodyHtml: html, extraHead: '<style>body { padding: 20px 24px; }</style>' })}
      className="block h-full w-full rounded-md border border-mail-border bg-mail-surface" />}
  </main>;
}
