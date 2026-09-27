import React, { useEffect, useMemo, useRef } from 'react';
import { Sun, Moon } from 'lucide-react';
import { useSettingsStore } from '../stores/settingsStore';
import { useThemeStore } from '../stores/themeStore';
import { buildEmailIframeHtml, attachEmailIframeAutoSize, emailScriptNonce } from '../utils/emailIframeTemplate';
import { getDarkReaderInlineScripts } from '../utils/darkReaderInject';
import { getEmailColors } from '../utils/mailChrome';
import { useT } from '../i18n/index.js';

// The theme the reading pane opens a message in: the email theme setting, or
// the app's own when that is "system".
export function useDefaultEmailDark() {
  const appTheme = useThemeStore(s => s.theme);
  const emailViewerTheme = useSettingsStore(s => s.emailViewerTheme);
  return (emailViewerTheme && emailViewerTheme !== 'system' ? emailViewerTheme : appTheme) === 'dark';
}

// A toggle button: one stable name ("Dark") with its pressed state, so a
// screen reader hears "Dark, pressed" rather than "Light, pressed". The
// tooltip says what a click switches to, like the reader's own theme action.
export function OriginalThemeToggle({ dark, onToggle, testid = 'compose-original-theme' }) {
  const t = useT();
  const Icon = dark ? Sun : Moon;
  return (
    <button type="button" data-testid={testid} aria-pressed={dark} aria-label={t('emailActionBar.dark')}
      title={dark ? t('emailActionBar.light') : t('emailActionBar.dark')} onClick={onToggle}
      className="rounded p-1.5 text-mail-text-muted transition-colors hover:bg-mail-surface-hover hover:text-mail-text">
      <Icon size={14} />
    </button>
  );
}

// One message body as HTML (the pop-out and the detached compose window get it
// over IPC, with no store to read a thread from). Light runs nothing: the
// sandbox has no allow-scripts. Dark needs Dark Reader, so it takes the reading
// pane's model: scripts allowed, and the frame's nonce CSP runs only ours.
export function OriginalFrame({ html, dark, padding = '12px 16px', title, className = '', autoSize = true }) {
  const frameRef = useRef(null);
  const palette = useThemeStore(s => s.palette);
  useEffect(() => (autoSize ? attachEmailIframeAutoSize(frameRef.current) : undefined), [autoSize]);
  const srcDoc = useMemo(() => {
    const nonce = emailScriptNonce();
    return buildEmailIframeHtml({
      bodyHtml: html,
      themeTag: dark ? 'dark' : 'light',
      extraHead: `${dark ? getDarkReaderInlineScripts({ palette, nonce }) : ''}<style>body { padding: ${padding}; }</style>`,
      nonce,
    });
  }, [html, dark, palette, padding]);
  return (
    <iframe
      ref={frameRef}
      sandbox={dark ? 'allow-same-origin allow-scripts' : 'allow-same-origin'}
      srcDoc={srcDoc}
      title={title}
      style={{ backgroundColor: getEmailColors(dark ? 'dark' : 'light', palette).background }}
      className={`block w-full border-0 rounded-md ${className}`}
    />
  );
}
