import React, { useEffect, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useThemeStore } from '../stores/themeStore';
import { OriginalFrame, OriginalThemeToggle, useDefaultEmailDark } from './OriginalFrame';
import { useT } from '../i18n/index.js';
import { startPrivacySync } from '../utils/privacy/privacySync';
import { usePrivacySourceBlocked } from '../hooks/usePrivacy';
import { SourceBlocked } from './privacy/SourceBlocked';
import { Private } from './privacy/Private';
import { usePrivacyStore, isPrivacyMasking } from '../stores/privacyStore';

const token = new URLSearchParams(window.location.search).get('original');

export function OriginalMessageWindow() {
  const t = useT();
  const [html, setHtml] = useState(null);
  // Set by the Blitz pop-out only: the subject and the seat the body draws in.
  const [title, setTitle] = useState(null);
  const [surface, setSurface] = useState('original');
  // Opens in the theme the compose pane was showing; the toggle is this
  // window's own.
  const defaultDark = useDefaultEmailDark();
  const [darkOverride, setDarkOverride] = useState(null);
  const dark = darkOverride ?? defaultDark;
  const blocked = usePrivacySourceBlocked();

  // Mask changes made in the main window reach this webview.
  useEffect(() => startPrivacySync(), []);

  useEffect(() => {
    let disposed = false;
    let unlisten;
    useThemeStore.getState().initTheme();
    void listen('original-message-payload', event => {
      if (disposed || event.payload?.token !== token) return;
      setHtml(event.payload.html);
      if (typeof event.payload.dark === 'boolean') setDarkOverride(event.payload.dark);
      const subject = typeof event.payload.title === 'string' && event.payload.title ? event.payload.title : null;
      const popout = event.payload.surface === 'popout';
      setTitle(subject);
      setSurface(popout ? 'popout' : 'original');
      // The pop-out keeps the subject as its native title. A masked subject
      // would leak through the title bar, so it is set only while privacy mode
      // is off (the in-window heading masks itself). The check also covers a
      // mode switched on between the click and this payload.
      if (subject && popout && !isPrivacyMasking(usePrivacyStore.getState())) {
        void Promise.resolve(getCurrentWebviewWindow().setTitle(subject)).catch(() => {});
      }
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
    {blocked ? <SourceBlocked /> : html && <>
      <div className="flex shrink-0 items-center justify-end gap-2">
        {surface === 'popout' && title && <h1 className="mr-auto min-w-0 truncate text-sm font-semibold text-mail-text"><Private kind="text">{title}</Private></h1>}
        <OriginalThemeToggle dark={dark} onToggle={() => setDarkOverride(!dark)} testid="original-window-theme" />
      </div>
      <OriginalFrame html={html} dark={dark} autoSize={false} padding={surface === 'popout' ? null : '20px 24px'} surface={surface} title={t('compose.originalMessage')}
        className="min-h-0 flex-1 border border-mail-border" />
    </>}
  </main>;
}
