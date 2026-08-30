/**
 * The website's directory names and the app's locale codes are two different
 * vocabularies that agree on six of eight entries. `zh` is `zh-Hans` in the app
 * and `pt-br` is `pt-BR`; getting either wrong files a locale's screenshots in
 * the wrong directory, or boots the app in English and photographs 28 lies.
 *
 * `dir` is what `website/<dir>/` and `website/screenshots/<dir>/` are called.
 * `app` is a key of the catalog map in `src/i18n/index.js`.
 */
export const LOCALES = [
  { dir: 'de',    app: 'de' },
  { dir: 'fr',    app: 'fr' },
  { dir: 'es',    app: 'es' },
  { dir: 'it',    app: 'it' },
  { dir: 'ja',    app: 'ja' },
  { dir: 'ko',    app: 'ko' },
  { dir: 'zh',    app: 'zh-Hans' },
  { dir: 'pt-br', app: 'pt-BR' },
];

/** Every directory a capture run can write, English first. */
export const SHOT_DIRS = ['en', ...LOCALES.map((l) => l.dir)];

export function appCode(dir) {
  if (dir === 'en') return 'en';
  const hit = LOCALES.find((l) => l.dir === dir);
  if (!hit) throw new Error(`unknown screenshot locale: ${dir}`);
  return hit.app;
}
