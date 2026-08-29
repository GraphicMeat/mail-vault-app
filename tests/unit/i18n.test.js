// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  LOCALES, collect, render, keyOf, isTranslatable, localizePath, urlPathOf,
} from '../../website/i18n/i18n.mjs';

const de = LOCALES.find((l) => l.dir === 'de');
const dict = (pairs) => Object.fromEntries(
  Object.entries(pairs).map(([en, tr]) => [keyOf(en), tr])
);

// A page shaped like the real ones: absolute and relative links, a translatable
// attribute, an entity, a price template, and a JSON-LD block.
const PAGE = `<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
  <title>MailVault Pricing</title>
  <meta name="description" content="Keep your mail.">
  <link rel="canonical" href="https://mailvaultapp.com/pricing.html">
  <meta property="og:url" content="https://mailvaultapp.com/pricing.html">
  <meta property="og:locale" content="en_US">
  <link rel="icon" href="favicon.ico">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "name": "Simple, Honest Pricing",
    "url": "https://mailvaultapp.com/pricing.html"
  }
  </script>
</head>
<body>
  <a href="/faq.html">Frequently asked</a>
  <a href="/changelog.html">Changelog</a>
  <a href="https://github.com/GraphicMeat/mail-vault-app">GitHub</a>
  <img src="icon-128.webp" alt="MailVault logo">
  <span data-mv-price="~{monthlyEquivalent}/month">~$2/month</span>
  <p>&copy; 2026 MailVault. All rights reserved.</p>
  <script>var untouched = "Download";</script>
  <nav><a data-i18n-abs translate="no" href="/pricing.html">English</a></nav>
</body>
</html>`;

describe('collect', () => {
  const found = collect(PAGE);
  const texts = found.map((f) => f.text);

  it('picks up prose, titles, meta descriptions and alt text', () => {
    expect(texts).toContain('Frequently asked');
    expect(texts).toContain('MailVault Pricing');
    expect(texts).toContain('Keep your mail.');
    expect(texts).toContain('MailVault logo');
  });

  it('picks up JSON-LD prose but not its schema keys or URLs', () => {
    expect(texts).toContain('Simple, Honest Pricing');
    expect(texts).not.toContain('WebPage');
    expect(texts).not.toContain('https://schema.org');
  });

  it('skips script bodies, brand names and anything marked translate="no"', () => {
    // "Download" appears only inside <script>; "English" only under translate="no".
    expect(texts).not.toContain('Download');
    expect(texts).not.toContain('English');
    expect(texts).not.toContain('MailVault');
    expect(texts).not.toContain('GitHub');
  });

  it('rejects strings with no letters', () => {
    expect(isTranslatable('  ')).toBe(false);
    expect(isTranslatable('· 2026 ·')).toBe(false);
    expect(isTranslatable('Keep your mail.')).toBe(true);
  });
});

describe('render', () => {
  it('falls back to English for a key with no translation', () => {
    const out = render(PAGE, 'pricing.html', de, {});
    expect(out).toContain('Frequently asked');
    expect(out).toContain('<title>MailVault Pricing</title>');
  });

  it('substitutes prose and attribute translations', () => {
    const out = render(PAGE, 'pricing.html', de, dict({
      'Frequently asked': 'Häufige Fragen',
      'Keep your mail.': 'Behalte deine Mail.',
      'MailVault logo': 'MailVault-Logo',
    }));
    expect(out).toContain('>Häufige Fragen<');
    expect(out).toContain('content="Behalte deine Mail."');
    expect(out).toContain('alt="MailVault-Logo"');
  });

  it('declares the locale in lang, canonical, og:url and og:locale', () => {
    const out = render(PAGE, 'pricing.html', de, {});
    expect(out).toContain('<html lang="de"');
    expect(out).toContain('href="https://mailvaultapp.com/de/pricing.html"');
    expect(out).toContain('content="https://mailvaultapp.com/de/pricing.html"');
    expect(out).toContain('content="de_DE"');
  });

  it('prefixes localized pages, absolutizes assets and leaves the rest alone', () => {
    const out = render(PAGE, 'pricing.html', de, {});
    expect(out).toContain('href="/de/faq.html"');
    // Excluded from localization — must keep pointing at the English page.
    expect(out).toContain('href="/changelog.html"');
    // Relative asset would 404 one directory down, so it becomes root-absolute.
    expect(out).toContain('href="/favicon.ico"');
    expect(out).toContain('src="/icon-128.webp"');
    expect(out).toContain('href="https://github.com/GraphicMeat/mail-vault-app"');
    // The switcher's own English link is marked and must not gain a prefix.
    expect(out).toContain('href="/pricing.html"');
  });

  it('keeps brace placeholders and HTML entities intact', () => {
    const out = render(PAGE, 'pricing.html', de, dict({
      '~{monthlyEquivalent}/month': '~{monthlyEquivalent}/Monat',
      '&copy; 2026 MailVault. All rights reserved.': '&copy; 2026 MailVault. Alle Rechte vorbehalten.',
    }));
    expect(out).toContain('data-mv-price="~{monthlyEquivalent}/Monat"');
    expect(out).toContain('&copy; 2026 MailVault. Alle Rechte vorbehalten.');
  });

  it('translates JSON-LD prose and points its url at this locale', () => {
    const out = render(PAGE, 'pricing.html', de, dict({
      'Simple, Honest Pricing': 'Einfache, ehrliche Preise',
    }));
    const ld = JSON.parse(out.match(/ld\+json">([\s\S]*?)<\/script>/)[1]);
    expect(ld.name).toBe('Einfache, ehrliche Preise');
    expect(ld.url).toBe('https://mailvaultapp.com/de/pricing.html');
    expect(ld['@context']).toBe('https://schema.org');
  });

  it('never rewrites script bodies', () => {
    const out = render(PAGE, 'pricing.html', de, dict({ Download: 'Herunterladen' }));
    expect(out).toContain('var untouched = "Download";');
  });
});

describe('data-i18n-block', () => {
  // "Simple, <span>Honest</span> Pricing" translated as three fragments gives
  // "Sencillo y honesto Precios" — the markup freezes English word order. The
  // block is lifted whole so the translator can move the emphasis.
  const HEADING = `<html lang="en"><body>
  <h1 data-i18n-block>Simple, <span class="accent">Honest</span> Pricing</h1>
  <a href="/pricing.html">Pricing</a>
  </body></html>`;
  const EN = 'Simple, <span class="accent">Honest</span> Pricing';

  it('collects the element whole, markup included, not as fragments', () => {
    const texts = collect(HEADING).map((f) => f.text);
    expect(texts).toContain(EN);
    expect(texts).not.toContain('Simple,');
  });

  it('lets the translation put the emphasis where the language wants it', () => {
    const out = render(HEADING, 'pricing.html', de, dict({
      [EN]: '<span class="accent">Ehrliche</span> Preise, ganz einfach',
    }));
    expect(out).toContain('<h1 data-i18n-block><span class="accent">Ehrliche</span> Preise, ganz einfach</h1>');
  });

  it('still translates and localizes everything outside the block', () => {
    const out = render(HEADING, 'pricing.html', de, dict({ Pricing: 'Preise' }));
    expect(out).toContain('href="/de/pricing.html"');
    expect(out).toContain('>Preise</a>');
    // The nav word and the heading are different keys now, so the heading is
    // untouched by a translation of the bare word.
    expect(out).toContain(`<h1 data-i18n-block>${EN}</h1>`);
  });
});

describe('auto-blocking split sentences', () => {
  // Inline markup mid-sentence used to yield fragments like "in" / "Only the",
  // which are not translatable units — five translators independently had to
  // smuggle words across neighbouring keys to make them assemble.
  const SPLIT = `<html lang="en"><body>
  <p>Stored <strong>in Maildir</strong> format on your computer.</p>
  <p>See the <a href="/faq.html">FAQ</a> or the <a href="/changelog.html">changelog</a>.</p>
  <p>One whole sentence with no markup.</p>
  <li>A list item with <a href="/pricing.html">a nested list</a><ul><li>child</li></ul></li>
  </body></html>`;

  it('makes the whole sentence one key instead of glue fragments', () => {
    const texts = collect(SPLIT).map((f) => f.text);
    expect(texts).toContain('Stored <strong>in Maildir</strong> format on your computer.');
    expect(texts).not.toContain('Stored');
    expect(texts).not.toContain('format on your computer.');
  });

  it('leaves an unsplit sentence as a plain string', () => {
    expect(collect(SPLIT).map((f) => f.text)).toContain('One whole sentence with no markup.');
  });

  it('does not swallow an element that holds more structure', () => {
    // The <li> contains a nested <ul>; blocking it would make the whole list
    // one string. Its inner text stays fragmented instead.
    const texts = collect(SPLIT).map((f) => f.text);
    expect(texts).toContain('child');
  });

  it('localizes links inside a block, which bypass the main URL pass', () => {
    const en = 'See the <a href="/faq.html">FAQ</a> or the <a href="/changelog.html">changelog</a>.';
    const out = render(SPLIT, 'index.html', de, dict({
      [en]: 'Siehe die <a href="/faq.html">FAQ</a> oder das <a href="/changelog.html">Changelog</a>.',
    }));
    expect(out).toContain('<a href="/de/faq.html">FAQ</a>');
    // changelog is not localized, so it must stay on the English page.
    expect(out).toContain('<a href="/changelog.html">Changelog</a>');
  });

  it('localizes links inside a block even with no translation', () => {
    const out = render(SPLIT, 'index.html', de, {});
    expect(out).toContain('href="/de/faq.html"');
    expect(out).toContain('href="/de/pricing.html"');
  });
});

describe('block translations may reorder their inline elements', () => {
  // The point of a block is that the target language chooses the word order.
  // Chinese moved a <code> span ahead of a <strong> in the real corpus; a check
  // on tag *order* would call that corruption. Only a dropped or invented tag is.
  const P = '<html lang="en"><body><p>The <strong>sidecar</strong> needs <code>allow-jit</code>.</p></body></html>';
  const EN = 'The <strong>sidecar</strong> needs <code>allow-jit</code>.';

  it('renders a reordered translation intact', () => {
    const out = render(P, 'index.html', de, dict({
      [EN]: '<code>allow-jit</code> braucht der <strong>Sidecar</strong>.',
    }));
    expect(out).toContain('<p><code>allow-jit</code> braucht der <strong>Sidecar</strong>.</p>');
  });
});

describe('localizePath', () => {
  it('maps the homepage to the locale root and leaves excluded pages alone', () => {
    expect(urlPathOf('index.html')).toBe('/');
    expect(localizePath('/', de)).toBe('/de/');
    expect(localizePath('/faq.html', de)).toBe('/de/faq.html');
    expect(localizePath('/guides/gmail-storage-full.html', de))
      .toBe('/de/guides/gmail-storage-full.html');
    expect(localizePath('/changelog.html', de)).toBeNull();
    expect(localizePath('/privacy.html', de)).toBeNull();
    expect(localizePath('/assets/tailwind.css', de)).toBeNull();
  });
});

describe('LOCALES', () => {
  it('is the agreed big 8, each with a distinct directory and hreflang', () => {
    expect(LOCALES.map((l) => l.hreflang))
      .toEqual(['de', 'fr', 'es', 'it', 'pt-BR', 'ja', 'ko', 'zh-Hans']);
    expect(new Set(LOCALES.map((l) => l.dir)).size).toBe(8);
  });
});
