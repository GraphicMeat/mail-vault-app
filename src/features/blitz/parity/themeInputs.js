// The theme render.open carries. The Dark Reader options MailVault passes the
// iframe come from the iframe's Dark Reader injector in src/utils/ (its
// DEFAULT_OPTIONS plus the palette's dark email colours; not named here, since
// darkSwatch.test.js forbids this module tree from naming it). themeInputs.test.js
// pins this copy to that file's actual output, so the two cannot drift apart.
import { getEmailColors } from '../../../utils/mailChrome';

export const DR_THEME_OPTIONS = Object.freeze({ brightness: 100, contrast: 100, sepia: 0 });

export function blitzThemeFor({ dark, palette }) {
  if (!dark) return { mode: 'light' };
  const { background, text } = getEmailColors('dark', palette);
  return { mode: 'dark', bg: background, fg: text, ...DR_THEME_OPTIONS };
}
