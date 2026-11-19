import React, { useId, useRef, useEffect } from 'react';
import { SettingsPageLayout } from './SettingsForm';

/**
 * Where a tab row that scrolls sideways can still go: `data-overflow` is `start`, `end`, `start
 * end` or absent, for a narrow screen's edge fade (the phone's CSS; desktop has none).
 */
function markOverflow(strip) {
  const more = strip.scrollWidth - strip.clientWidth > 1;
  const sides = more ? [strip.scrollLeft > 1 && 'start', strip.scrollLeft < strip.scrollWidth - strip.clientWidth - 1 && 'end'].filter(Boolean) : [];
  if (sides.length) strip.setAttribute('data-overflow', sides.join(' '));
  else strip.removeAttribute('data-overflow');
}

/** The same keyboard navigation and pinned tab row for every settings subpage. */
export function SettingsTabs({ tabs, value, onChange, label, children }) {
  const id = useId();
  const root = useRef(null);
  const strip = useRef(null);
  // A row wider than the screen keeps the open tab in sight (its own scroll only: no page moves)
  // and says which side has more.
  useEffect(() => {
    const el = strip.current;
    if (!el) return undefined;
    const active = el.querySelector('[aria-selected="true"]');
    if (active && el.scrollWidth > el.clientWidth) {
      const left = active.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft;
      const right = left + active.offsetWidth;
      if (left < el.scrollLeft) el.scrollLeft = Math.max(0, left - 24);
      else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth + 24;
    }
    markOverflow(el);
    const onScroll = () => markOverflow(el);
    el.addEventListener('scroll', onScroll, { passive: true });
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(onScroll) : null;
    resize?.observe(el);
    return () => { el.removeEventListener('scroll', onScroll); resize?.disconnect(); };
  }, [value, tabs.length]);
  useEffect(() => {
    // A new page starts at its top. A tab set inside a page (Quick actions'
    // surfaces) only swaps the part under it: the page stays where it is.
    if (root.current?.parentElement?.closest('.settings-tabbed-page')) return;
    const scroller = root.current?.closest('.settings-content');
    if (scroller) scroller.scrollTop = 0;
  }, [value]);
  const pickWithKey = (event, index) => {
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    onChange(tabs[next].id);
    event.currentTarget.parentElement.children[next].focus();
  };
  return (
    <div ref={root} className="settings-tabbed-page">
      <div ref={strip} role="tablist" aria-label={label} className="settings-tabs">
        {tabs.map((tab, index) => (
          <button key={tab.id} type="button" role="tab" id={`${id}-${tab.id}`}
            aria-selected={value === tab.id} aria-controls={`${id}-panel`}
            tabIndex={value === tab.id ? 0 : -1}
            onKeyDown={event => pickWithKey(event, index)} onClick={() => onChange(tab.id)}>
            {tab.label}
          </button>
        ))}
      </div>
      <SettingsPageLayout id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${value}`} tabIndex={0}>
        {children}
      </SettingsPageLayout>
    </div>
  );
}
