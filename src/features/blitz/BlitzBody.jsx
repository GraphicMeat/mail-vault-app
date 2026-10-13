import React, { useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useT } from '../../i18n/index.js';
import { useSettingsStore } from '../../stores/settingsStore';
import { runPrepass } from './prepass';
import { usePrivacyDict } from './prepass/privacyDict';
import BlitzTiles from './BlitzTiles';
import FailureBubble from './FailureBubble';

const bubbled = new Set(); // message keys that already showed the bubble this session

const textOf = (html) => {
  try { return new DOMParser().parseFromString(html || '', 'text/html').body.textContent?.trim() || ''; } catch { return ''; }
};

/** @param {import('./types').AltBodyProps} props */
export default function BlitzBody(props) {
  const { messageKey, bodyHtml, documentHtml, indicatorCss, plainText, theme, message, onLink, sizing, className, style } = props;
  const t = useT();
  const setEmailRenderer = useSettingsStore(s => s.setEmailRenderer);
  // Failure, bubble and pre-passed HTML are stored with the message they belong
  // to and read back only while messageKey still matches. A new message so
  // starts clean in the very render it arrives in, with no frame of the old
  // message's tiles or failure view.
  const [failure, setFailure] = useState(null); // { key, code }
  const [bubble, setBubble] = useState(null); // key whose bubble is open
  const [prepassed, setPrepassed] = useState(null); // { key, html }
  const failed = failure?.key === messageKey;
  const html = prepassed?.key === messageKey ? prepassed.html : null;

  // Leaving a message forgets its failure, so coming back to it tries Blitz again.
  useEffect(() => () => { setFailure(null); setBubble(null); }, [messageKey]);

  const priv = usePrivacyDict({ message });
  // A privacy hold clears the body at once. Any other re-run (theme, search,
  // folds) keeps the old tiles up until the new HTML lands, so typing a search
  // does not blank the body on every keystroke.
  useEffect(() => {
    if (priv.hold) { setPrepassed(null); return undefined; }
    let live = true;
    runPrepass(props, { privacy: priv })
      .then(r => {
        // Same HTML again keeps the old state object, so an identical re-run renders nothing.
        if (live) setPrepassed(p => (p && p.key === messageKey && p.html === r.html ? p : { key: messageKey, html: r.html }));
      })
      .catch(err => { console.error('[blitz] pre-pass failed; the body stays hidden', err); if (live) setPrepassed(null); });
    return () => { live = false; };
  }, [messageKey, bodyHtml, documentHtml, indicatorCss, theme?.tableMode, theme?.dark, theme?.palette, priv.active, priv.dict, priv.hold]); // eslint-disable-line react-hooks/exhaustive-deps

  const onFailure = (code) => {
    console.warn('[blitz] could not draw', messageKey, code);
    setFailure({ key: messageKey, code });
    if (!bubbled.has(messageKey)) { bubbled.add(messageKey); setBubble(messageKey); }
  };

  if (failed) {
    return (
      <div className={className} style={style}>
        <p data-testid="blitz-failure-notice" className="text-xs text-mail-text-muted mb-2">{t('blitz.failed.notice')}</p>
        <div className="email-content email-plain-body whitespace-pre-wrap rounded-lg">{plainText || textOf(bodyHtml)}</div>
        <AnimatePresence>
          {bubble === messageKey && (
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
      <BlitzTiles html={html} theme={theme} onLink={onLink} onFailure={onFailure} sizing={sizing} />
    </div>
  );
}
