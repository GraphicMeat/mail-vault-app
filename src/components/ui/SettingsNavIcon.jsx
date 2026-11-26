// The icon of a settings navigation entry: its glyph, white, on the entry's colour tile
// (`SETTINGS_TILE_COLORS` in settingsManifest.js). Desktop's settings sidebar and the phone's first
// screen both draw it, so the two look as one product; the sizes come from CSS (settings.css,
// and the phone's own scale in mobile.css).
import React from 'react';
import { settingsTileColor } from '../settings/settingsManifest';

export function SettingsNavIcon({ id, icon: Icon, size = 14 }) {
  return (
    <span className="settings-nav-tile" data-settings-tile={id} aria-hidden="true" style={{ '--settings-tile': settingsTileColor(id) }}>
      <Icon size={size} />
    </span>
  );
}
