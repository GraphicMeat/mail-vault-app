import React from 'react';

export function ToggleSwitch({ active, onClick, disabled, testId, label }) {
  return (
    <button
      type="button" role="switch" aria-checked={active} aria-label={label} disabled={disabled}
      className={`toggle-switch ${active ? 'active' : ''}${disabled ? ' opacity-40 pointer-events-none' : ''}`}
      onClick={disabled ? undefined : onClick}
      aria-disabled={disabled || undefined}
      data-testid={testId}
    />
  );
}
