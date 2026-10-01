import { useEffect, useRef } from 'react';
import { attachMailFonts } from '../services/fontService';
import { isTrackerBlockingActive } from '../stores/settingsStore';

// Draws the mail frame `iframeRef` points at in the Google Fonts its mail
// chose (fontService attachMailFonts). Checked after every render rather than
// on a dependency: a frame can be remounted, or swapped for another under the
// same ref (chat bubbles), with the same srcDoc. Blocking is read when a
// document loads, so turning it on stops the next download, not a past one.
// `onFonts` runs once a document's faces are in, for a frame that sizes
// itself without watching its body.
export function useMailFonts(iframeRef, onFonts) {
  const attached = useRef(null);
  const latest = useRef(onFonts);
  latest.current = onFonts;
  useEffect(() => {
    const frame = iframeRef.current;
    if (attached.current?.frame === frame) return;
    attached.current?.detach();
    attached.current = frame ? {
      frame,
      detach: attachMailFonts(frame, {
        blocking: () => isTrackerBlockingActive(),
        onFonts: () => latest.current?.(),
      }),
    } : null;
  });
  useEffect(() => () => {
    attached.current?.detach();
    attached.current = null;
  }, []);
}
