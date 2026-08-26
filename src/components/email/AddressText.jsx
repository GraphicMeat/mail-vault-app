import React, { memo, useMemo } from 'react';
import { splitAddresses, openMailtoCompose } from '../../utils/mailto';

/**
 * Plain-text body text with its email addresses made clickable.
 *
 * A text/plain message carries no anchors, so an address in one used to be
 * characters on a page — the only way to write back was to select it and copy
 * it out. Here each one becomes a link that opens compose, the same as a
 * `mailto:` in an HTML body.
 *
 * Rendered as React children, never `dangerouslySetInnerHTML`: the text came
 * out of someone else's email, and React's own escaping is the reason none of
 * it can become markup.
 */
export const AddressText = memo(function AddressText({ text, accountId }) {
  const segments = useMemo(() => splitAddresses(text), [text]);

  // Nothing to link — hand back the string itself so the common case adds no
  // elements to the tree at all.
  if (!segments.some(seg => seg.address)) return text ?? null;

  return segments.map((seg, i) => seg.address ? (
    <a
      key={i}
      href={`mailto:${seg.address}`}
      // Inherits the body's colour on purpose: these sit on the message
      // surface, which is white or near-black depending on the email theme,
      // and no fixed link colour reads well on both. The underline is the
      // affordance.
      className="underline underline-offset-2 cursor-pointer hover:opacity-70"
      onClick={(e) => {
        // Left alone this navigates the whole webview to the OS mail client.
        e.preventDefault();
        // The chat bubble and the thread row both have their own click.
        e.stopPropagation();
        openMailtoCompose(`mailto:${seg.address}`, accountId);
      }}
    >
      {seg.text}
    </a>
  ) : seg.text);
});
