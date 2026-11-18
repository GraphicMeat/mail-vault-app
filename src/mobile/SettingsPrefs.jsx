// The phone's own picker and switch rows, still used by the pages not yet on the shared desktop
// views (Logs, Unsubscribe). Mail preferences, Privacy and Appearance render desktop's views
// (src/mobile/settings/).
import React, { useId } from 'react';

/** One preference as a labelled native picker: `options` are `[value, label]`. */
export function Choice({ label, value, options, onChange, disabled, name }) {
  const id = useId();
  return (
    <label className="mv-setting mv-setting--choice" htmlFor={id}>
      <span className="mv-setting__text">
        <span className="mv-setting__label">{label}</span>
      </span>
      <select
        id={id}
        className="mv-setting__select"
        data-mv-pref={name}
        value={String(value)}
        disabled={disabled}
        onChange={(e) => {
          const hit = options.find(([v]) => String(v) === e.target.value);
          if (hit) onChange(hit[0]);
        }}
      >
        {options.map(([v, text]) => <option key={String(v)} value={String(v)}>{text}</option>)}
      </select>
    </label>
  );
}

export function Toggle({ label, hint, checked, onChange, name }) {
  const id = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={`${id}-l`}
      aria-describedby={hint ? `${id}-h` : undefined}
      className="mv-setting"
      data-mv-pref={name}
      onClick={() => onChange(!checked)}
    >
      <span className="mv-setting__text">
        <span className="mv-setting__label" id={`${id}-l`}>{label}</span>
        {hint && <span className="mv-setting__hint" id={`${id}-h`}>{hint}</span>}
      </span>
      <span className="mv-switch" aria-hidden="true"><span className="mv-switch__knob" /></span>
    </button>
  );
}
