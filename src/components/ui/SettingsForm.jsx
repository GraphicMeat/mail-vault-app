import React, { forwardRef } from 'react';

const cx = (...parts) => parts.filter(Boolean).join(' ');

/**
 * The one outer wrapper every settings page must use (CSS: index.css
 * `.settings-form`, quick-actions.css `.settings-tabbed-page > .settings-form`).
 * A page that hand-rolls this div instead drifts from the shared width,
 * centering and padding — see PortableSettings before this existed.
 */
export const SettingsPageLayout = forwardRef(function SettingsPageLayout(
  { as: As = 'div', spaced = true, className = '', children, ...rest }, ref
) {
  return <As ref={ref} className={cx('settings-form', spaced && 'space-y-6', className)} {...rest}>{children}</As>;
});

/** The card every settings section is built from: `.settings-section` with an optional icon/title/badge heading as its direct child (CSS `.settings-section > h4`). */
export function SettingsCard({ title, icon: Icon, badge, headingClassName = '', className = '', children, ...rest }) {
  return (
    <section className={cx('settings-section', className)} {...rest}>
      {title != null && <h4 className={cx('flex items-center gap-2 font-semibold text-mail-text', headingClassName)}>
        {Icon && <Icon size={18} className="text-mail-accent-text" />}
        {title}
        {badge}
      </h4>}
      {children}
    </section>
  );
}

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
