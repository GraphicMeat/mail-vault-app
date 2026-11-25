#!/usr/bin/env node
// `tauri build` refuses to run when an npm @tauri-apps package and its Rust crate
// differ in major.minor. That check only fires in the release and nightly builds,
// so a Cargo.lock bump (cargo update, an audit fix) that leaves package-lock.json
// behind used to surface hours later as a failed nightly. This runs the same
// comparison against the two lockfiles, in `npm test` and on every lockfile push.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Crate name for an npm @tauri-apps package, or null when it has no crate twin. */
export function crateFor(npmName) {
  if (npmName === '@tauri-apps/api') return 'tauri';
  const m = /^@tauri-apps\/plugin-(.+)$/.exec(npmName);
  return m ? `tauri-plugin-${m[1]}` : null;
}

/** Every version of each crate in a Cargo.lock (a crate can be locked twice). */
export function cargoVersions(cargoLock) {
  const out = new Map();
  for (const block of cargoLock.split('[[package]]')) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"/m.exec(block)?.[1];
    if (!name || !version) continue;
    if (!out.has(name)) out.set(name, []);
    out.get(name).push(version);
  }
  return out;
}

const majorMinor = (v) => v.split('.').slice(0, 2).join('.');

/** [{ npm, npmVersion, crate, crateVersions }] for each pair tauri build would reject. */
export function mismatches(cargoLock, packageLock) {
  const crates = cargoVersions(cargoLock);
  const pkgs = JSON.parse(packageLock).packages || {};
  const found = [];
  for (const [path, info] of Object.entries(pkgs)) {
    const m = /^node_modules\/(@tauri-apps\/[^/]+)$/.exec(path);
    if (!m) continue;
    const crate = crateFor(m[1]);
    const crateVersions = crate && crates.get(crate);
    if (!crateVersions) continue;
    if (!crateVersions.some((v) => majorMinor(v) === majorMinor(info.version))) {
      found.push({ npm: m[1], npmVersion: info.version, crate, crateVersions });
    }
  }
  return found;
}

export function repoMismatches(root = join(dirname(fileURLToPath(import.meta.url)), '..')) {
  return mismatches(
    readFileSync(join(root, 'Cargo.lock'), 'utf8'),
    readFileSync(join(root, 'package-lock.json'), 'utf8'),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = repoMismatches();
  for (const f of found) {
    console.error(`${f.crate} (${f.crateVersions.join(', ')}) : ${f.npm} (${f.npmVersion})`);
  }
  if (found.length) {
    console.error('Tauri npm packages and Rust crates differ in major.minor; `tauri build` will refuse. Bump the npm side: npm install <pkg>@<crate version>.');
    process.exit(1);
  }
  console.log('Tauri npm packages match their Rust crates.');
}
