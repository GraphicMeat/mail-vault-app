// src/components/onboarding/safetyShots.js

/**
 * Locale-resolved safety screenshots, bundled under
 * `src/assets/safety/<locale>/<shot>-1440.webp`.
 *
 * Same mechanism and same reasoning as `premiumShots.js`: the glob is eager so
 * the packaged build has no dynamic chunk to fetch, English is the fallback for
 * a locale whose capture is missing, and a missing English file yields null so
 * the caller renders the alert with no image rather than a broken one.
 *
 * The locale key is the APP's code (`pt-BR`, `zh-Hans`), not the website's
 * directory (`pt-br`, `zh`) — the capture step does the remap when it copies the
 * files in. Getting that wrong falls back to English forever with every test
 * still green.
 */
const SAFETY = import.meta.glob('../../assets/safety/*/*-1440.webp', { eager: true, query: '?url', import: 'default' });
// `premium-tracker-blocking` is a premium capture that the safety legend also
// wants. Copying it into assets/safety/ too was 492KB of byte-identical files
// and a second copy to keep in step, so the resolver reads the premium bundle
// rather than the bundler shipping both.
const PREMIUM = import.meta.glob('../../assets/premium/*/*-1440.webp', { eager: true, query: '?url', import: 'default' });

const at = (dir, locale, shot) => `../../assets/${dir}/${locale}/${shot}-1440.webp`;

export function safetyShotUrl(shot, locale) {
  if (!shot) return null;
  for (const loc of [locale, 'en']) {
    const hit = SAFETY[at('safety', loc, shot)] ?? PREMIUM[at('premium', loc, shot)];
    if (hit) return hit;
  }
  return null;
}
