import React, { useRef } from "react";

/** The option an arrow, Home or End key moves a radio group to, or null. */
export function choiceFromKey(key, options, current) {
  const available = options.filter((option) => !option.disabled);
  const offset = available.indexOf(current);
  if (key === "Home") return available[0];
  if (key === "End") return available.at(-1);
  if (key === "ArrowRight" || key === "ArrowDown") {
    return available[(offset + 1 + available.length) % available.length];
  }
  if (key === "ArrowLeft" || key === "ArrowUp") {
    return available[(offset - 1 + available.length) % available.length];
  }
  return null;
}

/** A compact radio group for choosing one immediately-applied setting value. */
export function SegmentedChoice({ label, options, value, onChange, className = "" }) {
  const choices = useRef([]);
  const changeFromKey = (event, index) => {
    const next = choiceFromKey(event.key, options, options[index]);
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
