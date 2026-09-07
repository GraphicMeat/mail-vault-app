/**
 * Every "Settings > ..." path we print has to be a path that exists.
 *
 * Appearance, Behavior, Notifications and Keyboard Shortcuts are SUB-TABS of
 * the General tab (`GeneralSettings.jsx` renders them); nothing by those names
 * sits at the top level of Settings. So `Settings > Appearance` sends a reader
 * hunting for a tab that is not there, and that shipped in seven changelog
 * entries, a FAQ answer in nine languages and one onboarding string before
 * anyone noticed.
 *
 * The check is per language, built from each catalog's OWN words rather than
 * from English, because the mistake is just as easy to make in a translation:
 * "Einstellungen > Erscheinungsbild" is wrong for exactly the same reason.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// App catalog code -> website directory. The website spells two of them
// differently, and a path list that assumes they match silently skips them.
const LOCALES = {
  en: '', de: 'de', es: 'es', fr: 'fr', it: 'it',
  ja: 'ja', ko: 'ko', 'pt-BR': 'pt-br', 'zh-Hans': 'zh',
};

// Both arrow styles the prose uses, plus the two the HTML does.
const SEPARATORS = ['→', '›', '>', '&rsaquo;'];

const SUB_TAB_KEYS = [
  'settings.appearance.appearance',
  'generalSettings.behavior',
  'settings.notifications.notifications',
  'shortcuts.keyboardShortcuts',
];

const catalog = (code) => JSON.parse(readFileSync(`src/i18n/locales/${code}.json`, 'utf8'));

/** Every `<Settings> <sep> <sub-tab>` in `text`, i.e. every path missing General. */
function pathsMissingGeneral(text, cat) {
  const settings = cat['settingsPage.settings'];
  const hits = [];
  for (const key of SUB_TAB_KEYS) {
    const sub = cat[key];
    if (!settings || !sub) continue;
    for (const sep of SEPARATORS) {
      const needle = `${settings} ${sep} ${sub}`;
      for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
        hits.push(needle);
      }
    }
  }
  return hits;
}

/** English pages only — the locale trees are walked separately, per language. */
function englishPages() {
  const out = [];
  for (const dir of ['website', 'website/faq', 'website/features', 'website/guides']) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.html')) out.push(join(dir, f));
    }
  }
  return out;
}

function localePages(dir) {
  const out = [];
  for (const sub of ['', 'faq', 'features', 'guides']) {
    const d = join('website', dir, sub);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (f.endsWith('.html')) out.push(join(d, f));
    }
  }
  return out;
}

describe('settings paths in user-facing copy', () => {
  it('names the General tab in the changelog', () => {
    const hits = pathsMissingGeneral(readFileSync('CHANGELOG.md', 'utf8'), catalog('en'));
    expect(hits, hits.join(', ')).toEqual([]);
  });

  it('leaves the one path that belongs to Apple Mail alone', () => {
    // "under Settings > General > Behavior used to send you to Mail > Settings
    // > General": the second path is Mail's own, and a blind sweep breaks it.
    expect(readFileSync('CHANGELOG.md', 'utf8')).toContain('Mail → Settings → General');
  });

  it.each(Object.keys(LOCALES))('names the General tab in every %s app string', (code) => {
    const cat = catalog(code);
    expect(Object.keys(cat).length).toBeGreaterThan(500);
    const hits = Object.entries(cat)
      .filter(([, v]) => typeof v === 'string')
      .flatMap(([k, v]) => pathsMissingGeneral(v, cat).map((h) => `${k}: ${h}`));
    expect(hits, hits.join(' | ')).toEqual([]);
  });

  it('names the General tab on every English website page', () => {
    const cat = catalog('en');
    const pages = englishPages();
    // A scan over an empty list passes for the wrong reason.
    expect(pages.length).toBeGreaterThan(20);
    const hits = pages.flatMap((p) =>
      pathsMissingGeneral(readFileSync(p, 'utf8'), cat).map((h) => `${p}: ${h}`));
    expect(hits, hits.join(' | ')).toEqual([]);
  });

  it.each(Object.entries(LOCALES).filter(([, dir]) => dir))(
    'names the General tab on every %s website page', (code, dir) => {
      const cat = catalog(code);
      const pages = localePages(dir);
      expect(pages.length, `no pages found under website/${dir}`).toBeGreaterThan(20);
      const hits = pages.flatMap((p) =>
        pathsMissingGeneral(readFileSync(p, 'utf8'), cat).map((h) => `${p}: ${h}`));
      expect(hits, hits.join(' | ')).toEqual([]);
    });

  // A scan that finds nothing proves nothing until it has been shown to fire.
  it('fires on a path that skips General', () => {
    const cat = catalog('en');
    expect(pathsMissingGeneral('open Settings → Appearance → Highlighting', cat)).toHaveLength(1);
    expect(pathsMissingGeneral('Einstellungen › Erscheinungsbild', catalog('de'))).toHaveLength(1);
    expect(pathsMissingGeneral('open Settings → General → Appearance', cat)).toEqual([]);
  });
});
