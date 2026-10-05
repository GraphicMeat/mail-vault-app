import { useState } from 'react';
import { EMAIL_WIDTH } from '../../services/export/social/socialLayout';

/**
 * What the Image and HTML export has been told, in one place so the dialog
 * keeps it across a close and an export window can start from it. `initial`
 * is a `choices()` snapshot handed back from the other side.
 */
export function useExportOptions(initial) {
  const [layout, setLayout] = useState(initial?.layout ?? 'single');
  const [mirror, setMirror] = useState(initial?.mirror ?? true);
  const [attachments, setAttachments] = useState(initial?.attachments ?? true);
  const [redact, setRedact] = useState(initial?.redact ?? false);
  const [redactStyle, setRedactStyle] = useState(initial?.redactStyle ?? 'blur');
  // The PNG's email column, CSS px.
  const [width, setWidth] = useState(initial?.width ?? EMAIL_WIDTH.default);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  // Redacting starts without attachments: their contents are not redacted.
  // Only on the switch to redacting, so a re-enabled checkbox stays on.
  const turnRedact = (on) => {
    setRedact(on);
    if (on && !redact) setAttachments(false);
  };

  const restore = (c) => {
    setLayout(c.layout ?? 'single');
    setMirror(c.mirror ?? true);
    setAttachments(c.attachments ?? true);
    setRedact(c.redact ?? false);
    setRedactStyle(c.redactStyle ?? 'blur');
    setWidth(c.width ?? EMAIL_WIDTH.default);
  };

  const choices = (format) => ({ format, layout, mirror, attachments, redact, redactStyle, width });

  return {
    layout, setLayout, mirror, setMirror, attachments, setAttachments, redact, redactStyle, setRedactStyle,
    width, setWidth, busy, setBusy, notice, setNotice, turnRedact, restore, choices,
  };
}
