import { getContextMenuColors } from '../../../utils/emailIframeTemplate';

// Light: the iframe menu's own colours. Dark: the iframe menu is those same
// light colours re-themed by Dark Reader, so Blitz needs Dark Reader's result
// for them (theme/darkSwatch.js, no probe yet), passed in as `dark`; until then `dark` is null.
export function menuColorsFor(theme, dark = null) {
  const light = getContextMenuColors();
  return theme?.dark && dark ? { ...light, ...dark } : light;
}
