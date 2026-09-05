import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { LOCALES, render } from '../i18n/i18n.mjs';

const source = readFileSync('website/docs.html', 'utf8');
const script = readFileSync('website/assets/english-site.js', 'utf8');
const french = LOCALES.find(locale => locale.dir === 'fr');

function session(markup, saved, blocked = false) {
  const dom = new JSDOM(markup, { url: 'https://mailvaultapp.com/docs.html' });
  const storage = { getItem: vi.fn(() => saved), setItem: vi.fn() };
  if (blocked) storage.getItem.mockImplementation(() => { throw new Error('blocked'); });
  const location = { pathname: '/docs.html', search: '?from=help', hash: '#accounts', replace: vi.fn() };
  runInNewContext(script, {
    document: dom.window.document, location, localStorage: storage,
    URL, URLSearchParams, matchMedia: () => ({ matches: false }), navigator: { userAgent: '' },
  });
  return { dom, storage, location };
}

describe('website language selection', () => {
  it.each(LOCALES)('renders the correct selector and language destinations for $dir', locale => {
    const dom = new JSDOM(render(source, 'docs.html', locale, {}));
    const picker = dom.window.document.querySelector('.mv-language');
    expect(picker.querySelector('.mv-language-name').textContent).toBe(locale.name);
    expect(picker.querySelector('.mv-language-code').textContent).toBe(locale.dir.toUpperCase());
    expect(picker.querySelectorAll('[aria-current="page"]').length).toBe(1);
    expect(picker.querySelector('[aria-current="page"]').hreflang).toBe(locale.hreflang);
    expect(picker.querySelector('[hreflang="en"]').getAttribute('href')).toBe('/docs.html');
    expect(picker.querySelector('[hreflang="fr"]').getAttribute('href')).toBe('/fr/docs.html');
    dom.window.close();
  });
  it('restores French on an English entry page with query and anchor intact', () => {
    const { dom, location } = session(source, 'fr');
    expect(location.replace).toHaveBeenCalledWith('/fr/docs.html?from=help#accounts');
    dom.window.close();
  });
  it('respects a French URL and saves an explicit switch back to English', () => {
    const { dom, storage, location } = session(render(source, 'docs.html', french, {}), 'de');
    expect(location.replace).not.toHaveBeenCalled();
    expect(storage.setItem).toHaveBeenCalledWith('mv-language', 'fr');
    dom.window.document.querySelector('.mv-language [hreflang="en"]')
      .dispatchEvent(new dom.window.Event('click'));
    expect(storage.setItem).toHaveBeenLastCalledWith('mv-language', 'en');
    dom.window.close();
  });
  it.each(['en', 'invalid'])('does not redirect a %s preference', saved => {
    const { dom, location } = session(source, saved);
    expect(location.replace).not.toHaveBeenCalled();
    dom.window.close();
  });
  it('still works when storage is unavailable', () => {
    const { dom, location } = session(source, 'fr', true);
    expect(location.replace).not.toHaveBeenCalled();
    dom.window.close();
  });
});
