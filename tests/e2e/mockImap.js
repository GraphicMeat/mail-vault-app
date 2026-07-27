/**
 * Mock IMAP harness for the E2E suite.
 *
 * Same server the Rust tests use (`src-mock-imap`), driven through its stdin
 * scenario binary: the connected-* specs run against scripted mailboxes on
 * loopback instead of a real provider — no credentials, no network, no chance
 * of a test mutating a real inbox.
 *
 * The app skips its TLS wrap for loopback when `MAILVAULT_IMAP_PLAINTEXT=1`,
 * and reads credentials from a file when `MAILVAULT_TEST_CREDENTIALS` is set,
 * so a seeded account boots straight into the mock (see wdio.conf.js).
 */

import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const SERVER_BIN = join(REPO_ROOT, 'target/debug/mock-imap-server');

/** Build the mock server binary once per run. Cargo no-ops when it's current. */
export function buildMockServer() {
  execFileSync('cargo', ['build', '-p', 'mock-imap', '--bin', 'mock-imap-server'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (!existsSync(SERVER_BIN)) {
    throw new Error(`mock-imap-server missing after build: ${SERVER_BIN}`);
  }
  return SERVER_BIN;
}

/**
 * Start a mock IMAP server on a random loopback port.
 * @param {object} scenario - `{ state: { mailboxes, capabilities }, faults }`
 * @returns {Promise<{host: string, port: number, stop: () => void}>}
 */
export function startMockImap(scenario) {
  return new Promise((res, rej) => {
    const proc = spawn(SERVER_BIN, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      rej(new Error('mock-imap-server did not report a port within 10s'));
    }, 10_000);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const line = stdout.split('\n')[0];
      if (settled || !line.includes('}')) return;
      settled = true;
      clearTimeout(timer);
      const { port } = JSON.parse(line);
      res({
        host: '127.0.0.1',
        port,
        stop() {
          proc.kill('SIGTERM');
          setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 1000);
        },
      });
    });

    proc.stderr.on('data', (d) => console.log('[mock-imap]', d.toString().trim()));
    proc.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); rej(e); } });
    proc.on('exit', (code) => {
      if (!settled) { settled = true; clearTimeout(timer); rej(new Error(`mock-imap-server exited: ${code}`)); }
    });

    proc.stdin.end(JSON.stringify(scenario));
  });
}

// ── Scenario builders ───────────────────────────────────────────────────────
// Field names match the serde shape of `mock_imap::{Scenario, ServerState,
// Mailbox, Message}` — snake_case, all fields optional via `#[serde(default)]`.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * One date, both renderings: IMAP INTERNALDATE and the RFC 5322 `Date:` header.
 * They have to agree — the app sorts on the header and reconciles on INTERNALDATE.
 */
function stamp(dayOffset) {
  const d = new Date(Date.UTC(2026, 0, 1 + dayOffset, 12, 0, 0));
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mon = MONTHS[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  return {
    internalDate: `${dd}-${mon}-${year} 12:00:00 +0000`,
    header: `${dow}, ${dd} ${mon} ${year} 12:00:00 +0000`,
  };
}

function rfc822({ uid, to, from, subject, body, date }) {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: <mock-${uid}-${to}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    body,
    '',
  ].join('\n');
}

/**
 * A mailbox holding `count` synthetic messages.
 * Every other message is unread so read/unread affordances have something to show.
 */
export function mailbox(name, count, { owner = 'user@example.com', attrs, subjectPrefix = 'Mock message' } = {}) {
  const messages = [];
  for (let uid = 1; uid <= count; uid++) {
    // Highest UID is newest, so the list has a stable, meaningful sort order.
    const { internalDate, header } = stamp(uid);
    messages.push({
      uid,
      flags: uid % 2 === 0 ? ['\\Seen'] : [],
      internal_date: internalDate,
      modseq: uid,
      raw: rfc822({
        uid,
        to: owner,
        from: `Sender ${uid} <sender${uid}@example.com>`,
        subject: `${subjectPrefix} ${uid}`,
        body: `Body of ${subjectPrefix.toLowerCase()} ${uid} for ${owner}.`,
        date: header,
      }),
    });
  }
  return {
    name,
    attrs: attrs || ['\\HasNoChildren'],
    uid_validity: 1,
    uid_next: count + 1,
    highest_modseq: count + 1,
    messages,
  };
}

/**
 * Default account mailbox set: INBOX plus the special-use folders the
 * archive / move-to-folder / compose specs expect to find.
 */
export function scenario({ owner, inbox = 40, subjectPrefix, faults = [] } = {}) {
  return {
    state: {
      mailboxes: [
        mailbox('INBOX', inbox, { owner, subjectPrefix }),
        mailbox('Sent', 5, { owner, attrs: ['\\HasNoChildren', '\\Sent'], subjectPrefix: 'Sent message' }),
        mailbox('Archive', 3, { owner, attrs: ['\\HasNoChildren', '\\Archive'], subjectPrefix: 'Archived message' }),
        mailbox('Drafts', 0, { owner, attrs: ['\\HasNoChildren', '\\Drafts'] }),
        mailbox('Trash', 0, { owner, attrs: ['\\HasNoChildren', '\\Trash'] }),
      ],
    },
    faults,
  };
}

/**
 * Slow every FETCH by `ms`. Used to hold a large mailbox in its partially
 * loaded state long enough for a spec to observe it — a loopback mock answers
 * faster than the UI can be sampled otherwise.
 */
export function slowFetch(ms) {
  return { trigger: { OnCommand: 'FETCH' }, action: { Delay: { secs: Math.floor(ms / 1000), nanos: (ms % 1000) * 1e6 } } };
}

// ── Account seeding ─────────────────────────────────────────────────────────

/** Where the app and daemon put their data under a given HOME. */
export function appDataDir(home, platform = process.platform) {
  return platform === 'darwin'
    ? join(home, 'Library/Application Support/com.mailvault.app')
    : join(home, '.local/share/com.mailvault.app');
}

/**
 * Account blob in the shape `db.saveAccount` persists — the credentials file and
 * accounts.json are exactly what the app would have written itself.
 */
export function mockAccount({ id, email, port, name }) {
  return {
    id,
    name: name || email,
    email,
    password: MOCK_PASSWORD,
    imapHost: '127.0.0.1',
    imapPort: port,
    imapSecure: false,
    smtpHost: '127.0.0.1',
    smtpPort: port,
    smtpSecure: false,
    authType: 'password',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

export const MOCK_PASSWORD = 'mock-password';

/**
 * Seed accounts into an isolated app home so the app boots already connected.
 *
 * `home` is the HOME the app runs under, which is what `app_data_dir()` and the
 * daemon's `get_data_dir()` both derive from — writing here keeps the real
 * Maildir and the real keychain untouched.
 *
 * @returns {string} path to pass as MAILVAULT_TEST_CREDENTIALS
 */
export function seedAccounts(home, accounts) {
  const dataDir = appDataDir(home);

  mkdirSync(join(dataDir, 'Maildir'), { recursive: true });

  // Keychain replacement: { accountId: JSON.stringify(account) }
  const credentialsPath = join(dataDir, 'test-credentials.json');
  const credentials = Object.fromEntries(accounts.map((a) => [a.id, JSON.stringify(a)]));
  writeFileSync(credentialsPath, JSON.stringify(credentials));

  // accounts.json metadata — same secrets-stripped copy saveAccount writes.
  const metadata = accounts.map(({ password, ...rest }) => rest);
  writeFileSync(join(dataDir, 'accounts.json'), JSON.stringify(metadata, null, 2));

  return credentialsPath;
}

/**
 * Wipe the app's data dir and re-seed the same accounts.
 *
 * Specs share one HOME, and the app persists the last active account, the last
 * mailbox, and its header cache there — so whichever account a spec switched to
 * became the next spec's startup state. Resetting before each session keeps
 * specs independent of the order they run in.
 */
export function resetAppState(home, accounts) {
  stopDaemon(home);
  rmSync(appDataDir(home), { recursive: true, force: true });
  return seedAccounts(home, accounts);
}

/**
 * Stop the daemon this HOME's app started.
 *
 * The daemon outlives the app, so without this it survives into the next spec —
 * still syncing the previous spec's mailbox against a data dir that has just
 * been wiped, which starves the fresh app's own startup. Only ever kills the pid
 * recorded inside the isolated data dir.
 */
export function stopDaemon(home) {
  try {
    const pid = parseInt(readFileSync(join(appDataDir(home), 'daemon.pid'), 'utf-8').trim(), 10);
    if (pid > 0) process.kill(pid, 'SIGTERM');
    return pid;
  } catch {
    return null; // no daemon, or already gone
  }
}
