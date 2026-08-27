import React from 'react';

export function ToggleSwitch({ active, onClick, disabled }) {
  return (
    <div
      className={`toggle-switch ${active ? 'active' : ''}${disabled ? ' opacity-40 pointer-events-none' : ''}`}
      onClick={disabled ? undefined : onClick}
      aria-disabled={disabled || undefined}
    />
  );
}
