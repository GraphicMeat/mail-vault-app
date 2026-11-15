// The home screen icon follows the `appIcon` preference (Settings > Appearance > App icon, or a
// desktop import): the store hands every preference read and write here, and the shell switches
// the OS icon (`mobile_app_icon`: iOS alternate icon, Android launcher alias). The shell answers a
// call for the icon already set without doing anything, so the first read at launch costs nothing;
// after that only a change calls it. A failed switch is tried again on the next read.
import { setAppIcon } from './transport.js';

export const APP_ICON_NAMES = ['purple', 'teal'];

export const normalizeAppIcon = (value) => (value === 'teal' ? 'teal' : 'purple');

let applied = null;

export function followAppIcon(prefs, apply = null) {
  const icon = normalizeAppIcon(prefs?.appIcon);
  if (icon === applied) return;
  applied = icon;
  Promise.resolve()
    // The shell call is looked up here, inside the chain: a page without it never throws here.
    .then(() => (apply || setAppIcon)(icon))
    .catch(() => {
      if (applied === icon) applied = null;
    });
}

/** Tests only: forget what was applied. */
export function resetAppIconForTest() {
  applied = null;
}
