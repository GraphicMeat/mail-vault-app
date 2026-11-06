// A modal panel over the list: a bottom sheet or a leading-edge drawer, with a backdrop that
// closes it on tap. Focus moves into the panel on open and back to where it was on close.
import React, { useEffect, useRef } from 'react';

export default function Sheet({ kind = 'sheet', label, onClose, children }) {
  const panel = useRef(null);
  useEffect(() => {
    const before = document.activeElement;
    panel.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (before && typeof before.focus === 'function') before.focus();
    };
  }, [onClose]);
  return (
    <div className={`mv-overlay mv-overlay--${kind}`}>
      <div className="mv-overlay__backdrop" onClick={onClose} aria-hidden="true" />
      <div ref={panel} className={`mv-${kind}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}
