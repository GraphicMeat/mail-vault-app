import React, { useEffect, useMemo, useRef } from 'react';
import { Sun, Moon } from 'lucide-react';
import { useSettingsStore, isTrackerBlockingActive } from '../stores/settingsStore';
import { useThemeStore, selectTheme } from '../stores/themeStore';
import { buildEmailIframeHtml, attachEmailIframeAutoSize, emailScriptNonce } from '../utils/emailIframeTemplate';
import { useBodyScan, UNSCANNED_HEAD } from '../services/bodyScan';
import { getDarkReaderInlineScripts } from '../utils/darkReaderInject';
import { getEmailColors } from '../utils/mailChrome';
import { useBodyPrivacy, usePrivacyFrameGate } from '../hooks/useBodyPrivacy';
import { useT } from '../i18n/index.js';
import { useMailFonts } from '../hooks/useMailFonts';
import { useAltBodyRenderer } from './email/bodyRendererRegistry';

// The theme the reading pane opens a message in: the email theme setting, or
// the app's own when that is "system".
export function useDefaultEmailDark() {
  const appTheme = useThemeStore(selectTheme);
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

// The document an original draws: the frame's whole srcdoc, privacy gate
// included. Blitz draws exactly this (its pre-pass releases the gate when
// privacy is inactive). `padding` null means no override: the template's own
// 24px applies (the pop-out window). `html` is the scanned body
// (services/bodyScan); `unscanned` refuses remote images when the daemon could
// not scan it.
export function buildOriginalFrameHtml({ html, dark, palette, padding, privacy, nonce = emailScriptNonce(), unscanned = false }) {
  // Kept out of the extraHead template: the i18n audit cannot see a template
  // literal nested inside another one and would report "body" as JSX text.
  const paddingCss = padding ? `<style>body { padding: ${padding}; }</style>` : '';
  return buildEmailIframeHtml({
    bodyHtml: html,
    themeTag: dark ? 'dark' : 'light',
    extraHead: `${unscanned ? UNSCANNED_HEAD : ''}${dark ? getDarkReaderInlineScripts({ palette, nonce }) : ''}${paddingCss}`,
    nonce,
    privacy,
  });
}

// One message body as HTML (the pop-out and the detached compose window get it
// over IPC, with no store to read a thread from). Light runs nothing: the
// sandbox has no allow-scripts. Dark needs Dark Reader, so it takes the reading
// pane's model: scripts allowed, and the frame's nonce CSP runs only ours.
// `surface` names the seat for the alternative renderer ('original' | 'popout').
export function OriginalFrame({ html, dark, padding = '12px 16px', title, className = '', autoSize = true, message = null, surface = 'original' }) {
  const Alt = useAltBodyRenderer(surface);
  const frameRef = useRef(null);
  const palette = useThemeStore(s => s.palette);
  // Same gate the reading pane uses (EmailViewer/ChatBubbleView/
  // EmailPreviewFrame): a quoted or popped-out original must not phone home
  // any more than opening the same message in the reader would. Reading the
  // store directly (rather than a prop) also covers the detached pop-out
  // window for free: it hydrates the same persisted settings file, same as
  // `useDefaultEmailDark` already does for the theme.
  const trackerBlocking = useSettingsStore(isTrackerBlockingActive);
  // The compose pane's quoted original is a reader too, often in a detached
  // window (the gate holds there until the persisted choice is read).
  const privacyOn = usePrivacyFrameGate();
  // !!Alt: switching the renderer swaps the iframe in or out, and a fresh iframe needs its auto-size.
  useEffect(() => (autoSize && frameRef.current ? attachEmailIframeAutoSize(frameRef.current) : undefined), [autoSize, !!Alt]);
  useMailFonts(frameRef);
  // Nothing is drawn until the daemon's scan is in (no key: an original has
  // no scoped message key here).
  const scan = useBodyScan(html, { blocking: trackerBlocking });
  const srcDoc = useMemo(
    () => (scan ? buildOriginalFrameHtml({ html: scan.html, dark, palette, padding, privacy: privacyOn, unscanned: !scan.scanned }) : ''),
    [scan, dark, palette, padding, privacyOn],
  );
  useBodyPrivacy(frameRef, srcDoc, { message });
  if (Alt) {
    // The alternative renderer fetches images itself: it only ever gets a scanned body.
    if (!scan?.scanned) return null;
    return (
      <Alt
        surface={surface}
        messageKey={message?.messageId}
        documentHtml={srcDoc}
        theme={{ dark, palette }}
        foldQuotes={false}
        privacy={privacyOn}
        message={message}
        sizing={autoSize ? 'content' : 'fill'}
        className={`block w-full rounded-md ${className}`}
        style={{ backgroundColor: getEmailColors(dark ? 'dark' : 'light', palette).background }}
      />
    );
  }
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
