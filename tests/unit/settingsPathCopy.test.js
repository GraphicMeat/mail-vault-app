/**
 * Every "Settings > ..." path we print has to be a path that exists.
 *
 * The navigation redesign (`1960d7a6`, shipped in 2.13.0) rebuilt the Settings
 * nav and there is no General tab any more: Appearance is a TOP-LEVEL tab
 * (`SettingsPage.jsx`'s `settingsTabs`), and Behavior, Notifications and
 * Keyboard Shortcuts moved under **Mail preferences**, which is what
 * `GeneralSettings.jsx` renders now. So the two ways to print a path that
 * leads nowhere are mirrors of each other:
 *
 *   Settings > General > Appearance   names a tab the redesign deleted
 *   Settings > Behavior               skips the tab that holds it
 *
 * Both shipped: the first in seven changelog entries and a FAQ answer in nine
 * languages, written while General still existed and left behind when it went.
 *
 * The check is per language, built from each catalog's OWN words rather than
 * from English, because the mistake is just as easy to make in a translation:
 * "Einstellungen > Allgemein > Erscheinungsbild" is wrong for exactly the same
 * reason.
 *
 * Other people's settings are left alone. Apple Mail and Outlook.com each have
 * a "Settings > General" of their own; neither is followed by one of our tab
 * names, so neither matches.
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

// Sub-tabs of Mail preferences: a path that names one has to name it too.
const MAIL_PREFS_KEYS = [
  'generalSettings.behavior',
  'settings.notifications.notifications',
  'shortcuts.keyboardShortcuts',
];

// Everything the vanished General tab used to hold.
const EX_GENERAL_KEYS = ['settings.appearance.appearance', ...MAIL_PREFS_KEYS];

const catalog = (code) => JSON.parse(readFileSync(`src/i18n/locales/${code}.json`, 'utf8'));

/** Every path in `text` that names a Settings tab which is not there any more. */
function deadPaths(text, cat) {
  const settings = cat['settingsPage.settings'];
  const general = cat['settings.tab.general'];
  const hits = [];
  const count = (needle) => {
    for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) hits.push(needle);
  };
  if (!settings) return hits;
  for (const sep of SEPARATORS) {
    for (const key of EX_GENERAL_KEYS) {
      if (general && cat[key]) count(`${settings} ${sep} ${general} ${sep} ${cat[key]}`);
    }
    for (const key of MAIL_PREFS_KEYS) {
      if (cat[key]) count(`${settings} ${sep} ${cat[key]}`);
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
  it('names a tab that exists in the changelog', () => {
    const hits = deadPaths(readFileSync('CHANGELOG.md', 'utf8'), catalog('en'));
    expect(hits, hits.join(', ')).toEqual([]);
  });

  it('leaves the one path that belongs to Apple Mail alone', () => {
    // "under Settings → Mail preferences → Behavior used to send you to Mail →
    // Settings → General": the second path is Mail's own, and a blind sweep
    // breaks it.
    expect(readFileSync('CHANGELOG.md', 'utf8')).toContain('Mail → Settings → General');
  });

  it("leaves Outlook.com's own Settings alone", () => {
    // The mailbox-full guide walks the reader through Outlook.com's settings,
    // where General is a real tab and Storage is a real page under it.
    const guide = readFileSync('website/guides/outlook-hotmail-mailbox-full.html', 'utf8');
    expect(guide).toContain('Settings &rarr; General &rarr; Storage');
    expect(deadPaths(guide, catalog('en'))).toEqual([]);
  });

  it.each(Object.keys(LOCALES))('names a tab that exists in every %s app string', (code) => {
    const cat = catalog(code);
    expect(Object.keys(cat).length).toBeGreaterThan(500);
    const hits = Object.entries(cat)
      .filter(([, v]) => typeof v === 'string')
      .flatMap(([k, v]) => deadPaths(v, cat).map((h) => `${k}: ${h}`));
    expect(hits, hits.join(' | ')).toEqual([]);
  });

  it('names a tab that exists on every English website page', () => {
    const cat = catalog('en');
    const pages = englishPages();
    // A scan over an empty list passes for the wrong reason.
    expect(pages.length).toBeGreaterThan(20);
    const hits = pages.flatMap((p) =>
      deadPaths(readFileSync(p, 'utf8'), cat).map((h) => `${p}: ${h}`));
    expect(hits, hits.join(' | ')).toEqual([]);
  });

  it.each(Object.entries(LOCALES).filter(([, dir]) => dir))(
    'names a tab that exists on every %s website page', (code, dir) => {
      const cat = catalog(code);
      const pages = localePages(dir);
      expect(pages.length, `no pages found under website/${dir}`).toBeGreaterThan(20);
      const hits = pages.flatMap((p) =>
        deadPaths(readFileSync(p, 'utf8'), cat).map((h) => `${p}: ${h}`));
      expect(hits, hits.join(' | ')).toEqual([]);
    });

  // A scan that finds nothing proves nothing until it has been shown to fire.
  it('fires on a path through the tab that is gone, and on one that skips its parent', () => {
    const cat = catalog('en');
    expect(deadPaths('open Settings → General → Appearance', cat)).toHaveLength(1);
    expect(deadPaths('Einstellungen › Allgemein › Erscheinungsbild', catalog('de'))).toHaveLength(1);
    expect(deadPaths('open Settings → Behavior → After Deleting', cat)).toHaveLength(1);

    expect(deadPaths('open Settings → Appearance → Highlighting', cat)).toEqual([]);
    expect(deadPaths('open Settings → Mail preferences → Behavior', cat)).toEqual([]);
    expect(deadPaths('In Outlook.com, go to Settings → General → Storage', cat)).toEqual([]);
  });
});
