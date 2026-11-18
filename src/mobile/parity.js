// The settings parity check (src/mobile/__tests__/settingsParity.test.js): every desktop page and
// every desktop setting has a phone decision in the shared manifest, and every setting the
// manifest puts on the phone is really rendered by the phone build. Static: a key counts as
// rendered when a module the phone bundle reaches (src/mobile/seam.js) names it as a string
// literal. The manifest itself, the catalogs and src/i18n name every key, so they do not count.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './seam.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOT_RENDERERS = /node_modules\/|\.json$|^src\/i18n\/|settingsManifest\.js$/;

/** The source of every module in `modules` (seam metafile paths) that can render a label. */
export function renderingSource(modules) {
  return modules.filter((m) => !NOT_RENDERERS.test(m))
    .map((m) => {
      try { return stripComments(readFileSync(path.join(ROOT, m), 'utf8')); } catch { return ''; }
    })
    .join('\n');
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `source` names `key` as a whole string literal. */
export const names = (source, key) => new RegExp(`(['"\`])${escape(key)}\\1`).test(source);

const decided = (value) => value === true || (typeof value === 'string' && value.trim().length > 0);

/**
 * What breaks parity:
 * - `undecidedPages`: a desktop page id with no phone decision;
 * - `undecided`: a desktop setting with no phone decision (or a blank reason);
 * - `notRendered`: a setting on the phone (`true`) whose label (its `labels` replacement, if any)
 *   no phone module names;
 * - `onPhoneUnderMissingPage`: a setting on the phone whose page is not.
 * Also `engineGaps`: `{ reason: [keys] }` of every `engine:` decision, pages included, the work
 * still to do.
 */
export function parityGaps({ pageIds, groups, pages, settings, labels = {}, source, notice = 'desktopNotice' }) {
  const keys = groups.flatMap((group) => group.settings.map(([key]) => ({ key, page: group.id })));
  const undecidedPages = pageIds.filter((id) => !decided(pages[id]));
  const undecided = keys.filter(({ key }) => !decided(settings[key])).map(({ key }) => key);
  const onPhone = keys.filter(({ key }) => settings[key] === true);
  const notRendered = onPhone.filter(({ key }) => !names(source, labels[key] || key)).map(({ key }) => key);
  const onPhoneUnderMissingPage = onPhone.filter(({ page }) => pages[page] !== true).map(({ key }) => key);
  const engineGaps = {};
  const gap = (reason, item) => { (engineGaps[reason] ||= []).push(item); };
  for (const id of pageIds) if (typeof pages[id] === 'string' && pages[id] !== notice && pages[id].startsWith('engine:')) gap(pages[id], `page ${id}`);
  for (const { key } of keys) if (typeof settings[key] === 'string' && settings[key].startsWith('engine:')) gap(settings[key], key);
  return { undecidedPages, undecided, notRendered, onPhoneUnderMissingPage, engineGaps };
}
