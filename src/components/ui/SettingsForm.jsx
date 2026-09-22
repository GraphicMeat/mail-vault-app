import React from 'react';

/** The same reading width, section rhythm and control labels across settings editors. */
export function SettingsSection({ title, description, children, className = '' }) {
  return <section className={`settings-editor-section ${className}`}>
    {(title || description) && <div className="settings-editor-heading">
      {title && <h3>{title}</h3>}
      {description && <p>{description}</p>}
    </div>}
    {children}
  </section>;
}

export function SettingsField({ label, hint, children, className = '' }) {
  return <div className={`settings-editor-field ${className}`}>
    <div className="settings-editor-field-copy"><span>{label}</span>{hint && <small>{hint}</small>}</div>
    <div className="settings-editor-field-control">{children}</div>
  </div>;
}

export function SegmentedControl({ label, value, options, onChange }) {
  return <div className="settings-segmented" role="group" aria-label={label}>
    {options.map(option => <button key={option.value} type="button"
      aria-pressed={value === option.value} className={value === option.value ? 'is-selected' : ''}
      onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}
