import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { JSDOM } from 'jsdom';
import { LOCALES, render, keyOf } from '../../website/i18n/i18n.mjs';
import { cacheControlForPath, retainedDemoAssets, shouldRetainDemoAsset } from '../../scripts/website-release.mjs';

const root = resolve('website');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

function englishPages(dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = resolve(dir, entry.name);
    if (entry.isDirectory() && !['api', 'assets', 'demo', 'i18n', 'node_modules', 'screenshots'].includes(entry.name)) {
      return englishPages(file);
    }
    if (entry.isFile() && entry.name.endsWith('.html') && /<html[^>]*lang="en"/.test(readFileSync(file, 'utf8'))) {
      return [file];
    }
    return [];
  });
}

describe('homepage demo launcher', () => {
  it('uses a separate-window live demo image with no app preload', () => {
    const html = read('index.html');
    const dom = new JSDOM(html);
    const image = dom.window.document.querySelector('.mv-hero-product .mv-shot');
    expect(image?.tagName).toBe('A');
    expect(image?.getAttribute('href')).toBe('/demo/?lang=en');
    expect(image?.getAttribute('target')).toBe('_blank');
    expect(image?.getAttribute('rel')).toContain('noopener');
    expect(image?.getAttribute('aria-label')).toBe('Open the demo in a new window');
    expect(image?.querySelectorAll('a')).toHaveLength(0);
    expect(image?.querySelector('.mv-demo-badge')?.textContent).toBe('Interactive demo');
    expect(image?.querySelector('.mv-demo-launch')?.textContent).toContain('Open the demo');
    expect(image?.querySelector('img')?.getAttribute('alt')).toMatch(/inbox/i);
    const demoAction = dom.window.document.querySelector('.mv-hero .mv-actions [data-acquisition-destination="demo"]');
    expect(demoAction?.getAttribute('href')).toBe('/demo/?lang=en');
    expect(demoAction?.getAttribute('aria-label')).toBe('Try the live demo in a new window');
    expect(demoAction?.className).toContain('mv-secondary');
    expect(dom.window.document.querySelectorAll('.mv-hero .mv-actions [data-acquisition-destination="installer"], .mv-hero .mv-actions [data-acquisition-destination="store"], .mv-hero .mv-actions [data-acquisition-destination="setup"]')).toHaveLength(3);
    expect(html).not.toContain('See how it works');
    expect(dom.window.document.querySelector('.mv-hero-product figcaption')?.textContent).toContain('A real inbox. Ready to explore.');
    expect(dom.window.document.querySelector('.mv-hero-product figcaption')?.textContent).toContain('Search mail, switch views, and try archiving.');
    expect(dom.window.document.querySelector('.mv-hero-product figcaption')?.textContent).toContain('3 accounts · 300 sample emails');
    expect(dom.window.document.querySelector('.mv-hero-product figcaption')?.textContent).toContain('No signup. No installation.');
    expect(dom.window.document.querySelector('.mv-hero-product figcaption a')).toBeNull();
    expect(html).not.toMatch(/<iframe[^>]+demo|<(?:link|script)[^>]+(?:prefetch|preload|modulepreload)[^>]+demo|<script[^>]+\/demo\/assets\//i);
  });
});

describe('demo navigation and locale handoff', () => {
  it('makes every English demo link a named separate-window handoff', () => {
    const links = englishPages().flatMap((file) => Array.from(new JSDOM(readFileSync(file, 'utf8')).window.document.querySelectorAll('a[href^="/demo/"]')));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute('href')).toBe('/demo/?lang=en');
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toContain('noopener');
      expect(link.getAttribute('aria-label')).toMatch(/new window/i);
    }
  });

  it.each(LOCALES)('renders the app locale code for $dir', (locale) => {
    const source = '<a href="/demo/?lang=en" target="_blank" rel="noopener" aria-label="Open the MailVault demo in a new window">Try the demo</a>';
    const output = render(source, 'index.html', locale, {});
    expect(output).toContain(`/demo/?lang=${locale.app}`);
  });

  it.each(LOCALES)('localizes captured preview assets for $dir', (locale) => {
    const source = '<img src="/demo/assets/demo-preview-en-light-wide-abc123456789.webp" srcset="/demo/assets/demo-preview-en-light-compact-abc123456789.webp 720w">';
    const output = render(source, 'index.html', locale, {});
    const manifest = JSON.parse(readFileSync(resolve(root, 'demo-preview-manifest.json'), 'utf8'));
    expect(output).toContain(`/demo/assets/${manifest[`${locale.dir}-light-wide`]}`);
    expect(output).toContain(`/demo/assets/${manifest[`${locale.dir}-light-compact`]}`);
  });

  it.each(LOCALES)('ships the localized homepage handoff for $dir', (locale) => {
    const html = read(`${locale.dir}/index.html`);
    const link = new JSDOM(html).window.document.querySelector('.mv-demo-card .mv-shot');
    expect(link?.getAttribute('href')).toBe(`/demo/?lang=${locale.app}`);
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(html).toContain('mv-demo-caption');
  });
});

describe('static cache policy', () => {
  it('caches hashed demo assets for seven days and validates HTML', () => {
    expect(cacheControlForPath('/demo/assets/index-abc123.js')).toBe('public, max-age=604800, immutable');
    expect(cacheControlForPath('/demo/assets/index-abc123.js?v=1')).toBe('public, max-age=604800, immutable');
    expect(cacheControlForPath('/demo/assets/index-abc123.css')).toBe('public, max-age=604800, immutable');
    expect(cacheControlForPath('/demo/index.html')).toBe('no-cache');
    expect(cacheControlForPath('/demo/')).toBe('no-cache');
    expect(cacheControlForPath('/index.html')).toBe('no-cache');
  });

  it('retains hashed demo assets through the eight-day grace window', () => {
    const now = Date.parse('2026-09-12T00:00:00Z');
    expect(shouldRetainDemoAsset('/var/www/mailvaultapp/demo/assets/index-abc123.js', now - 8 * 86400000, now)).toBe(true);
    expect(shouldRetainDemoAsset('/var/www/mailvaultapp/demo/assets/index-abc123.js', now - 8 * 86400000 - 1, now)).toBe(false);
    expect(shouldRetainDemoAsset('/var/www/mailvaultapp/demo/index.html', now - 99 * 86400000, now)).toBe(false);
  });

  it('retains active old chunks and ages retired chunks from retirement', () => {
    const now = Date.parse('2026-09-12T00:00:00Z');
    const active = '/demo/assets/shared-old-abc123.js';
    const retired = '/demo/assets/retired-old-def456.js';
    const expired = '/demo/assets/expired-old-ghi789.js';
    const keep = retainedDemoAssets({
      current: [active],
      previous: [active, retired, expired],
      retiredAt: { [retired]: now - 7 * 86400000, [expired]: now - 9 * 86400000 },
      nowMs: now,
    });
    expect(keep).toEqual(new Set([active, retired]));
  });

  it('keeps deployment retention and cache policy coupled to the workflow', () => {
    const workflow = readFileSync('.github/workflows/deploy-website.yml', 'utf8');
    expect(workflow).toContain("--exclude='demo/assets/'");
    expect(workflow).toContain('Cache-Control \\\"public, max-age=604800, immutable\\\"');
    expect(workflow).toContain('Cache-Control \\\"no-cache\\\"');
    expect(workflow).toContain('mmin +11520');
    expect(workflow).toContain('grep -Fxq "$name" "$MANIFEST"');
  });
});

describe('Caddy 404 patch', () => {
  const workflow = readFileSync('.github/workflows/deploy-website.yml', 'utf8');
  const stepMatch = workflow.match(/- name: Ensure Caddy returns 404 for missing pages[\s\S]*?\n {10}SCRIPT\n/);
  const stepText = stepMatch ? stepMatch[0] : '';
  const snipMatch = stepText.match(/^\s*SNIP=(\S+)$/m);
  const snip = snipMatch ? snipMatch[1] : null;
  const awkMatch = stepText.match(/awk '([\s\S]*?)' "\$CF"/);
  const program = awkMatch ? awkMatch[1] : null;
  const printMatch = stepText.match(/print "(\s*import \S+)"/);
  const printedImportLine = printMatch ? printMatch[1].trim() : null;
  const fixture = resolve('tests/fixtures/caddy/mailvaultapp.caddyfile');
  const oldTryFiles = 'try_files {path} {path}.html {path}/ /index.html';
  const newTryFiles = 'try_files {path} {path}.html {path}/';

  function withTmpDir(fn) {
    const dir = mkdtempSync(join(tmpdir(), 'mv-caddy-'));
    try {
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('adds the step with an absolute-path snippet and an awk program', () => {
    expect(stepText).not.toBe('');
    expect(program).toBeTruthy();
    expect(snip).toBe('/etc/caddy/mailvault-404.caddy');
  });

  it('imports the snippet by absolute path, both in the awk insert and the idempotence guard', () => {
    // Regression for a live-deploy failure: Caddy resolves a relative `import`
    // against the importing file's directory, and the step validates a copy
    // living elsewhere, so a relative import broke `caddy validate` on every run.
    expect(printedImportLine).toBe(`import ${snip}`);
    expect(stepText).toContain('grep -qF "import $SNIP" "$CF"');
  });

  it('validates and installs next to the real Caddyfile, not in /tmp', () => {
    expect(stepText).toContain('caddy validate --config "$CF.new" --adapter caddyfile');
    expect(stepText).not.toContain('/tmp/Caddyfile.new');
  });

  it('writes the snippet heredoc before checking the early-exit guard, so a snippet-only change is not skipped', () => {
    const catIdx = stepText.indexOf('cat > "$NEW"');
    const guardIdx = stepText.indexOf('grep -qF "import $SNIP" "$CF" && cmp -s "$NEW" "$SNIP"');
    expect(catIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(catIdx).toBeLessThan(guardIdx);
  });

  it('rewrites try_files and inserts the absolute import before handle /api/*, leaving everything else untouched', () => {
    const before = readFileSync(fixture, 'utf8');
    const out = execFileSync('awk', [program, fixture], { encoding: 'utf8' });

    expect(out).not.toContain(oldTryFiles);
    expect(out.match(new RegExp(newTryFiles.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
    expect(out.match(/import \/etc\/caddy\/mailvault-404\.caddy/g)).toHaveLength(1);
    expect(out.indexOf('import /etc/caddy/mailvault-404.caddy')).toBeLessThan(out.indexOf('handle /api/* {'));

    const beforeLines = before.split('\n');
    const outWithoutImport = out.split('\n').filter((l) => l.trim() !== 'import /etc/caddy/mailvault-404.caddy');
    expect(outWithoutImport).toHaveLength(beforeLines.length);
    outWithoutImport.forEach((line, i) => {
      if (beforeLines[i].includes(oldTryFiles)) {
        expect(line.trim()).toBe(newTryFiles);
      } else {
        expect(line).toBe(beforeLines[i]);
      }
    });
  });

  it('fails loudly instead of installing a half-patched file when an anchor is missing', () => {
    const base = readFileSync(fixture, 'utf8');
    withTmpDir((dir) => {
      const tmpNoTryFiles = join(dir, 'no-tryfiles.caddyfile');
      const tmpNoApi = join(dir, 'no-api.caddyfile');
      writeFileSync(tmpNoTryFiles, base.split('\n').filter((l) => !l.includes(oldTryFiles)).join('\n'));
      writeFileSync(tmpNoApi, base.split('\n').filter((l) => !l.includes('handle /api/* {')).join('\n'));
      expect(() => execFileSync('awk', [program, tmpNoTryFiles], { encoding: 'utf8' })).toThrow();
      expect(() => execFileSync('awk', [program, tmpNoApi], { encoding: 'utf8' })).toThrow();
    });
  });

  it('replaces only the exact live try_files line, leaving a similar decoy line from another site block untouched', () => {
    const decoyBlock = 'other.example.com {\n    handle {\n        try_files {path} {path}.html {path}/index.html\n    }\n}\n';
    const base = readFileSync(fixture, 'utf8');
    withTmpDir((dir) => {
      const tmpPath = join(dir, 'with-decoy.caddyfile');
      writeFileSync(tmpPath, decoyBlock + base);
      const out = execFileSync('awk', [program, tmpPath], { encoding: 'utf8' });
      const outLines = out.split('\n');
      expect(outLines.filter((l) => l.trim() === 'try_files {path} {path}.html {path}/index.html')).toHaveLength(1);
      expect(outLines.filter((l) => l.trim() === newTryFiles)).toHaveLength(1);
    });
  });

  it('covers exactly the locales exported by i18n.mjs, in order, so a new locale cannot silently get the English 404', () => {
    const alt = stepText.match(/\^\/\(([a-z-]+(?:\|[a-z-]+)*)\)\//);
    expect(alt).toBeTruthy();
    expect(alt[1].split('|')).toEqual(LOCALES.map((l) => l.dir));
  });

  it('every 404 page the snippet can rewrite to actually exists', () => {
    expect(existsSync(resolve(root, '404.html'))).toBe(true);
    for (const { dir } of LOCALES) {
      expect(existsSync(resolve(root, dir, '404.html'))).toBe(true);
    }
  });
});

it('keeps the homepage demo handoff source strings in the corpus', () => {
  const corpus = JSON.parse(readFileSync(resolve(root, 'i18n/corpus.json'), 'utf8'));
  const strings = Object.values(corpus).flatMap((chunk) => Object.entries(chunk));
  for (const text of ['A real inbox. Ready to explore.', 'Search mail, switch views, and try archiving.', 'Interactive demo', 'Open the demo', 'Open the demo in a new window', 'Try the live demo in a new window', '3 accounts · 300 sample emails', 'No signup. No installation.', 'Try the live demo ↗']) {
    expect(strings).toContainEqual([keyOf(text), text]);
  }
});
