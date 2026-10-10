/**
 * S7's terminal listing, read off the vault a footage run left on disk.
 *
 *   node scripts/footage/lib/vaultListing.mjs <app HOME> > s7-vault-listing.json
 *
 * Walks <HOME>/Library/Application Support/com.mailvault.app/Maildir (regular
 * files only, symlinks skipped) and writes, as JSON: the folder layout with
 * file counts and bytes, 16 real .eml entries (name, size, mode, mtime) picked
 * evenly across the account's INBOX plus any other folder that holds mail, and
 * ready-made `ls -lh`-style lines without owner or group. Every path and number
 * is what `find` would print for that run; nothing is invented. The mailbox is
 * the fictional demo mailbox, so no real person's mail is in it.
 */
import { readdirSync, lstatSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const home = process.argv[2];
if (!home) { console.error('usage: vaultListing.mjs <app HOME>'); process.exit(2); }
const appDir = join(home, 'Library/Application Support/com.mailvault.app');
const root = join(appDir, 'Maildir');
if (!existsSync(root)) { console.log(JSON.stringify({ error: `no vault at ${root}` })); process.exit(0); }

const files = [];
const dirs = new Map();
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { walk(p); continue; }
    if (!st.isFile()) continue;
    const rel = relative(appDir, p);
    files.push({ path: rel, name, size: st.size, mode: st.mode, mtime: st.mtime.toISOString() });
    const d = relative(appDir, dir);
    const e = dirs.get(d) || { path: d, files: 0, bytes: 0 };
    e.files += 1; e.bytes += st.size;
    dirs.set(d, e);
  }
})(root);

let accounts = {};
try {
  for (const a of JSON.parse(readFileSync(join(appDir, 'accounts.json'), 'utf-8'))) accounts[a.id] = a.email;
} catch { accounts = {}; }

const emls = files.filter((f) => f.name.endsWith('.eml'));
const byDir = new Map();
for (const f of emls) {
  const d = f.path.slice(0, f.path.lastIndexOf('/'));
  if (!byDir.has(d)) byDir.set(d, []);
  byDir.get(d).push(f);
}
const uidOf = (n) => Number(n.split(/[:;]/)[0]) || 0;
for (const list of byDir.values()) list.sort((a, b) => uidOf(a.name) - uidOf(b.name));

// 16 entries: most from the biggest folder, evenly spaced; one or two from each other folder.
const WANT = 16;
const ordered = [...byDir.entries()].sort((a, b) => b[1].length - a[1].length);
const picks = [];
for (const [, list] of ordered.slice(1)) picks.push(...list.slice(-2));
const main = ordered[0]?.[1] || [];
const room = Math.max(0, WANT - Math.min(picks.length, 6));
const step = main.length / Math.max(1, room);
const mainPicks = [];
for (let i = 0; i < room && i < main.length; i++) mainPicks.push(main[Math.floor(i * step)]);
const entries = [...mainPicks, ...picks.slice(0, 6)];

const human = (n) => (n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)}K` : `${(n / 1048576).toFixed(1)}M`);
const perms = (mode) => {
  const bits = 'rwxrwxrwx';
  let s = '-';
  for (let i = 0; i < 9; i++) s += (mode & (1 << (8 - i))) ? bits[i] : '-';
  return s;
};
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const when = (iso) => {
  const d = new Date(iso);
  return `${MON[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const out = {
  version: 1,
  generatedAt: new Date().toISOString(),
  vaultRoot: '~/Library/Application Support/com.mailvault.app/Maildir',
  note: 'Real listing of the demo vault a footage run left on disk (fictional demo mailbox). Paths are relative to the app data dir. Account folders are named by account id.',
  accounts,
  totals: { files: files.length, emlFiles: emls.length, bytes: files.reduce((a, f) => a + f.size, 0) },
  layout: [...dirs.values()].sort((a, b) => a.path.localeCompare(b.path)),
  entries: entries.map((f) => ({ ...f, mode: perms(f.mode), sizeHuman: human(f.size) })),
  lsLines: entries.map((f) => `${perms(f.mode)}  ${human(f.size).padStart(6)}  ${when(f.mtime)}  ${f.path.replace(/^Maildir\//, '')}`),
  findLines: entries.map((f) => `./${f.path}`),
};
console.log(JSON.stringify(out, null, 2));
