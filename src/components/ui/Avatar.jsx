import React from 'react';
export function Avatar({ name = '', size = 36, tint = true, className = '' }) {
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
  const tone = tint ? 'bg-mail-accent-tint text-mail-accent-text' : 'bg-mail-accent text-white';
  return (
    <div
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      className={`${tone} rounded-full flex items-center justify-center font-semibold flex-shrink-0 ${className}`}
    >
      {initial}
    </div>
  );
}
