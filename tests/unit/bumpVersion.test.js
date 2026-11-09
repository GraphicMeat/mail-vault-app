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

const PLIST = (version, code) => `<dict>
	<key>CFBundleShortVersionString</key>
	<string>${version}</string>
	<key>CFBundleVersion</key>
	<string>${code}</string>
</dict>
`;
const PROJECT_YML = (version, code) => `        CFBundleShortVersionString: ${version}
        CFBundleVersion: "${code}"
`;

function fixture(buildStub, { version = '1.2.3', bump = 'patch' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mv-bump-'));
  roots.push(root);
  const old = homepage(version, '2020-01-01');
  const files = {
    'package.json': `{\n  "version": "${version}"\n}\n`,
    'package-lock.json': `{\n  "version": "${version}",\n  "packages": { "": { "version": "${version}" } }\n}\n`,
    'src-tauri/Cargo.toml': `[package]\nname = "mailvault"\nversion = "${version}"\n`,
    'src-tauri/tauri.conf.json': `{\n  "version": "${version}"\n}\n`,
    'snap/snapcraft.yaml': `version: '${version}'\n`,
    'src-tauri-mobile/gen/apple/project.yml': PROJECT_YML('0.0.1', '1'),
    'src-tauri-mobile/gen/apple/mailvault-mobile_iOS/Info.plist': PLIST('0.0.1', '1'),
    'src-tauri-mobile/version.properties': 'versionName=0.0.1\nversionCode=1\n',
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
  const run = spawnSync('bash', ['scripts/bump-version.sh', bump], {
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

// CFBundleVersion and versionCode are one number, MAJOR*1_000_000 + MINOR*10_000 + PATCH*100 + BUILD,
// so a store never sees it go down. The script writes build 0; MV_BUILD (0..99) is added at release.
describe.skipIf(process.platform !== 'darwin')('mobile build number', () => {
  const code = (m, n, p, b = 0) => m * 1_000_000 + n * 10_000 + p * 100 + b;

  it('follows the formula in every mobile version file', () => {
    const { run, read } = fixture(BUILD_STUB);
    expect(run.status, run.stderr + run.stdout).toBe(0);
    expect(code(1, 2, 4)).toBe(1020400);
    expect(read('src-tauri-mobile/version.properties')).toContain('versionName=1.2.4\nversionCode=1020400\n');
    expect(read('src-tauri-mobile/gen/apple/project.yml')).toBe(PROJECT_YML('1.2.4', '1020400'));
    expect(read('src-tauri-mobile/gen/apple/mailvault-mobile_iOS/Info.plist')).toBe(PLIST('1.2.4', '1020400'));
  });

  it('only increases, across patch, minor and major bumps, even at MV_BUILD 99', () => {
    const cases = [
      ['patch', '1.2.9', 1020900, 1021000],
      ['minor', '1.2.9', 1020900, 1030000],
      ['major', '1.99.99', 1999900, 2000000],
    ];
    for (const [bump, version, before, after] of cases) {
      const { run, read } = fixture(BUILD_STUB, { version, bump });
      expect(run.status, run.stderr + run.stdout).toBe(0);
      expect(read('src-tauri-mobile/version.properties')).toContain(`versionCode=${after}\n`);
      expect(after).toBeGreaterThan(before + 99);
    }
  });

  it('refuses a version the formula cannot hold', () => {
    const { run } = fixture(BUILD_STUB, { version: '1.2.99', bump: 'patch' });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('<= 99');
  });
});

describe('mobile-release.sh dry run', () => {
  const dry = (platform, env = {}) => {
    const base = { ...process.env, ...env };
    for (const k of ['MV_BUILD', 'APPLE_TEAM_ID', 'MV_ANDROID_KEYSTORE', 'MV_ANDROID_KEYSTORE_PASSWORD', 'MV_ANDROID_KEY_ALIAS', 'MV_ANDROID_KEY_PASSWORD']) {
      if (!(k in env)) delete base[k];
    }
    return spawnSync('bash', ['scripts/mobile-release.sh', platform, '--dry-run'], { encoding: 'utf8', env: base });
  };
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const [major, minor, patch] = version.split('.').map(Number);
  const number = major * 1_000_000 + minor * 10_000 + patch * 100;

  it('lists the .ipa it would produce without any secret in the environment', () => {
    const run = dry('ios');
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(`dist-release/MailVault-${version}-${number}.ipa`);
    expect(run.stdout).toContain('APPLE_TEAM_ID');
  });

  it('lists the .aab, says it is unsigned without a keystore, and adds MV_BUILD', () => {
    const run = dry('android', { MV_BUILD: '7' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(`dist-release/MailVault-${version}-${number + 7}.aab`);
    expect(run.stdout).toContain('UNSIGNED');
  });

  it('rejects a build outside 0..99', () => {
    expect(dry('android', { MV_BUILD: '100' }).status).not.toBe(0);
    expect(dry('android', { MV_BUILD: 'x' }).status).not.toBe(0);
  });

  it('keeps the committed version files at the package version build 0 number', () => {
    expect(readFileSync('src-tauri-mobile/version.properties', 'utf8')).toContain(`versionCode=${number}\n`);
    expect(readFileSync('src-tauri-mobile/gen/apple/project.yml', 'utf8')).toContain(`CFBundleVersion: "${number}"`);
    expect(readFileSync('src-tauri-mobile/gen/apple/mailvault-mobile_iOS/Info.plist', 'utf8')).toContain(`<string>${number}</string>`);
  });
});
