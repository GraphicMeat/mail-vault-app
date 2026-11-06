// Stand-in for the message viewer: subject and sender only. The perf gate measures navigation,
// not mail rendering. It covers the list, which stays mounted underneath.
import React, { useLayoutEffect } from 'react';
import { displayText } from '../utils/bidiText.js';
import { senderOf } from './MessageRow.jsx';
import { afterNextPaint, viewerPainted } from './perf.js';
import { useT } from './i18n.js';

export default function ViewerStub({ row, onClose }) {
  const t = useT();
  useLayoutEffect(() => {
    if (typeof requestAnimationFrame === 'function' && typeof MessageChannel === 'function') {
      afterNextPaint(viewerPainted);
    }
  }, []);
  return (
    <section className="mv-viewer" aria-modal="true" role="dialog">
      <header className="mv-viewer__bar">
        <button type="button" className="mv-viewer__back" data-mv-viewer-close style={{ minHeight: '44px', minWidth: '44px' }} onClick={onClose}>
          {t('common.back')}
        </button>
      </header>
      <h1 className="mv-viewer__subject" dir="auto">{displayText(row.subject, t('common.noSubject'))}</h1>
      <p className="mv-viewer__sender" dir="auto">{senderOf(row, t)}</p>
    </section>
  );
}
