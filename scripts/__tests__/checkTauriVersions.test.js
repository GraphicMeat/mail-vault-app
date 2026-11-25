import { describe, it, expect } from 'vitest';
import { crateFor, mismatches, repoMismatches } from '../check-tauri-versions.mjs';

const cargo = (pairs) => pairs.map(([n, v]) => `[[package]]\nname = "${n}"\nversion = "${v}"\nsource = "registry"\n`).join('\n');
const npm = (pairs) => JSON.stringify({
  packages: Object.fromEntries([['', { name: 'app' }], ...pairs.map(([n, v]) => [`node_modules/${n}`, { version: v }])]),
});

describe('check-tauri-versions', () => {
  it('maps npm packages to their crates', () => {
    expect(crateFor('@tauri-apps/api')).toBe('tauri');
    expect(crateFor('@tauri-apps/plugin-updater')).toBe('tauri-plugin-updater');
    expect(crateFor('@tauri-apps/cli')).toBe(null); // the CLI has no crate twin
    expect(crateFor('react')).toBe(null);
  });

  it('flags the plugin-updater split that failed the 2026-11-25 nightly', () => {
    const found = mismatches(
      cargo([['tauri', '2.12.5'], ['tauri-plugin-updater', '2.14.1']]),
      npm([['@tauri-apps/api', '2.12.4'], ['@tauri-apps/plugin-updater', '2.10.0'], ['@tauri-apps/cli', '2.12.4']]),
    );
    expect(found).toEqual([{
      npm: '@tauri-apps/plugin-updater', npmVersion: '2.10.0',
      crate: 'tauri-plugin-updater', crateVersions: ['2.14.1'],
    }]);
  });

  it('accepts a patch-level difference, as tauri build does', () => {
    expect(mismatches(cargo([['tauri', '2.12.5']]), npm([['@tauri-apps/api', '2.12.4']]))).toEqual([]);
  });

  it('this repo\'s lockfiles agree', () => {
    expect(repoMismatches()).toEqual([]);
  });
});
