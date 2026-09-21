import React, { useRef } from "react";

/** A compact radio group for choosing one immediately-applied setting value. */
export function SegmentedChoice({ label, options, value, onChange, className = "" }) {
  const choices = useRef([]);
  const available = options.filter((option) => !option.disabled);
  const changeFromKey = (event, index) => {
    const current = options[index];
    let next = null;
    if (event.key === "Home") next = available[0];
    if (event.key === "End") next = available.at(-1);
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      const offset = available.indexOf(current);
      next = available[(offset + 1 + available.length) % available.length];
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      const offset = available.indexOf(current);
      next = available[(offset - 1 + available.length) % available.length];
    }
    if (!next) return;
    event.preventDefault();
    onChange(next.value);
    choices.current[options.indexOf(next)]?.focus();
  };
  return <div className={`segmented-choice ${className}`} role="radiogroup" aria-label={label}>
    {options.map((option, index) => <button
      ref={(node) => { choices.current[index] = node; }}
      key={option.value}
      type="button"
      role="radio"
      aria-checked={value === option.value}
      tabIndex={value === option.value ? 0 : -1}
      disabled={option.disabled}
      onClick={() => onChange(option.value)}
      onKeyDown={(event) => changeFromKey(event, index)}
    >{option.label}</button>)}
  </div>;
}
