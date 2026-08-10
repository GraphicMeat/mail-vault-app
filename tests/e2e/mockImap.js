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
 * An HTML message quoting an earlier one — the shape MailVault's own replies
 * take (multipart/alternative, quote wrapped in <blockquote>). Every other mock
 * message is text/plain, which the app renders as React text; only an HTML body
 * reaches the iframe path, so the render spec needs one of these to exist.
 *
 * The quote is deliberately long: a folded quote has to shorten the frame by
 * more than any measurement slack for the height assertions to mean anything.
 * No In-Reply-To — this one stands alone so it opens in the single-email
 * viewer regardless of the threading setting.
 *
 * The body also carries the two inline-style shapes newsletters ship, which
 * decide whether dark mode is readable:
 *   - a heading with `color: … !important`, which outranks Dark Reader's
 *     override sheet and used to stay black on the dark background;
 *   - a brand-coloured link without `!important`, which must keep its hue.
 */
export function htmlQuotedMessage({ uid, to, from, subject, date }) {
  const boundary = 'MockMvBoundary';
  const quoteLines = Array.from(
    { length: 24 },
    (_, i) => `<p>Quoted line ${i + 1} of the message being answered.</p>`,
  ).join('');
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: <mock-html-${uid}-${to}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'Short answer above the quote.',
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    '',
    '<p>Short answer above the quote.</p>'
      + `<h2 id="${DARK_HEADING_ID}" style="color:hsl(0, 0%, 0%) !important; font-size:1.3em !important; font-weight:600 !important;">Heading that ships its own colour</h2>`
      + `<a id="${DARK_BRAND_LINK_ID}" href="https://example.com/brand" style="color:#e6375a; font-weight:600;">Brand coloured link</a>`
      + '<hr>'
      + `<blockquote><p><strong>Original Message</strong></p>${quoteLines}</blockquote>`,
    '',
    `--${boundary}--`,
    '',
  ].join('\n');
}

/**
 * A mailbox holding `count` synthetic messages.
 * Every other message is unread so read/unread affordances have something to show.
 *
 * `htmlQuoted` appends one HTML message with a folded quote (see
 * `htmlQuotedMessage`) as the newest entry.
 */
export function mailbox(name, count, { owner = 'user@example.com', attrs, subjectPrefix = 'Mock message', htmlQuoted = false } = {}) {
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
  if (htmlQuoted) {
    const uid = count + 1;
    const { internalDate, header } = stamp(uid);
    messages.push({
      uid,
      flags: [],
      internal_date: internalDate,
      modseq: uid,
      raw: htmlQuotedMessage({
        uid,
        to: owner,
        from: `Quoting Sender <quoted@example.com>`,
        subject: HTML_QUOTED_SUBJECT,
        date: header,
      }),
    });
  }
  return {
    name,
    attrs: attrs || ['\\HasNoChildren'],
    uid_validity: 1,
    uid_next: messages.length + 1,
    highest_modseq: messages.length + 1,
    messages,
  };
}

/** Subject of the HTML-quoted message, so specs can find its row. */
export const HTML_QUOTED_SUBJECT = 'HTML render check';

/** Ids of the two dark-mode probes inside that message's HTML body. */
export const DARK_HEADING_ID = 'mv-dark-important-heading';
export const DARK_BRAND_LINK_ID = 'mv-dark-brand-link';

// ── Threaded messages for the wrong-mailbox regression ──────────────────────
// A UID identifies a message only inside one mailbox: Sent UID 6 and INBOX UID
// 6 are different messages. These conversations put a message in a folder that
// is not the one on screen, so a body resolved against the active view instead
// of the message's own folder renders visibly wrong content.

export const SENT_THREAD_SUBJECT = 'Sent folder thread check';
export const SENT_THREAD_BODY = 'Sent folder thread body';
export const CROSS_FOLDER_SUBJECT = 'Cross folder thread check';
export const CROSS_FOLDER_INBOX_BODY = 'Cross folder inbox body';
export const CROSS_FOLDER_SENT_BODY = 'Cross folder sent reply body';

/** One message with an explicit Message-ID / In-Reply-To, so threads form. */
function threadMessage({ uid, owner, from, subject, body, messageId, inReplyTo, day }) {
  const { internalDate, header } = stamp(day);
  const lines = [
    `From: ${from}`,
    `To: ${owner}`,
    `Subject: ${subject}`,
    `Date: ${header}`,
    `Message-ID: <${messageId}>`,
  ];
  if (inReplyTo) {
    lines.push(`In-Reply-To: <${inReplyTo}>`, `References: <${inReplyTo}>`);
  }
  lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '', body, '');
  return {
    uid,
    flags: ['\\Seen'],
    internal_date: internalDate,
    modseq: uid,
    raw: lines.join('\n'),
  };
}

/** Append messages to a mailbox and keep its UID/MODSEQ bookkeeping honest. */
function append(box, messages) {
  box.messages.push(...messages);
  const maxUid = box.messages.reduce((max, m) => Math.max(max, m.uid), 0);
  box.uid_next = maxUid + 1;
  box.highest_modseq = maxUid + 1;
  return box;
}

/**
 * Default account mailbox set: INBOX plus the special-use folders the
 * archive / move-to-folder / compose specs expect to find.
 */
export function scenario({ owner, inbox = 40, subjectPrefix, htmlQuoted = false, crossFolderThread = true, faults = [] } = {}) {
  const inboxBox = mailbox('INBOX', inbox, { owner, subjectPrefix, htmlQuoted });
  const sentBox = mailbox('Sent', 5, { owner, attrs: ['\\HasNoChildren', '\\Sent'], subjectPrefix: 'Sent message' });

  // `inbox: 0` means an empty INBOX to the integration harness — leave it alone.
  if (inbox > 0) {
    // A conversation living entirely in Sent. Its UIDs (6, 7) also exist in
    // INBOX and hold unrelated messages.
    append(sentBox, [
      threadMessage({
        uid: 6, owner, from: owner, subject: SENT_THREAD_SUBJECT,
        body: `${SENT_THREAD_BODY} one.`, messageId: `sent-thread-root@${owner}`, day: 60,
      }),
      threadMessage({
        uid: 7, owner, from: owner, subject: `Re: ${SENT_THREAD_SUBJECT}`,
        body: `${SENT_THREAD_BODY} two.`, messageId: `sent-thread-reply@${owner}`,
        inReplyTo: `sent-thread-root@${owner}`, day: 61,
      }),
    ]);

    // A conversation split across folders: the incoming message in INBOX, the
    // reply in Sent — what the INBOX list shows once Sent is merged in. Skipped
    // for the big mailbox, whose exact total is a fixture for other specs.
    if (crossFolderThread) {
      const rootUid = inboxBox.messages.reduce((max, m) => Math.max(max, m.uid), 0) + 1;
      append(inboxBox, [
        threadMessage({
          uid: rootUid, owner, from: 'Partner <partner@example.com>',
          subject: CROSS_FOLDER_SUBJECT, body: `${CROSS_FOLDER_INBOX_BODY}.`,
          messageId: `cross-folder-root@${owner}`, day: 62,
        }),
      ]);
      append(sentBox, [
        threadMessage({
          uid: 8, owner, from: owner, subject: `Re: ${CROSS_FOLDER_SUBJECT}`,
          body: `${CROSS_FOLDER_SENT_BODY}.`, messageId: `cross-folder-reply@${owner}`,
          inReplyTo: `cross-folder-root@${owner}`, day: 63,
        }),
      ]);
    }
  }

  return {
    state: {
      mailboxes: [
        inboxBox,
        sentBox,
        // connected-bulk-delete-everywhere.test.js permanently consumes account 2's
        // copy of this folder (archives, deletes-from-server, and purges its 3
        // messages) — don't assume account 2's Archive still holds 3 seeded
        // messages in a spec that runs after it alphabetically.
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
