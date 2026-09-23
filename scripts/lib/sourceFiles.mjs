import { readFileSync, readdirSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/**
 * Cross-platform stand-in for `find <dirs> -name '*.ext' [-not -path '*x*']`.
 *
 * The source-scanning tests/scripts used to shell out to `find`/`grep`, which
 * silently assumed a POSIX shell — `execSync` spawns via `cmd.exe` on
 * Windows, where neither the tool nor the quoting exists. This walks with
 * `fs.readdirSync` instead (stdlib, no shell) and always returns repo-root-
 * relative, forward-slash paths so results and offender messages read the
 * same on every OS.
 *
 * @param {string[]} dirs        repo-root-relative directories to walk
 * @param {string[]} extensions  e.g. ['.js', '.jsx']
 * @param {{exclude?: string[]}} opts  substrings that drop a path if present
 */
export function listSourceFiles(dirs, extensions, { exclude = [] } = {}) {
  const exts = new Set(extensions.map((e) => (e.startsWith('.') ? e : `.${e}`)));
  const out = new Set();
  for (const dir of dirs) {
    const abs = resolve(REPO_ROOT, dir);
    let names;
    try {
      names = readdirSync(abs, { recursive: true });
    } catch {
      continue;
    }
    for (const name of names) {
      if (!exts.has(extname(name))) continue;
      const rel = `${dir}/${name}`.split(sep).join('/');
      if (exclude.some((x) => rel.includes(x))) continue;
      out.add(rel);
    }
  }
  return [...out].sort();
}

/**
 * Cross-platform stand-in for `grep -rn <pattern> <dirs> | grep -v <exclude>`.
 * Returns `"path:line: content"` strings, filtered the way piped `grep -v`
 * calls were: a line is dropped if the FORMATTED line contains any exclude
 * substring (matches on the path as much as the content — the original greps
 * relied on that to skip whole files by name).
 *
 * @param {string[]} dirs
 * @param {string[]} extensions
 * @param {RegExp} pattern     tested per line (must not be sticky/global-stateful across lines)
 * @param {{exclude?: string[]}} opts
 */
export function grepSource(dirs, extensions, pattern, { exclude = [] } = {}) {
  const files = listSourceFiles(dirs, extensions);
  const out = [];
  for (const rel of files) {
    const src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (!pattern.test(line)) return;
      const formatted = `${rel}:${i + 1}:${line}`;
      if (exclude.some((x) => formatted.includes(x))) return;
      out.push(formatted);
    });
  }
  return out;
}
