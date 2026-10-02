import { appLink } from './appLink.js';

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

export function faqUrl(locale, medium) {
  const dir = DIRS[locale] ?? '';
  const url = `https://mailvaultapp.com/${dir ? `${dir}/` : ''}faq.html`;
  // Opened from the app: tag where from (see appLink).
  return medium ? appLink(url, medium) : url;
}
