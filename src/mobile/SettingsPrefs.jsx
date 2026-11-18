// The phone's own picker row, still used by Logs until it moves onto desktop's views too.
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
