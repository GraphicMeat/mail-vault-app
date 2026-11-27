// A compose toolbar button: its icon with a caption under it, so every tool says what it is.
// `label` is the accessible name when it is longer than the caption ("Send later" under "Later").
import React from 'react';

/** One icon size for every tool, so the captions under them sit on one line. */
export const TOOL_ICON_SIZE = 22;

export default function ToolButton({ icon: Icon, caption, label = caption, className = '', ...rest }) {
  return (
    <button type="button" className={`mv-compose__tool ${className}`.trim()} aria-label={label} {...rest}>
      <Icon size={TOOL_ICON_SIZE} />
      <span className="mv-compose__tool-caption">{caption}</span>
    </button>
  );
}
