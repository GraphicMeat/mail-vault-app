/**
 * The locale homepages copy softwareVersion and datePublished from the English
 * page, and a test compares them byte for byte. A bump that stamps only the
 * English page leaves main red until someone rebuilds them by hand, which is
 * what happened after v2.20.0, v2.21.0 and v2.21.1.
 *
 * Runs the real script in a throwaway repo, with a stub in place of i18n.mjs.
 * BSD sed makes the script Mac only, the same as a release.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const homepage = (version, date) => `<script type="application/ld+json">
{
    "softwareVersion": "${version}",
    "datePublished": "${date}",
    "offers": []
}
</script>
`;

// Builds each locale page from the English page as it stands when build runs.
const BUILD_STUB = `import fs from 'node:fs';
const en = fs.readFileSync('website/index.html', 'utf8');
for (const dir of ['de', 'ja']) fs.writeFileSync(\`website/\${dir}/index.html\`, en);
fs.writeFileSync('website/de/about.html', 'drift from an English edit nobody built\\n');
fs.writeFileSync('website/sitemap.xml', '<urlset>rebuilt</urlset>\\n');
`;

// A build that writes nothing, as a frozen page or a broken generator would.
const STALE_STUB = '';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(buildStub) {
  const root = mkdtempSync(join(tmpdir(), 'mv-bump-'));
  roots.push(root);
  const old = homepage('1.2.3', '2020-01-01');
  const files = {
    'package.json': '{\n  "version": "1.2.3"\n}\n',
    'package-lock.json': '{\n  "version": "1.2.3",\n  "packages": { "": { "version": "1.2.3" } }\n}\n',
    'src-tauri/Cargo.toml': '[package]\nname = "mailvault"\nversion = "1.2.3"\n',
    'src-tauri/tauri.conf.json': '{\n  "version": "1.2.3"\n}\n',
    'snap/snapcraft.yaml': "version: '1.2.3'\n",
    'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n- A fix\n',
    'index.html': old,
    'website/index.html': old,
    'website/de/index.html': old,
    'website/de/about.html': 'about\n',
    'website/ja/index.html': old,
    'website/sitemap.xml': '<urlset>old</urlset>\n',
    'website/i18n/i18n.mjs': buildStub,
    // No registry: Cargo.lock is not what this covers.
    'stub-bin/cargo': '#!/bin/sh\nexit 0\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  chmodSync(join(root, 'stub-bin/cargo'), 0o755);
  mkdirSync(join(root, 'scripts'));
  cpSync('scripts/bump-version.sh', join(root, 'scripts/bump-version.sh'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const run = spawnSync('bash', ['scripts/bump-version.sh', 'patch'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(root, 'stub-bin')}:${process.env.PATH}` },
  });
  return { root, run, git, read: (rel) => readFileSync(join(root, rel), 'utf8') };
}

describe.skipIf(process.platform !== 'darwin')('bump-version.sh', () => {
  it('stamps the homepage with the new version and the changelog date', () => {
    const { run, read } = fixture(BUILD_STUB);
    expect(run.status, run.stderr + run.stdout).toBe(0);
    const date = read('CHANGELOG.md').match(/\[1\.2\.4\] - (\d{4}-\d{2}-\d{2})/)[1];
    expect(read('website/index.html')).toBe(homepage('1.2.4', date));
    expect(read('index.html')).toBe(read('website/index.html'));
  });

  it('rebuilds the locale homepages from the stamped page', () => {
    const { run, read } = fixture(BUILD_STUB);
    expect(run.status, run.stderr + run.stdout).toBe(0);
    for (const dir of ['de', 'ja']) expect(read(`website/${dir}/index.html`)).toBe(read('website/index.html'));
    expect(read('website/sitemap.xml')).toContain('rebuilt');
  });

  it('stages what the release commit would otherwise leave behind, and no other page', () => {
    const { run, git } = fixture(BUILD_STUB);
    expect(run.status, run.stderr + run.stdout).toBe(0);
    const staged = git('diff', '--cached', '--name-only').trim().split('\n');
    expect(staged).toEqual(expect.arrayContaining(['website/de/index.html', 'website/ja/index.html', 'website/sitemap.xml']));
    // Older drift stays visible in the tree instead of riding along in a release.
    expect(staged).not.toContain('website/de/about.html');
    expect(git('status', '--porcelain', '--', 'website/de/about.html').trim()).toBe('M website/de/about.html');
  });

  it('fails the bump when a locale homepage still names the old version', () => {
    const { run } = fixture(STALE_STUB);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('website/de/index.html does not contain version 1.2.4');
  });
});
