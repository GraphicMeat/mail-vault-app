import React, { memo, useMemo } from 'react';
import { openMailtoCompose } from '../../utils/mailto';
import { linkifyText } from '../../utils/linkify';

/**
 * Plain-text body text with its email and web addresses made clickable.
 *
 * A text/plain message carries no anchors, so an address in one used to be
 * characters on a page — the only way to write back was to select it and copy
 * it out. Here each email address becomes a link that opens compose, the same
 * as a `mailto:` in an HTML body, and each web address opens in the browser,
 * the same as a link in the reader's frame.
 *
 * Rendered as React children, never `dangerouslySetInnerHTML`: the text came
 * out of someone else's email, and React's own escaping is the reason none of
 * it can become markup.
 */
// `readOnly` (the compose pane's copy): an email address shows as a link but
// composes nothing; a web address still opens, which is reading.
export const AddressText = memo(function AddressText({ text, accountId, readOnly = false }) {
  const segments = useMemo(() => linkifyText(text), [text]);

  // Nothing to link — hand back the string itself so the common case adds no
  // elements to the tree at all.
  if (!segments.some(seg => seg.href)) return text ?? null;

  return segments.map((seg, i) => seg.href ? (
    <a
      key={i}
      href={seg.href}
      // Inherits the body's colour on purpose: these sit on the message
      // surface, which is white or near-black depending on the email theme,
      // and no fixed link colour reads well on both. The underline is the
      // affordance.
      className="underline underline-offset-2 cursor-pointer hover:opacity-70"
      onClick={(e) => {
        // Left alone this navigates the whole webview away from the app.
        e.preventDefault();
        // The chat bubble and the thread row both have their own click.
        e.stopPropagation();
        if (seg.href.startsWith('mailto:')) {
          if (!readOnly) openMailtoCompose(seg.href, accountId);
          return;
        }
        // The text is the address itself, so there is no mismatch for link
        // safety to warn about; open it the way the reader's frame does.
        import('@tauri-apps/plugin-shell').then(({ open }) => open(seg.href))
          .catch(() => window.open(seg.href, '_blank'));
      }}
    >
      {seg.text}
    </a>
  ) : seg.text);
});
