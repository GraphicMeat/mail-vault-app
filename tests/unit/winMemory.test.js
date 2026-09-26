import { describe, expect, it } from 'vitest';
import { resolve, sep } from 'node:path';
import { ownedTree, roleOf } from '../e2e/winMemory.js';

const repo = resolve('/mv/src');
const at = (...parts) => [repo, ...parts].join(sep);

describe('ownedTree', () => {
  const procs = [
    { pid: 10, ppid: 1, name: 'mailvault.exe', path: at('target', 'release', 'mailvault.exe') },
    { pid: 11, ppid: 10, name: 'msedgewebview2.exe', path: 'C:\\EdgeWebView\\msedgewebview2.exe' },
    { pid: 12, ppid: 11, name: 'msedgewebview2.exe', path: 'C:\\EdgeWebView\\msedgewebview2.exe' },
    { pid: 20, ppid: 1, name: 'mailvault-daemon.exe', path: at('target', 'release', 'mailvault-daemon.exe') },
    // An installed MailVault and its WebView2: same image names, not ours.
    { pid: 30, ppid: 1, name: 'mailvault.exe', path: 'C:\\Users\\u\\AppData\\Local\\MailVault\\mailvault.exe' },
    { pid: 31, ppid: 30, name: 'msedgewebview2.exe', path: 'C:\\EdgeWebView\\msedgewebview2.exe' },
    // Something else under the checkout (node_modules tooling) is not a root.
    { pid: 40, ppid: 1, name: 'esbuild.exe', path: at('node_modules', 'esbuild.exe') },
    // A pid that names itself as parent (System Idle) must not loop.
    { pid: 0, ppid: 0, name: 'System Idle Process', path: null },
  ];

  it('keeps our exes and their descendants, drops the installed app', () => {
    expect(ownedTree(procs, repo).map((p) => p.pid).sort((a, b) => a - b)).toEqual([10, 11, 12, 20]);
  });

  it('matches the checkout path case-insensitively', () => {
    const upper = [{ ...procs[0], path: procs[0].path.toUpperCase() }];
    expect(ownedTree(upper, repo)).toHaveLength(1);
  });

  it('does not treat a sibling directory sharing the prefix as the checkout', () => {
    const sibling = [{ pid: 1, ppid: 0, name: 'mailvault.exe', path: `${repo}-old${sep}mailvault.exe` }];
    expect(ownedTree(sibling, repo)).toEqual([]);
  });
});

describe('roleOf', () => {
  const wv = (cmd) => roleOf({ name: 'msedgewebview2.exe', cmd });

  it('names each WebView2 process by its job', () => {
    expect(wv('"msedgewebview2.exe" --embedded-browser-webview=1')).toBe('msedgewebview2 (browser)');
    expect(wv('"msedgewebview2.exe" --type=renderer --lang=en')).toBe('msedgewebview2 (renderer)');
    expect(wv('"msedgewebview2.exe" --type=gpu-process')).toBe('msedgewebview2 (gpu-process)');
    expect(wv('"msedgewebview2.exe" --type=utility --utility-sub-type=network.mojom.NetworkService'))
      .toBe('msedgewebview2 (utility: Network)');
  });

  it('strips .exe from everything else', () => {
    expect(roleOf({ name: 'mailvault-daemon.exe', cmd: 'x' })).toBe('mailvault-daemon');
  });
});
