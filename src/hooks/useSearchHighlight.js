import { useEffect } from 'react';
import { useSearchStore } from '../stores/searchStore';
import { applySearchHighlight, highlightTerms } from '../utils/iframeSearchHighlight';
import { PRIVACY_RELEASED_EVENT } from '../utils/iframePrivacyRedact';

/**
 * Paint the open search's terms into a message-body iframe.
 *
 * Deliberately NOT part of the srcDoc: that string is memoized behind the
 * tracker and link scans, so folding the query into it would rebuild and
 * reload the frame on every keystroke. This runs against the live document
 * instead — same access the link interception already uses.
 *
 * `contentKey` is whatever identifies the body currently in the frame; passing
 * the srcDoc re-paints when the reader moves to another message, and the load
 * listener covers the frame swapping its document underneath.
 */
export function useSearchHighlight(iframeRef, contentKey) {
  const query = useSearchStore(s => (s.searchActive ? s.searchQuery : ''));

  useEffect(() => {
    const iframe = iframeRef?.current;
    if (!iframe) return undefined;
    const terms = highlightTerms(query);
    const paint = () => {
      try {
        applySearchHighlight(iframe.contentDocument || iframe.contentWindow?.document, terms);
      } catch { /* the frame is detached, or its document is not ours to read */ }
    };
    // Once now (the document may already be loaded), again on every load, and
    // when privacy mode reveals a frame it held back (nothing paints under its gate).
    paint();
    iframe.addEventListener('load', paint);
    iframe.addEventListener(PRIVACY_RELEASED_EVENT, paint);
    return () => {
      iframe.removeEventListener('load', paint);
      iframe.removeEventListener(PRIVACY_RELEASED_EVENT, paint);
    };
  }, [iframeRef, query, contentKey]);
}
