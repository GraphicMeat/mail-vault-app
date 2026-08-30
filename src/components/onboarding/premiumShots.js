// src/components/onboarding/premiumShots.js

/**
 * Locale-resolved premium screenshots, bundled under
 * `src/assets/premium/<locale>/<shot>-1440.webp`.
 *
 * `import.meta.glob` is eager so the packaged build has no dynamic chunk to
 * fetch; the files are already inside the app. English is the fallback for a
 * locale whose capture is missing, and a missing English file yields null so
 * the caller can render a tile with no image instead of a broken one.
 */
const MODULES = import.meta.glob('../../assets/premium/*/*-1440.webp', { eager: true, query: '?url', import: 'default' });

const key = (locale, shot) => `../../assets/premium/${locale}/${shot}-1440.webp`;

export function shotUrl(shot, locale) {
  if (!shot) return null;
  return MODULES[key(locale, shot)] ?? MODULES[key('en', shot)] ?? null;
}
