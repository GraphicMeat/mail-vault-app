import React from 'react';

export function ToggleSwitch({ active, onClick }) {
  return (
    <div
      className={`toggle-switch ${active ? 'active' : ''}`}
      onClick={onClick}
    />
  );
}
