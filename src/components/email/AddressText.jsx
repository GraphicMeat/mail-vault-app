import React, { memo, useMemo } from 'react';
import { openMailtoCompose } from '../../utils/mailto';
import { linkifyText } from '../../utils/linkify';
import { codeRuns } from '../../utils/codeText';
import { CODE_LOOK } from '../../utils/codeLook';
import { Private } from '../privacy/Private';
import { usePrivacyActive } from '../../hooks/usePrivacy';

/**
 * Plain-text body text with its email and web addresses made clickable.
 *
 * A text/plain message carries no anchors, so an address in one used to be
 * characters on a page — the only way to write back was to select it and copy
 * it out. Here each email address becomes a link that opens compose, the same
 * as a `mailto:` in an HTML body, and each web address opens in the browser,
 * the same as a link in the reader's frame.
 *
 * `inline` and ```fenced``` code in the text is shown as code (codeText), and
 * nothing inside it is linked: it is shown as it was written.
 *
 * Rendered as React children, never `dangerouslySetInnerHTML`: the text came
 * out of someone else's email, and React's own escaping is the reason none of
 * it can become markup.
 */
// `readOnly` (the compose pane's copy): an email address shows as a link but
// composes nothing; a web address still opens, which is reading.
//
// Privacy mode masks every run in place; a mailto link keeps its click but
// loses the href that spells the address.
export const AddressText = memo(function AddressText({ text, accountId, readOnly = false }) {
  const masked = usePrivacyActive();
  const runs = useMemo(() => codeRuns(text).map(run => (
    run.code ? run : { ...run, segments: linkifyText(run.text) }
  )), [text]);

  // Nothing to link and no code — hand back the string itself so the common
  // case adds no elements to the tree at all.
  if (!runs.some(run => run.code || run.segments.some(seg => seg.href))) {
    return masked ? <Private kind="text">{text ?? ''}</Private> : text ?? null;
  }
  const show = (s, kind = 'text') => (masked ? <Private kind={kind}>{s}</Private> : s);

  return runs.map((run, r) => {
    if (run.code === 'inline') return <code key={r} style={CODE_LOOK.inline}>{show(run.text)}</code>;
    if (run.code === 'block') return <pre key={r} style={{ ...CODE_LOOK.block, margin: '0.25em 0' }}>{show(run.text)}</pre>;
    return run.segments.map((seg, i) => linked(seg, `${r}.${i}`, accountId, readOnly, masked, show));
  });
});

function linked(seg, i, accountId, readOnly, masked, show) {
  const mailto = seg.href?.startsWith('mailto:');
  return seg.href ? (
    <a
      key={i}
      href={masked && mailto ? undefined : seg.href}
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
      {show(seg.text, mailto ? 'email' : 'text')}
    </a>
  ) : <React.Fragment key={i}>{show(seg.text)}</React.Fragment>;
}
