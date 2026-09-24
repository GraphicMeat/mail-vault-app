import React, { useMemo, useState } from 'react';
import { buildEmailIframeHtml, getEmailBodyContent } from '../../utils/emailIframeTemplate';
import { scanTrackers } from '../../utils/trackerDetect';
import { useSettingsStore, isTrackerBlockingActive } from '../../stores/settingsStore';

// Read-only email body for the side surfaces (Cleanup preview, Time Capsule).
//
// Same document the reading pane builds — the nonce script CSP and, when
// tracker blocking is active, the body with its beacons swapped out — so
// opening a message here phones home no more than opening it in the reader.
// No key for the scan: these surfaces have no scoped `accountId-mailbox-uid`,
// and a bare uid would share the scan cache with another mailbox's verdict.
export function buildEmailPreviewHtml(html, trackerBlocking) {
  const body = getEmailBodyContent(html);
  return buildEmailIframeHtml({
    bodyHtml: trackerBlocking ? scanTrackers(body, null).cleanedBodyHtml : body,
  });
}

// No `allow-scripts`: nothing runs in here at all, not even our own fold or
// Dark Reader scripts, which is stricter than the reader and fine for a preview.
export function EmailPreviewFrame({ html, title }) {
  const [height, setHeight] = useState(400);
  const trackerBlocking = useSettingsStore(isTrackerBlockingActive);
  // Memoized: every build mints a fresh nonce, so a rebuild on the height
  // re-render would reload the frame and loop on its own load event.
  const doc = useMemo(() => buildEmailPreviewHtml(html, trackerBlocking), [html, trackerBlocking]);

  return (
    <iframe
      srcDoc={doc}
      // On the element, not an effect: React binds it at creation, so a
      // srcdoc that loads before a passive effect runs can't be missed.
      onLoad={(e) => {
        try {
          const h = e.currentTarget.contentDocument?.body?.scrollHeight;
          if (h) setHeight(Math.min(h + 32, 2000));
        } catch {}
      }}
      sandbox="allow-same-origin"
      style={{ width: '100%', height, border: 'none' }}
      title={title}
    />
  );
}
