import React, { useEffect, useRef, useState } from 'react';
import { useViewStore } from '../stores/viewStore';
import { useT } from '../i18n/index.js';

/// What the definition on screen would find, right now.
///
/// The preview never calls `showRows`: that repaints the mail list, and this
/// is a panel inside Settings. It keeps its rows to itself and runs on its own
/// generation, so typing here cannot cancel a view somebody has open.
export function ViewPreview({ def, limit = 25 }) {
  const t = useT();
  const previewDef = useViewStore(state => state.previewDef);
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(true);
  // The definition as text: a new object on every render would re-run the
  // preview on every keystroke in an unrelated field.
  const key = JSON.stringify(def || {});
  const latest = useRef(0);

  useEffect(() => {
    const mine = ++latest.current;
    setRunning(true);
    // A builder is typed into, so the preview waits out the typing rather than
    // asking the index once per character.
    const timer = setTimeout(async () => {
      const reply = await previewDef(JSON.parse(key), limit);
      if (mine !== latest.current || reply === null) return;
      setResult(reply);
      setRunning(false);
    }, 250);
    return () => clearTimeout(timer);
  }, [key, limit, previewDef]);

  const rowKey = email => [email._accountId, email._mailbox, email.uid].join('/');

  return <section className="view-preview" data-testid="view-preview" aria-live="polite">
    <div className="view-preview-heading">
      <h3>{t('views.preview.title')}</h3>
      {result?.available && <span className="view-preview-total" data-testid="view-preview-total">
        {t('views.preview.matches', { count: result.total })}
      </span>}
    </div>

    {running && !result && <p className="view-preview-note" data-testid="view-preview-running">{t('views.preview.running')}</p>}

    {/* Zero is a claim about the mail. An index that could not answer has made
        no claim at all, and saying "0 matches" there would be a lie. */}
    {result && !result.available && <p className="view-preview-note" data-testid="view-preview-unavailable">
      {t(`views.unavailable.${result.reason}`)}
    </p>}

    {result?.available && result.rows.length === 0 && <p className="view-preview-note" data-testid="view-preview-empty">
      {t('views.preview.empty')}
    </p>}

    {result?.available && result.rows.length > 0 && <ul className="view-preview-rows" data-testid="view-preview-rows">
      {result.rows.map(email => <li key={rowKey(email)}>
        <span className="view-preview-sender">{email.from?.name || email.from?.address || ''}</span>
        <span className="view-preview-subject">{email.subject || t('views.preview.noSubject')}</span>
        <span className="view-preview-date">{email.date ? new Date(email.date).toLocaleDateString() : ''}</span>
      </li>)}
    </ul>}
  </section>;
}
