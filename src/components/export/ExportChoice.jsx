import React from 'react';

// The label reads "Image" over a hint, but the accessible name is just the
// choice: "One tall image" and "Separate images" both contain the word image,
// and a radio group where three options answer to /image/ is one nobody — a
// screen reader user included — can pick from by name.
export function Choice({ name, value, checked, onChange, icon: Icon, label, hint, disabled = false }) {
  return (
    <label className={`flex items-start gap-2 p-3 rounded-lg border transition-colors
      ${disabled ? 'opacity-50 cursor-not-allowed border-mail-border' : 'cursor-pointer'}
      ${checked ? 'border-mail-accent bg-mail-accent-tint' : disabled ? '' : 'border-mail-border hover:border-mail-accent/50'}`}>
      <input type="radio" name={name} value={value} checked={checked} aria-label={label} disabled={disabled}
        onChange={() => onChange(value)} className="mt-0.5" />
      <span className="flex-1">
        <span className="flex items-center gap-1.5 text-sm text-mail-text font-medium">
          {Icon && <Icon size={14} />}{label}
        </span>
        {hint && <span className="block text-xs text-mail-text-muted mt-0.5">{hint}</span>}
      </span>
    </label>
  );
}
