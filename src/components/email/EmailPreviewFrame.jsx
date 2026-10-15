import React, { useMemo, useRef, useState } from 'react';
import { buildEmailIframeHtml, getEmailBodyContent } from '../../utils/emailIframeTemplate';
import { frameBody } from '../../stores/netActivityStore';
import { useSettingsStore, isTrackerBlockingActive } from '../../stores/settingsStore';
import { useBodyPrivacy, usePrivacyFrameGate } from '../../hooks/useBodyPrivacy';
import { useMailFonts } from '../../hooks/useMailFonts';
import { useThemeStore } from '../../stores/themeStore';
import { useAltBodyRenderer } from './bodyRendererRegistry';

// The body both renderers draw: the mail's content, with its beacons swapped
// out when tracker blocking is active.
export function previewBody(html, trackerBlocking) {
  return frameBody(getEmailBodyContent(html), null, trackerBlocking).body;
}

// Read-only email body for the side surfaces (Cleanup preview, Time Capsule).
//
// Same document the reading pane builds — the nonce script CSP and, when
// tracker blocking is active, the body with its beacons swapped out — so
// opening a message here phones home no more than opening it in the reader.
// No key for the scan: these surfaces have no scoped `accountId-mailbox-uid`,
// and a bare uid would share the scan cache with another mailbox's verdict.
export function buildEmailPreviewHtml(html, trackerBlocking, privacy = false) {
  return buildEmailIframeHtml({ bodyHtml: previewBody(html, trackerBlocking), privacy });
}

// No `allow-scripts`: nothing runs in here at all, not even our own fold or
// Dark Reader scripts, which is stricter than the reader and fine for a preview.
export function EmailPreviewFrame({ html, title, message = null }) {
  const Alt = useAltBodyRenderer('preview');
  const palette = useThemeStore(s => s.palette);
  const [height, setHeight] = useState(400);
  const frameRef = useRef(null);
  const trackerBlocking = useSettingsStore(isTrackerBlockingActive);
  const privacyOn = usePrivacyFrameGate();
  // Memoized: every build mints a fresh nonce, so a rebuild on the height
  // re-render would reload the frame and loop on its own load event.
  // The body is computed once for both: Blitz draws it as is, the frame wraps it.
  const body = useMemo(() => previewBody(html, trackerBlocking), [html, trackerBlocking]);
  const doc = useMemo(() => buildEmailIframeHtml({ bodyHtml: body, privacy: privacyOn }), [body, privacyOn]);
  // No scripts in here, but same-origin: the parent's masking pass reaches it.
  useBodyPrivacy(frameRef, doc, { message });
  const fitHeight = (frame) => {
    try {
      const h = frame?.contentDocument?.body?.scrollHeight;
      if (h) setHeight(Math.min(h + 32, 2000));
    } catch {}
  };
  // The mail's own Google Fonts change its height after load.
  useMailFonts(frameRef, () => fitHeight(frameRef.current));

  if (Alt) {
    // Light, capped at 2000 and scrolling past it, like the frame's height cap.
    // Links stay inert, as in the script-less frame.
    return (
      <Alt
        surface="preview"
        messageKey={message?.messageId}
        bodyHtml={body}
        plainText={message?.text || ''}
        theme={{ dark: false, palette }}
        foldQuotes={false}
        privacy={privacyOn}
        message={message}
        sizing={{ collapsedMax: 2000 }}
        style={{ width: '100%' }}
      />
    );
  }
  return (
    <iframe
      ref={frameRef}
      srcDoc={doc}
      // On the element, not an effect: React binds it at creation, so a
      // srcdoc that loads before a passive effect runs can't be missed.
      onLoad={(e) => fitHeight(e.currentTarget)}
      sandbox="allow-same-origin"
      style={{ width: '100%', height, border: 'none' }}
      title={title}
    />
  );
}
