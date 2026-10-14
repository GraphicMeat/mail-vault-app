import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from '../../../i18n/index.js';

// The iframe's right-click menu (EmailViewer.jsx handleContextMenu), as an
// app element: same items, labels, order, look and behaviour. It sits inside
// the body box in content coordinates, so it scrolls with the message; above
// the tiles and below the app's modals (z-40 and up).
// `clampTo(menuEl, at) -> { dx, dy }` keeps it inside the visible part of the body.
export default function BodyContextMenu({ at, link, colors, onCopy, onSelectAll, onClose, clampTo }) {
  const ref = useRef(null);
  const [active, setActive] = useState(-1); // the keyboard / hover highlight

  // Placed at the point first, then shifted by whatever the clamp asks, before paint.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !clampTo) return;
    el.style.left = `${at.x}px`;
    el.style.top = `${at.y}px`;
    const { dx, dy } = clampTo(el, at);
    el.style.left = `${at.x + dx}px`;
    el.style.top = `${at.y + dy}px`;
  }, [at.x, at.y, clampTo, link]);

  const items = [
    { label: t('viewer.copy'), action: onCopy },
    ...(link ? [{
      label: t('viewer.copyLink'),
      // The href is what the renderer was given, so privacy masking has already
      // run on it; like the iframe's, it is written to the clipboard, never painted.
      action: () => {
        const fail = err => console.error('Failed to copy link:', err);
        try { navigator.clipboard.writeText(link.href).catch(fail); } catch (err) { fail(err); }
      },
    }] : []),
    { label: t('settings.migration.selectAll'), action: onSelectAll },
  ];

  // The document-level listeners read the latest of these.
  const latest = useRef({});
  latest.current = { items, active, onClose };

  useEffect(() => {
    const el = ref.current;
    // Focus stays in the body (a focus move can drop the selection Copy needs),
    // so the menu takes its keys at the document, ahead of the body's own.
    const run = (i) => { const it = latest.current.items[i]; if (it) { it.action(); latest.current.onClose(); } };
    const onKey = (e) => {
      const { items: list, active: cur, onClose: close } = latest.current;
      // Capture phase: the menu answers first, so Escape never reaches the body's
      // own Escape (which clears the selection) while the menu is open.
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setActive(cur < 0 ? 0 : (cur + 1) % list.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setActive(cur < 0 ? list.length - 1 : (cur + list.length - 1) % list.length); return; }
      if (e.key === 'Enter' && cur >= 0) { e.preventDefault(); e.stopPropagation(); run(cur); return; }
      if (e.key === 'Tab') close();
    };
    // A press inside the body is left to the body's click handler, which closes
    // the menu and swallows that click (the iframe's menu does the same).
    const onDown = (e) => {
      if (!el?.parentElement?.contains(e.target)) latest.current.onClose();
    };
    const dismiss = () => latest.current.onClose();
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('blur', dismiss);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('blur', dismiss);
    };
  }, []);

  const { menuBg, menuBorder, menuShadow, itemColor, itemHoverBg } = colors;
  return (
    <div
      ref={ref}
      role="menu"
      data-testid="blitz-context-menu"
      // preventDefault, not just stopPropagation: a mousedown on the menu's
      // text would otherwise collapse the body selection before Copy runs.
      onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
      onClick={e => e.stopPropagation()}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}
      style={{
        position: 'absolute', zIndex: 30, left: at.x, top: at.y, userSelect: 'none', outline: 'none',
        background: menuBg, border: `1px solid ${menuBorder}`, borderRadius: '6px', padding: '4px 0',
        minWidth: '180px', fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif', fontSize: '13px', boxShadow: menuShadow,
      }}
    >
      {items.map(({ label, action }, i) => (
        <div
          key={label}
          role="menuitem"
          data-testid="blitz-ctx-item"
          style={{ padding: '6px 14px', cursor: 'pointer', color: itemColor, background: i === active ? itemHoverBg : 'none' }}
          onMouseOver={() => setActive(i)}
          onMouseOut={() => setActive(-1)}
          onClick={() => { action(); onClose(); }}
        >{label}</div>
      ))}
    </div>
  );
}
