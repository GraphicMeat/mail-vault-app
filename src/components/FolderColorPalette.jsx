import React from 'react';
import { FOLDER_ICON_PALETTE } from '../utils/folderIconColor';

/**
 * Desktop's folder colour palette: the swatches and the reset link of the folder context menu,
 * presentational so the phone draws the very same choices in its own sheet. Strings come in as
 * props (each app translates with its own catalog lookup). `onPick(color)` picks a swatch,
 * `onPick(null)` takes the pick away. `className`, `swatchClassName`, `resetClassName` are the
 * host's look (the menu's compact swatches, the phone's 44px ones); `showLabel` false leaves the
 * heading out when the host names the choice itself. `current`: the swatch to mark as picked.
 */
export function FolderColorPalette({ label, resetLabel, onPick, current = null, showLabel = true, className = '', swatchClassName = '', resetClassName = '' }) {
  return (
    <div role="group" aria-label={label} className={className}>
      {showLabel && <div className="text-xs text-mail-text-muted mb-1.5">{label}</div>}
      <div className="flex flex-wrap gap-1.5">
        {FOLDER_ICON_PALETTE.map(color => (
          <button key={color} type="button" data-testid="folder-color-swatch" data-color={color}
            title={color} aria-label={color} aria-pressed={current ? current === color : undefined}
            onClick={() => onPick(color)}
            className={swatchClassName} style={{ background: color }} />
        ))}
      </div>
      <button type="button" data-testid="folder-color-reset" onClick={() => onPick(null)}
        className={resetClassName}>{resetLabel}</button>
    </div>
  );
}
