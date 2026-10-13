import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useT } from '../../i18n/index.js';
import { useSettingsStore } from '../../stores/settingsStore';
import { AddressText } from '../../components/email/AddressText';
import { maskString } from '../../utils/privacy/piiDetector';
import { emailKey } from '../../stores/slices/unifiedHelpers';
import { runPrepass } from './prepass';
import { usePrivacyDict } from './prepass/privacyDict';
import BlitzTiles from './BlitzTiles';
import FailureBubble from './FailureBubble';

const bubbled = new Set(); // message keys that already showed the bubble this session

// A cheap content signature (djb2): tells two messages apart when the caller has no key for them.
const signature = (text) => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${h >>> 0}`;
};

// The readable text of an HTML body for the failure view. Style, script and
// noscript text is code, not content.
const textOf = (html) => {
  try {
    const body = new DOMParser().parseFromString(html || '', 'text/html').body;
    for (const el of body.querySelectorAll('style, script, noscript, template')) el.remove();
    return body.textContent?.trim() || '';
  } catch { return ''; }
};

/** @param {import('./types').AltBodyProps} props */
export default function BlitzBody(props) {
  const { bodyHtml, documentHtml, indicatorCss, plainText, theme, message, onLink, sizing, className, style } = props;
  const t = useT();
  // emailScopeKey is null for a message whose location cannot be resolved. All such
  // messages must not share one failure, bubble and pre-pass state, so they get a key
  // from the message's own identity and content.
  const body = documentHtml ?? bodyHtml ?? plainText ?? '';
  const sig = useMemo(() => signature(body), [body]);
  const key = props.messageKey ?? `~${message ? emailKey(message) : ''}~${sig}`;
  const setEmailRenderer = useSettingsStore(s => s.setEmailRenderer);
  // Failure, bubble and pre-passed HTML are stored with the message they belong
  // to and read back only while key still matches. A new message so
  // starts clean in the very render it arrives in, with no frame of the old
  // message's tiles or failure view.
  const [failure, setFailure] = useState(null); // { key, code }
  const [bubble, setBubble] = useState(null); // key whose bubble is open
  const [prepassed, setPrepassed] = useState(null); // { key, html, masked }
  const failed = failure?.key === key;

  // Leaving a message forgets its failure, so coming back to it tries Blitz again.
  useEffect(() => () => { setFailure(null); setBubble(null); }, [key]);

  const priv = usePrivacyDict({ message, messageKey: key });
  // Derived in render, so no frame is ever painted from HTML built for another
  // privacy state: HTML pre-passed unmasked is never served once masking is on
  // (privacy turned on, a peek released, a capture mask), and masked HTML is
  // not served while a peek shows the real text. A hold serves nothing.
  const html = !priv.hold && prepassed?.key === key && prepassed.masked === priv.active ? prepassed.html : null;
  // A privacy hold clears the body at once. Any other re-run (theme, search,
  // folds) keeps the old tiles up until the new HTML lands, so typing a search
  // does not blank the body on every keystroke.
  useEffect(() => {
    if (priv.hold) { setPrepassed(null); return undefined; }
    let live = true;
    const masked = priv.active;
    runPrepass(props, { privacy: priv })
      .then(r => {
        // Same HTML again keeps the old state object, so an identical re-run renders nothing.
        // `masked` is part of the match: a body with nothing to mask gives the same HTML
        // either way, and must still be served once privacy is on.
        if (live) setPrepassed(p => (p && p.key === key && p.masked === masked && p.html === r.html ? p : { key, html: r.html, masked }));
      })
      .catch(err => { console.error('[blitz] pre-pass failed; the body stays hidden', err); if (live) setPrepassed(null); });
    return () => { live = false; };
  }, [key, bodyHtml, documentHtml, indicatorCss, theme?.tableMode, theme?.dark, theme?.palette, priv.active, priv.dict, priv.hold]); // eslint-disable-line react-hooks/exhaustive-deps

  const onFailure = (code) => {
    console.warn('[blitz] could not draw', key, code);
    setFailure({ key, code });
    if (!bubbled.has(key)) { bubbled.add(key); setBubble(key); }
  };

  if (failed) {
    // The standard plain-text view's own masking (AddressText), fed the same
    // dictionary the pre-pass uses: the global names plus this message's own
    // parties. While the dictionary loads (hold) no body text is shown at all.
    // maskString runs first so a name only the message knows is masked too;
    // AddressText then masks again and honours peek, linkifying and the
    // mailto href drop.
    const shown = plainText || textOf(bodyHtml);
    const text = priv.active ? maskString(shown, priv.dict) : shown;
    return (
      <div className={className} style={style}>
        <p data-testid="blitz-failure-notice" className="text-xs text-mail-text-muted mb-2">{t('blitz.failed.notice')}</p>
        {!priv.hold && (
          <div className="email-content email-plain-body whitespace-pre-wrap rounded-lg">
            <AddressText text={text} accountId={props.accountId ?? message?._accountId} />
          </div>
        )}
        <AnimatePresence>
          {bubble === key && (
            <FailureBubble
              key="blitz-failure-bubble"
              onSwitch={() => { setBubble(null); setEmailRenderer('web'); }}
              onDismiss={() => setBubble(null)}
            />
          )}
        </AnimatePresence>
      </div>
    );
  }
  if (html == null) return <div className={className} style={style} data-testid="blitz-privacy-hold" />;
  return (
    <div className={className} style={style}>
      {/* Keyed on the privacy state: a flip unmounts the old tiles at once (closing their doc),
          so nothing built for the other state stays on screen while the new doc opens.
          A dictionary update while masking stays on does not change the key. */}
      <BlitzTiles key={priv.active ? 'masked' : 'plain'} html={html} theme={theme} onLink={onLink} onFailure={onFailure} sizing={sizing} privacy={priv.active} />
    </div>
  );
}
