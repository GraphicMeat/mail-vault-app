import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// The README is the GitHub landing page. Its screenshots point straight at the
// website set, so a reshoot that renames a shot, or a release that drops a
// package format, must fail here instead of on github.com.
const root = join(import.meta.dirname, '../..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const readme = read('README.md');

const localRefs = [
  ...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g),
  ...readme.matchAll(/\]\(((?!https?:|#|mailto:)[^)\s]+)\)/g),
  ...readme.matchAll(/<img[^>]+src="((?!https?:)[^"]+)"/g),
  ...readme.matchAll(/<source[^>]+srcset="((?!https?:)[^"]+)"/g),
].map((m) => m[1].split('#')[0]);
const shots = localRefs.filter((p) => p.startsWith('website/screenshots/'));

describe('README', () => {
  it('every local image and link resolves', () => {
    const missing = [...new Set(localRefs)].filter((p) => !existsSync(join(root, p)));
    expect(missing).toEqual([]);
  });

  it('shows current website shots in both themes', () => {
    expect(shots.some((p) => p.includes('-light-'))).toBe(true);
    expect(shots.some((p) => !p.includes('-light-'))).toBe(true);
  });

  it('names every platform, with the macOS floor the bundle declares', () => {
    const { minimumSystemVersion } = JSON.parse(read('src-tauri/tauri.conf.json')).bundle.macOS;
    for (const os of ['macOS', 'Windows', 'Linux']) expect(readme).toContain(os);
    expect(readme).toContain(`macOS ${parseInt(minimumSystemVersion, 10)} or later`);
  });

  it('lists only package formats the release workflow ships', () => {
    const release = read('.github/workflows/release.yml').toLowerCase();
    for (const [name, needle] of [['AppImage', 'appimage'], ['Flatpak', 'flatpak'], ['Snap', 'snapcraft'], ['.deb', '.deb']]) {
      if (readme.includes(name)) expect(release.includes(needle), `${name} is claimed but never released`).toBe(true);
    }
  });
});
