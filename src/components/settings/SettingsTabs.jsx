import React, { useId, useRef, useEffect } from 'react';

/** The same keyboard navigation and pinned tab row for every settings subpage. */
export function SettingsTabs({ tabs, value, onChange, label, children }) {
  const id = useId();
  const root = useRef(null);
  useEffect(() => {
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
      <div role="tablist" aria-label={label} className="settings-tabs">
        {tabs.map((tab, index) => (
          <button key={tab.id} type="button" role="tab" id={`${id}-${tab.id}`}
            aria-selected={value === tab.id} aria-controls={`${id}-panel`}
            tabIndex={value === tab.id ? 0 : -1}
            onKeyDown={event => pickWithKey(event, index)} onClick={() => onChange(tab.id)}>
            {tab.label}
          </button>
        ))}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${value}`}
        tabIndex={0} className="settings-form space-y-6">
        {children}
      </div>
    </div>
  );
}
