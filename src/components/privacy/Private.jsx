import React from 'react';
import { usePrivateSegments } from '../../hooks/usePrivacy';
import { usePrivacyStore } from '../../stores/privacyStore';
import { captureMaskIndex } from '../../utils/privacy/captureMasks';

/**
 * A rendered value that privacy mode may mask. The mask is filler text, not a
 * blur over the real text: what the screen, a DOM clone or a screen reader
 * gets is "xxxx", so nothing de-blurs back into a name.
 *
 * While a social capture carries word marks, each masked run names its original
 * through the capture's mask table (`data-mv-i`, an index, never the text): the
 * hit map's way back from a masked word to the word.
 */
export function Private({ kind = 'text', children }) {
  // toArray drops null/false and flattens, so `{a}{' '}{b}` joins as one string.
  const value = React.Children.toArray(children).join('');
  const segments = usePrivateSegments(value, kind);
  const capturing = usePrivacyStore(s => !!s.captureMarks);
  if (!segments) return value;
  return segments.map((seg, i) => (seg.masked
    ? <span key={i} className="mv-private" aria-hidden="true" {...(capturing && seg.original != null ? { 'data-mv-i': captureMaskIndex(seg.original) } : {})}>{seg.text}</span>
    : <React.Fragment key={i}>{seg.text}</React.Fragment>));
}
