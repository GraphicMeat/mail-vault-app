/**
 * App locale codes and website directory names are two different sets. The
 * screenshot work already paid for this once: `pt-BR` and `zh-Hans` land in
 * `pt-br` and `zh` on the site, and passing the app code straight through
 * produces a 404.
 */
const DIRS = {
  en: '', es: 'es', fr: 'fr', it: 'it', de: 'de',
  'pt-BR': 'pt-br', ja: 'ja', ko: 'ko', 'zh-Hans': 'zh',
};

export function faqUrl(locale) {
  const dir = DIRS[locale] ?? '';
  return `https://mailvaultapp.com/${dir ? `${dir}/` : ''}faq.html`;
}
