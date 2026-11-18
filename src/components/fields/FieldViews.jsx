// The custom-field piece both apps render in the reader, as a view: props in, callbacks out, no
// store, no service, no Tauri (fields/__tests__/fieldViewsPurity.test.js). Desktop's container is
// FieldStrip.jsx (the reader and the full-view modal); the phone's is src/mobile/FieldStrip.jsx
// in its viewer. The translator is the rendering app's, from settings/views/viewContext.
//
// - FieldStripView: the fields an account has (`schema`), each with its value from `values`
//   (`{ fieldId: value }`), editable in place: `onChange(field, value)`, `null` to clear. Nothing
//   when the account has no field.
//
// Nothing here writes to the message: a value is MailVault's own note about it, stored locally
// and keyed to the message's identity.
import React from 'react';
import { useT } from '../settings/views/viewContext';

const EMPTY_VALUES = {};

export function FieldStripView({ schema, values = EMPTY_VALUES, onChange, className = '' }) {
  const t = useT();
  if (!schema || !schema.length) return null;

  const store = (field, value) => onChange(field, value);

  const input = (field) => {
    const value = values?.[field.id];
    const testId = `field-input-${field.id}`;
    if (field.kind === 'checkbox') {
      return <input type="checkbox" data-testid={testId} checked={value === true}
        aria-label={field.name} onChange={event => store(field, event.target.checked)} />;
    }
    if (field.kind === 'date') {
      return <input type="date" data-testid={testId} value={typeof value === 'string' ? value : ''}
        aria-label={field.name} onChange={event => store(field, event.target.value || null)} />;
    }
    if (field.kind === 'select') {
      // A native <option> cannot be tinted portably, so the chosen choice's
      // colour is shown beside the control instead of inside it.
      const chosen = field.options.find(option => option.id === value);
      return <>
        {chosen?.color && <span className="field-swatch" aria-hidden="true" style={{ '--tag-color': chosen.color }} />}
        <select data-testid={testId} value={typeof value === 'string' ? value : ''} aria-label={field.name}
          onChange={event => store(field, event.target.value || null)}>
          <option value="">{t('fields.noValue')}</option>
          {field.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </>;
    }
    if (field.kind === 'multi_select') {
      const chosen = Array.isArray(value) ? value : [];
      return <span className="field-multi" data-testid={testId}>
        {field.options.map(option => <label key={option.id} className={chosen.includes(option.id) ? 'is-chosen' : ''}
          style={chosen.includes(option.id) && option.color ? { '--tag-color': option.color } : undefined}>
          <input type="checkbox" checked={chosen.includes(option.id)}
            onChange={event => store(field, event.target.checked
              ? [...chosen, option.id]
              : chosen.filter(id => id !== option.id))} />
          {option.label}
        </label>)}
      </span>;
    }
    return <input type="text" data-testid={testId} defaultValue={typeof value === 'string' ? value : ''}
      aria-label={field.name} maxLength={500}
      onBlur={event => {
        const next = event.target.value.trim();
        if (next !== (typeof value === 'string' ? value : '')) store(field, next || null);
      }} />;
  };

  return <div className={`field-strip ${className}`} aria-label={t('fields.section')}>
    {schema.map(field => <span key={field.id} className="field-strip-item">
      <span className="field-strip-name" data-testid={`field-name-${field.id}`}>{field.name}</span>
      {input(field)}
    </span>)}
  </div>;
}
