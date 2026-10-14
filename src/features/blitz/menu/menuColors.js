import { getContextMenuColors } from '../../../utils/emailIframeTemplate';

// Light: the iframe menu's own colours. Dark: the iframe menu is those same
// light colours re-themed by Dark Reader, so Blitz needs Dark Reader's result
// for them (theme/darkSwatch.js, Task 15), passed in as `dark`.
export function menuColorsFor(theme, dark = null) {
  const light = getContextMenuColors();
  return theme?.dark && dark ? { ...light, ...dark } : light;
}
