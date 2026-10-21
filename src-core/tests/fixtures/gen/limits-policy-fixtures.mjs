#!/usr/bin/env node
// Regenerates the parity fixtures of Phase 1 row 5 (limits and policy):
//   src-core/tests/fixtures/transfer-limits-cases.json   (src-core/src/transfer_limits.rs)
//   src-core/tests/fixtures/vault-dir-mailbox-cases.json (src-core/src/search_index/text.rs)
//
// The expected values come from the OLD JavaScript, read out of git at BASE
// (local main when the move started), not from the Rust: `src/utils/transferLimits.js`
// for the limits, the warning loop of `src/components/TransferLimitBanner.jsx`
// (transcribed below, it lived inside a component), and `mailboxPathFromVaultDir`
// of `src/stores/slices/unifiedHelpers.js` (the unix spelling: no Windows
// reserved-name suffix).
//
// Usage, from the repo root (needs git history holding BASE):
//   node src-core/tests/fixtures/gen/limits-policy-fixtures.mjs
// then `git diff --exit-code src-core/tests/fixtures` shows nothing changed.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BASE = '65040308f';

const show = (path) => execFileSync('git', ['show', `${BASE}:${path}`], { encoding: 'utf8' });
const dir = mkdtempSync(join(tmpdir(), 'mv-limits-'));
writeFileSync(join(dir, 'transferLimits.mjs'), show('src/utils/transferLimits.js'));
const helpers = show('src/stores/slices/unifiedHelpers.js');
const from = helpers.indexOf('const VAULT_UNSAFE_RE');
const end = helpers.indexOf('\n}\n', helpers.indexOf('export function mailboxPathFromVaultDir'));
if (from < 0 || end < 0) throw new Error('unifiedHelpers.js no longer holds the vault dir functions this script expects');
// The unix side: `isWindowsPlatform` is false where there is no navigator.
writeFileSync(join(dir, 'vaultDir.mjs'), `${helpers.slice(from, end + 3)}\n`);
const { isGmailAccount, providerDefaultBytes, resolveDailyLimitBytes } = await import(pathToFileURL(join(dir, 'transferLimits.mjs')).href);
const { mailboxPathFromVaultDir } = await import(pathToFileURL(join(dir, 'vaultDir.mjs')).href);
rmSync(dir, { recursive: true, force: true });

const MB = 1024 * 1024;

// TransferLimitBanner.jsx at BASE, the body of its per-account loop: warn on
// the worse direction at or over 80% of the resolved limit; a missing entry
// warns, `warnEnabled: false` never does, and a 0 or absent limit never warns.
function bannerWarning(entry, gmail, today) {
  const warnEnabled = entry?.warnEnabled !== false;
  if (!warnEnabled) return null;
  const down = resolveDailyLimitBytes(entry, gmail, 'down');
  const up = resolveDailyLimitBytes(entry, gmail, 'up');
  let worst = null;
  if (down.limitBytes) {
    const pct = today.down / down.limitBytes;
    if (pct >= 0.8) worst = { pct, direction: 'download' };
  }
  if (up.limitBytes) {
    const pct = today.up / up.limitBytes;
    if (pct >= 0.8 && (!worst || pct > worst.pct)) worst = { pct, direction: 'upload' };
  }
  return worst ? { direction: worst.direction, fraction: worst.pct } : null;
}

const HOSTS = [
  'imap.gmail.com', 'IMAP.GMAIL.COM', 'IMAP.GoogleMail.com', 'imap.googlemail.com',
  'imap.hostinger.com', 'outlook.office365.com', '', 'mail.notgmail.example', 'gmail',
];

const ENTRIES = {
  missing: undefined,
  empty: {},
  cap_off_blank: { capEnabled: false },
  cap_on_blank: { capEnabled: true },
  cap_on_down_set: { capEnabled: true, dailyDownLimitBytes: 100 * MB },
  cap_off_down_set: { capEnabled: false, dailyDownLimitBytes: 100 * MB },
  cap_on_up_set: { capEnabled: true, dailyUpLimitBytes: 50 * MB },
  both_set: { capEnabled: true, dailyDownLimitBytes: 300 * MB, dailyUpLimitBytes: 40 * MB },
  down_and_up: { capEnabled: true, dailyDownLimitBytes: 100 * MB, dailyUpLimitBytes: 50 * MB },
  explicit_zero: { capEnabled: true, dailyDownLimitBytes: 0, dailyUpLimitBytes: 0 },
  null_fields: { capEnabled: true, dailyDownLimitBytes: null, dailyUpLimitBytes: null },
  warn_off: { warnEnabled: false, capEnabled: true },
  warn_on: { warnEnabled: true, capEnabled: false },
};
const LIMIT_HOSTS = ['imap.gmail.com', 'imap.hostinger.com'];
const withEntry = (entry) => (entry === undefined ? {} : { entry });

const limitCases = [];
for (const [name, entry] of Object.entries(ENTRIES)) {
  for (const host of LIMIT_HOSTS) {
    const gmail = isGmailAccount({ imapHost: host });
    const side = (direction) => ({
      ...resolveDailyLimitBytes(entry, gmail, direction),
      defaultCapOn: providerDefaultBytes(gmail, true, direction),
      defaultCapOff: providerDefaultBytes(gmail, false, direction),
    });
    limitCases.push({ name: `${name}@${host}`, ...withEntry(entry), host, expected: { down: side('down'), up: side('up') } });
  }
}

const USAGE = {
  idle: { down: 0, up: 0 },
  down_79: { down: Math.floor(0.79 * 100 * MB), up: 0 },
  down_80: { down: 80 * MB, up: 0 },
  down_over: { down: 150 * MB, up: 0 },
  up_90: { down: 0, up: 45 * MB },
  both_down_worse: { down: 95 * MB, up: 41 * MB },
  both_up_worse: { down: 85 * MB, up: 49 * MB },
  gmail_cutoff_80: { down: 2000 * MB, up: 0 },
  gmail_default_80: { down: 1600 * MB, up: 400 * MB },
};
const warningCases = [];
for (const name of ['missing', 'cap_on_blank', 'cap_on_down_set', 'cap_on_up_set', 'down_and_up', 'explicit_zero', 'warn_off']) {
  const entry = ENTRIES[name];
  for (const host of LIMIT_HOSTS) {
    for (const [usage, today] of Object.entries(USAGE)) {
      const gmail = isGmailAccount({ imapHost: host });
      warningCases.push({ name: `${name}@${host}/${usage}`, ...withEntry(entry), host, today, expected: bannerWarning(entry, gmail, today) });
    }
  }
}

const transfer = {
  _comment: `Shared fixture for the daily transfer limits as Settings > Data usage and the warning banner show them. Expected values are the answers of src/utils/transferLimits.js and TransferLimitBanner.jsx at ${BASE}; src-core/src/transfer_limits.rs (include_str!) must match. Regenerate with node src-core/tests/fixtures/gen/limits-policy-fixtures.mjs.`,
  gmailHostCases: HOSTS.map((host) => ({ host, expected: isGmailAccount({ imapHost: host }) })),
  limitCases,
  warningCases,
};

const TREE = ['INBOX', 'INBOX.Archive', 'Projekt Nystart', 'Projekt_Nystart', '[Gmail]/Sent Mail', 'Réunions & Notes', '会議/議事録', 'INBOX.Entwürfe'];
const vaultCases = [
  ['plain', 'INBOX', TREE],
  ['dotted', 'INBOX.Archive', TREE],
  ['slash_and_space', '_Gmail__Sent_Mail', TREE],
  ['ambiguous_first_listed_wins', 'Projekt_Nystart', TREE],
  ['ambiguous_other_order', 'Projekt_Nystart', ['Projekt_Nystart', 'Projekt Nystart']],
  ['unicode_kept', 'INBOX.Entwürfe', TREE],
  ['unicode_replaced', 'Réunions___Notes', TREE],
  ['cjk', '会議_議事録', TREE],
  ['unknown_dir_is_itself', 'Old_Folder', TREE],
  ['no_mailboxes', 'INBOX', []],
  ['empty_dir', '', ['', 'INBOX']],
  ['dot_dir', '_', ['.', 'INBOX']],
].map(([name, d, mailboxes]) => ({ name, dir: d, mailboxes, expected: mailboxPathFromVaultDir(d, mailboxes.map((path) => ({ path }))) }));

const vault = {
  _comment: `Shared fixture for the vault directory to server mailbox mapping (unix names). Expected values are the answers of mailboxPathFromVaultDir in src/stores/slices/unifiedHelpers.js at ${BASE}: the first listed mailbox whose vault_dir_name is the directory, else the directory itself. src-core/src/search_index/text.rs (include_str!) must match. Regenerate with node src-core/tests/fixtures/gen/limits-policy-fixtures.mjs.`,
  cases: vaultCases,
};

// `--print`: write both files to stdout instead (a remote job's checkout is
// thrown away), each after a `=== <name>` line.
const print = process.argv.includes('--print');
const out = (name, value) => {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (print) process.stdout.write(`=== ${name}\n${text}`);
  else writeFileSync(new URL(`../${name}`, import.meta.url), text);
};
out('transfer-limits-cases.json', transfer);
out('vault-dir-mailbox-cases.json', vault);
