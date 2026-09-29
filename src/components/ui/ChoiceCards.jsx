import React, { useRef } from "react";
import { Check } from "lucide-react";
import { choiceFromKey } from "./SegmentedChoice";

/**
 * One of a few options, each a card: a picture of the option (`preview`) over
 * its label. A radio group like SegmentedChoice; with `pressed`, a group of
 * toggle buttons instead, where the arrow keys pick nothing and none may be
 * on (a preset that overwrites a custom set is picked on purpose only).
 *
 * The picture sits beside the button, not in it: the button's name stays the
 * label alone and nothing interactive nests in a button. The button's ::after
 * spreads over the whole card, so a click on the picture picks it too.
 */
export function ChoiceCards({ label, options, value, onChange, pressed = false, className = "" }) {
  const buttons = useRef([]);
  // With nothing picked, the first card still takes Tab.
  const tabStop = options.some((option) => option.value === value && !option.disabled)
    ? value
    : options.find((option) => !option.disabled)?.value;
  const moveFromKey = (event, index) => {
    const next = choiceFromKey(event.key, options, options[index]);
    if (!next) return;
    event.preventDefault();
    onChange(next.value);
    buttons.current[options.indexOf(next)]?.focus();
  };
  return <div className={`choice-cards ${className}`} role={pressed ? "group" : "radiogroup"} aria-label={label}>
    {options.map((option, index) => {
      const selected = option.value === value;
      return <div key={option.value} className="choice-card" data-selected={selected || undefined}>
        {option.preview}
        <button
          ref={(node) => { buttons.current[index] = node; }}
          type="button"
          className="choice-card-button"
          {...(pressed ? { "aria-pressed": selected } : {
            role: "radio",
            "aria-checked": selected,
            tabIndex: option.value === tabStop ? 0 : -1,
            onKeyDown: (event) => moveFromKey(event, index),
          })}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
        >{option.label}<Check size={14} aria-hidden="true" /></button>
      </div>;
    })}
  </div>;
}
