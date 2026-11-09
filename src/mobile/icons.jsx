// The action icons the mobile list and viewer share: 24px line icons in currentColor, hidden from
// assistive tech (the button carries the label).
import React from 'react';

const svg = (children, size = 22) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false"
    fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

/** A closed envelope (mark unread), or an open one (mark read). */
export function EnvelopeIcon({ open = false }) {
  return open
    ? svg(<><path d="M3 10l9-6 9 6v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /><path d="m3 10 9 6 9-6" /></>)
    : svg(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>);
}

export function FlagIcon({ filled = false }) {
  return svg(<><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" fill={filled ? 'currentColor' : 'none'} /></>);
}

export function MoveIcon() {
  return svg(<><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M10 13h6m-2-2 2 2-2 2" /></>);
}

export function TrashIcon() {
  return svg(<><path d="M4 7h16" /><path d="M10 11v6m4-6v6" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" /><path d="M9 7V4h6v3" /></>);
}

/** Three dots: more actions. */
/** A shield: tracking pixels found in a message (a check inside once they are blocked, a lock when Premium would block them). */
export function ShieldIcon({ state = 'blocked' }) {
  return svg(<>
    <path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z" />
    {state === 'blocked' ? <path d="m9 12 2 2 4-4" /> : <><rect x="9.5" y="11" width="5" height="4" rx="1" /><path d="M10.5 11V9.8a1.5 1.5 0 0 1 3 0V11" /></>}
  </>);
}

export function MoreIcon() {
  return svg(<><circle cx="5" cy="12" r="1.2" fill="currentColor" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><circle cx="19" cy="12" r="1.2" fill="currentColor" /></>);
}
