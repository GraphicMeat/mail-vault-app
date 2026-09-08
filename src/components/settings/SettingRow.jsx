import React, { useId } from 'react';

/** A consistent label/control pair that stacks inside narrow settings panes. */
export function SettingRow({ label, description, children, preview, className = '' }) {
  const id = useId();
  const isField = ['select', 'input', 'textarea'].includes(children.type);
  const Label = isField ? 'label' : 'div';
  return (
    <div className={`setting-row ${className}`}>
      <div className="setting-row-copy">
        <Label id={`${id}-label`} htmlFor={isField ? `${id}-control` : undefined} className="text-sm font-medium text-mail-text">{label}</Label>
        {description && <p id={`${id}-hint`} className="mt-1 text-xs leading-relaxed text-mail-text-muted">{description}</p>}
      </div>
      <div className="setting-row-control">
        {React.cloneElement(children, {
          id: isField ? `${id}-control` : children.props.id,
          'aria-labelledby': `${id}-label`,
          'aria-describedby': description ? `${id}-hint` : undefined,
        })}
        {preview && <div className="setting-row-preview">{preview}</div>}
      </div>
    </div>
  );
}
