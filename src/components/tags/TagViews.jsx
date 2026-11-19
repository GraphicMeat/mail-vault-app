// The tag pieces both apps render, as views: props in, callbacks out, no store, no service, no
// Tauri (tags/__tests__/tagViewsPurity.test.js). Desktop's containers are TagChips.jsx (list rows,
// thread rows, the reader) and Settings > Quick actions' label list; the phone's are its list row,
// its viewer and its Quick actions page (src/mobile/tags.js holds the phone's tag state).
//
// - TagChipsView: the tags on a message as chips (`tags`: `[{ id, name, color }]`), each with its
//   remove button while `onRemove(tag)` is given (a chip inside a control that is itself a button,
//   the phone's list row, has none); nothing when there are none.
// - TagListView: every tag, each with its delete button (`onDelete(id)`): the manage list.
//
// Their styles (`local-mail-label*`, `field-strip`) are in styles/labels-fields.css, which each app loads itself.
// The translator is the rendering app's, from settings/views/viewContext: a container that is not
// inside a settings page provides just its `t` (SettingsViewProvider), and only while it has chips.
import React from 'react';
import { useT } from '../settings/views/viewContext';

export function TagChipsView({ tags, onRemove = null, className = '' }) {
  const t = useT();
  if (!tags || !tags.length) return null;
  return <span className={`local-mail-labels ${className}`} aria-label={t('quickActions.localLabels')}>
    {tags.map(tag => <span key={tag.id} className="local-mail-label"
      style={tag.color ? { '--tag-color': tag.color } : undefined}>
      <span>{tag.name}</span>
      {onRemove && <button type="button" aria-label={t('quickActions.removeLabel', { label: tag.name })}
        title={t('quickActions.removeLabel', { label: tag.name })}
        onClick={event => {
          event.stopPropagation();
          onRemove(tag);
        }}>×</button>}
    </span>)}
  </span>;
}

export function TagListView({ tags, onDelete }) {
  const t = useT();
  return (
        <section
          className="quick-actions-label-list"
          aria-labelledby="quick-actions-label-title"
        >
          <h5 id="quick-actions-label-title">
            {t("quickActions.localLabels")}
          </h5>
          {tags.map((label) => (
            <span key={label.id} className="local-mail-label">
              {label.name}
              <button
                type="button"
                aria-label={t("quickActions.removeLabel", {
                  label: label.name,
                })}
                onClick={() =>
                  onDelete(label.id)}
              >
                ×
              </button>
            </span>
          ))}
        </section>
  );
}
