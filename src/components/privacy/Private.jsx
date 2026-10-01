import React from 'react';
import { usePrivateSegments } from '../../hooks/usePrivacy';

/**
 * A rendered value that privacy mode may mask. The mask is filler text, not a
 * blur over the real text: what the screen, a DOM clone or a screen reader
 * gets is "xxxx", so nothing de-blurs back into a name.
 */
export function Private({ kind = 'text', children }) {
  // toArray drops null/false and flattens, so `{a}{' '}{b}` joins as one string.
  const value = React.Children.toArray(children).join('');
  const segments = usePrivateSegments(value, kind);
  if (!segments) return value;
  return segments.map((seg, i) => (seg.masked
    ? <span key={i} className="mv-private" aria-hidden="true">{seg.text}</span>
    : <React.Fragment key={i}>{seg.text}</React.Fragment>));
}
