// What a view's definition would find, right now: the view editor's preview, as a view both apps
// render. Desktop's container is components/ViewPreview.jsx (the view store's `previewDef`); the
// phone's is in src/mobile/settings/Views.jsx (`mobile.views.evaluate` with the definition).
//
// `run(def, limit)` answers `{ available, reason, total, rows: [{ key, sender, subject, date }] }`
// (`date` anything `new Date` reads, or empty), or null when a newer run made this one stale.
import React, { useEffect, useRef, useState } from 'react';
import { useT, useViewEnv } from './viewContext';

/// The preview never repaints the mail list: this is a panel inside
/// Settings. It keeps its rows to itself and runs on its own generation, so
/// typing here cannot cancel a view somebody has open.
export function ViewPreviewView({ def, limit = 25, run }) {
  const t = useT();
  const { Private } = useViewEnv();
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
      const reply = await run(JSON.parse(key), limit);
      if (mine !== latest.current || reply === null) return;
      setResult(reply);
      setRunning(false);
    }, 250);
    return () => clearTimeout(timer);
  }, [key, limit, run]);

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
      {result.rows.map(row => <li key={row.key}>
        <span className="view-preview-sender"><Private kind="name">{row.sender || ''}</Private></span>
        <span className="view-preview-subject">{row.subject ? <Private kind="text">{row.subject}</Private> : t('views.preview.noSubject')}</span>
        <span className="view-preview-date">{row.date ? new Date(row.date).toLocaleDateString() : ''}</span>
      </li>)}
    </ul>}
  </section>;
}
