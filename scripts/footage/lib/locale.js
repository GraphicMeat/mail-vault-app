/**
 * The UI language a footage run boots in: FOOTAGE_LOCALE (default `en`).
 *
 * Two vocabularies meet here (scripts/screenshots/locales.js): the website's
 * directory names (`pt-br`, `zh`) and the app's locale codes (`pt-BR`,
 * `zh-Hans`). FOOTAGE_LOCALE takes either. The app code is what the seeded
 * `language` setting, the app's label catalog (labels.js `makeLabels`) and the
 * demo mailbox catalog (demoData.js `demoScenarios`) all read; the directory
 * name is what output folders are called.
 */
import { LOCALES, appCode } from '../../screenshots/locales.js';

const raw = (process.env.FOOTAGE_LOCALE || 'en').trim();

function resolve(value) {
  if (value === 'en') return { dir: 'en', app: 'en' };
  const byApp = LOCALES.find((l) => l.app === value);
  if (byApp) return { ...byApp };
  return { dir: value, app: appCode(value) }; // throws on an unknown locale
}

const resolved = resolve(raw);

/** App locale code: `en`, `de`, `pt-BR`, `zh-Hans`, ... */
export const APP_LOCALE = resolved.app;
/** Website directory name: `en`, `de`, `pt-br`, `zh`, ... */
export const LOCALE_DIR = resolved.dir;
