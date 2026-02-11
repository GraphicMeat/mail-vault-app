import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------
const envPath = resolve(import.meta.dirname, '../../.env.test');
const envContent = readFileSync(envPath, 'utf-8');
const env = Object.fromEntries(
  envContent
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => {
      const [key, ...rest] = l.split('=');
      return [key.trim(), rest.join('=').trim()];
    })
);

const ACCOUNT = {
  email: env.TEST_EMAIL2, // Use Vader's mailbox as the test target
  password: env.TEST_PASSWORD2,
};
const IMAP_HOST = env.IMAP_HOST;
const IMAP_PORT = Number(env.IMAP_PORT) || 993;

const EMAIL_COUNT = 500;
const RUN_ID = Date.now();
const SUBJECT_PREFIX = `[Stress-${RUN_ID}]`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function createImap() {
  return new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: ACCOUNT.email, pass: ACCOUNT.password },
    logger: false,
    connectTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 60000,
  });
}

// Build a raw RFC 2822 message — much faster than SMTP for bulk injection
function buildRawMessage(index) {
  const types = ['plain', 'html', 'multipart', 'attachment', 'multi-attachment'];
  const type = types[index % types.length];
  const subject = `${SUBJECT_PREFIX} #${String(index).padStart(4, '0')} (${type})`;
  const date = new Date(Date.now() - (EMAIL_COUNT - index) * 60000).toUTCString();
  const boundary = `----boundary-${RUN_ID}-${index}`;

  const headers = [
    `From: "Test Sender" <${ACCOUNT.email}>`,
    `To: ${ACCOUNT.email}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: <stress-${RUN_ID}-${index}@forceunwrap.com>`,
  ];

  if (type === 'plain') {
    headers.push('Content-Type: text/plain; charset="utf-8"');
    return [...headers, '', `Plain text body for message #${index}. ${randomText()}`].join('\r\n');
  }

  if (type === 'html') {
    headers.push('Content-Type: text/html; charset="utf-8"');
    return [
      ...headers,
      '',
      `<html><body><h2>Message #${index}</h2><p>${randomText()}</p><ul><li>Item A</li><li>Item B</li></ul></body></html>`,
    ].join('\r\n');
  }

  if (type === 'multipart') {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    return [
      ...headers,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="utf-8"',
      '',
      `Plain version of message #${index}. ${randomText()}`,
      `--${boundary}`,
      'Content-Type: text/html; charset="utf-8"',
      '',
      `<html><body><p>HTML version of message <b>#${index}</b>. ${randomText()}</p></body></html>`,
      `--${boundary}--`,
    ].join('\r\n');
  }

  if (type === 'attachment') {
    const mixedBoundary = `----mixed-${RUN_ID}-${index}`;
    headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
    const fileContent = Buffer.from(`Data for file in message #${index}\n${randomText()}`).toString('base64');
    return [
      ...headers,
      '',
      `--${mixedBoundary}`,
      'Content-Type: text/plain; charset="utf-8"',
      '',
      `Message #${index} with a file attachment.`,
      `--${mixedBoundary}`,
      `Content-Type: application/octet-stream; name="data-${index}.txt"`,
      `Content-Disposition: attachment; filename="data-${index}.txt"`,
      'Content-Transfer-Encoding: base64',
      '',
      fileContent,
      `--${mixedBoundary}--`,
    ].join('\r\n');
  }

  // multi-attachment
  const mixedBoundary = `----mixed-${RUN_ID}-${index}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
  const file1 = Buffer.from(`CSV data for #${index}\nName,Value\nA,1\nB,2`).toString('base64');
  const file2 = Buffer.from(JSON.stringify({ index, type: 'test', ts: Date.now() })).toString('base64');
  // 1x1 red PNG
  const pngData =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
  return [
    ...headers,
    '',
    `--${mixedBoundary}`,
    'Content-Type: text/html; charset="utf-8"',
    '',
    `<html><body><h3>Message #${index}</h3><p>Multiple attachments enclosed.</p></body></html>`,
    `--${mixedBoundary}`,
    `Content-Type: text/csv; name="report-${index}.csv"`,
    `Content-Disposition: attachment; filename="report-${index}.csv"`,
    'Content-Transfer-Encoding: base64',
    '',
    file1,
    `--${mixedBoundary}`,
    `Content-Type: application/json; name="meta-${index}.json"`,
    `Content-Disposition: attachment; filename="meta-${index}.json"`,
    'Content-Transfer-Encoding: base64',
    '',
    file2,
    `--${mixedBoundary}`,
    `Content-Type: image/png; name="thumb-${index}.png"`,
    `Content-Disposition: attachment; filename="thumb-${index}.png"`,
    'Content-Transfer-Encoding: base64',
    '',
    pngData,
    `--${mixedBoundary}--`,
  ].join('\r\n');
}

function randomText() {
  const words = [
    'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
    'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
    'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray',
  ];
  const len = 8 + Math.floor(Math.random() * 12);
  return Array.from({ length: len }, () => words[Math.floor(Math.random() * words.length)]).join(' ');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe('Mailbox Stress Test (500 emails → local storage → server delete → verify)', { timeout: 600000 }, () => {
  const testUids = [];
  // Simulated local storage — mirrors what IndexedDB does in the app
  const localStorage = new Map();

  beforeAll(() => {
    if (!ACCOUNT.email || !ACCOUNT.password) {
      throw new Error('Missing test credentials in .env.test (TEST_EMAIL2 / TEST_PASSWORD2)');
    }
  });

  // Clean up at the end regardless of pass/fail
  afterAll(async () => {
    if (testUids.length === 0) return;
    console.log(`\n[Cleanup] Deleting ${testUids.length} test emails from server...`);
    const client = createImap();
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        // Delete in chunks to avoid command-length limits
        const chunkSize = 100;
        for (let i = 0; i < testUids.length; i += chunkSize) {
          const chunk = testUids.slice(i, i + chunkSize);
          try {
            await client.messageDelete(chunk, { uid: true });
          } catch (e) {
            console.warn(`[Cleanup] Chunk delete failed: ${e.message}`);
          }
        }
      } finally {
        lock.release();
      }
      await client.logout();
    } catch (e) {
      console.error(`[Cleanup] Failed: ${e.message}`);
    }
    console.log('[Cleanup] Done.');
  });

  // -----------------------------------------------------------------------
  // Phase 1: Inject 500 emails via IMAP APPEND
  // -----------------------------------------------------------------------
  it(`should inject ${EMAIL_COUNT} emails into the mailbox`, async () => {
    const client = createImap();
    await client.connect();

    const batchSize = 50;
    let appended = 0;

    for (let batch = 0; batch < EMAIL_COUNT; batch += batchSize) {
      const end = Math.min(batch + batchSize, EMAIL_COUNT);
      const promises = [];
      for (let i = batch; i < end; i++) {
        const raw = buildRawMessage(i);
        promises.push(
          client.append('INBOX', raw, ['\\Seen'], new Date()).catch((e) => {
            console.error(`[Append] Failed for message #${i}: ${e.message}`);
            return null;
          })
        );
      }
      const results = await Promise.all(promises);
      appended += results.filter(Boolean).length;
      if ((batch + batchSize) % 100 === 0 || end === EMAIL_COUNT) {
        console.log(`[Inject] ${appended}/${EMAIL_COUNT} appended`);
      }
    }

    await client.logout();
    expect(appended).toBe(EMAIL_COUNT);
  });

  // -----------------------------------------------------------------------
  // Phase 2: Verify all 500 exist and collect UIDs
  // -----------------------------------------------------------------------
  it('should find all 500 test emails in the mailbox', async () => {
    const client = createImap();
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ subject: SUBJECT_PREFIX }, { uid: true });
      testUids.push(...uids);
      expect(uids.length).toBe(EMAIL_COUNT);
    } finally {
      lock.release();
      await client.logout();
    }
  });

  // -----------------------------------------------------------------------
  // Phase 3: Fetch all emails and save to "local storage"
  // -----------------------------------------------------------------------
  it('should fetch and save all 500 emails to local storage', async () => {
    const chunkSize = 25;
    let fetched = 0;

    for (let i = 0; i < testUids.length; i += chunkSize) {
      const chunk = testUids.slice(i, i + chunkSize);
      const client = createImap();
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        for (const uid of chunk) {
          const msg = await client.fetchOne(uid, { source: true, envelope: true, flags: true }, { uid: true });
          const parsed = await simpleParser(msg.source);

          // Store locally — same shape as the app's db.saveEmail()
          const localId = `test-INBOX-${uid}`;
          localStorage.set(localId, {
            localId,
            uid,
            accountId: 'test',
            mailbox: 'INBOX',
            subject: msg.envelope.subject,
            from: msg.envelope.from?.[0],
            to: msg.envelope.to || [],
            date: msg.envelope.date,
            flags: Array.from(msg.flags || []),
            text: parsed.text,
            html: parsed.html,
            attachments: parsed.attachments?.map((a) => ({
              filename: a.filename,
              contentType: a.contentType,
              size: a.size,
              contentId: a.contentId,
              content: a.content.toString('base64'),
            })) || [],
            savedAt: new Date().toISOString(),
          });
          fetched++;
        }
      } finally {
        lock.release();
        await client.logout();
      }
      if (fetched % 100 === 0 || fetched === testUids.length) {
        console.log(`[Fetch+Save] ${fetched}/${testUids.length} saved locally`);
      }
    }

    expect(localStorage.size).toBe(EMAIL_COUNT);
  });

  // -----------------------------------------------------------------------
  // Phase 4: Verify local storage content integrity
  // -----------------------------------------------------------------------
  it('should have correct content in local storage', () => {
    // Check email type distribution: 5 types cycling over 500 = 100 each
    let plain = 0, html = 0, multipart = 0, attachment = 0, multiAtt = 0;

    for (const [, email] of localStorage) {
      expect(email.subject).toContain(SUBJECT_PREFIX);
      expect(email.uid).toBeDefined();
      expect(email.date).toBeDefined();
      expect(email.savedAt).toBeDefined();

      if (email.subject.includes('(plain)')) {
        plain++;
        expect(email.text).toBeTruthy();
        expect(email.html).toBeFalsy();
        expect(email.attachments).toHaveLength(0);
      } else if (email.subject.includes('(html)')) {
        html++;
        expect(email.html).toBeTruthy();
        expect(email.html).toContain('<html>');
      } else if (email.subject.includes('(multipart)')) {
        multipart++;
        expect(email.text).toBeTruthy();
        expect(email.html).toBeTruthy();
      } else if (email.subject.includes('(attachment)')) {
        attachment++;
        expect(email.attachments.length).toBe(1);
        expect(email.attachments[0].filename).toMatch(/^data-\d+\.txt$/);
      } else if (email.subject.includes('(multi-attachment)')) {
        multiAtt++;
        expect(email.attachments.length).toBe(3);
        const filenames = email.attachments.map((a) => a.filename).sort();
        expect(filenames[0]).toMatch(/^meta-\d+\.json$/);
        expect(filenames[1]).toMatch(/^report-\d+\.csv$/);
        expect(filenames[2]).toMatch(/^thumb-\d+\.png$/);
      }
    }

    expect(plain).toBe(100);
    expect(html).toBe(100);
    expect(multipart).toBe(100);
    expect(attachment).toBe(100);
    expect(multiAtt).toBe(100);
    console.log(`[Verify] Type distribution: plain=${plain} html=${html} multipart=${multipart} attachment=${attachment} multi-attachment=${multiAtt}`);
  });

  // -----------------------------------------------------------------------
  // Phase 5: Delete all test emails from the server
  // -----------------------------------------------------------------------
  it('should delete all 500 emails from the server', async () => {
    const client = createImap();
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const chunkSize = 100;
      for (let i = 0; i < testUids.length; i += chunkSize) {
        const chunk = testUids.slice(i, i + chunkSize);
        await client.messageDelete(chunk, { uid: true });
        console.log(`[Delete] ${Math.min(i + chunkSize, testUids.length)}/${testUids.length} deleted from server`);
      }
    } finally {
      lock.release();
      await client.logout();
    }
  });

  // -----------------------------------------------------------------------
  // Phase 6: Confirm server has zero test emails
  // -----------------------------------------------------------------------
  it('should confirm test emails are gone from the server', async () => {
    const client = createImap();
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const remaining = await client.search({ subject: SUBJECT_PREFIX }, { uid: true });
      expect(remaining.length).toBe(0);
    } finally {
      lock.release();
      await client.logout();
    }
  });

  // -----------------------------------------------------------------------
  // Phase 7: Verify local storage still has everything
  // -----------------------------------------------------------------------
  it('should still have all 500 emails in local storage after server deletion', () => {
    expect(localStorage.size).toBe(EMAIL_COUNT);

    // Verify each email is intact
    const savedUids = new Set([...localStorage.values()].map((e) => e.uid));
    for (const uid of testUids) {
      expect(savedUids.has(uid)).toBe(true);
    }

    // Spot-check random emails
    const entries = [...localStorage.values()];
    for (let i = 0; i < 20; i++) {
      const email = entries[Math.floor(Math.random() * entries.length)];
      expect(email.subject).toContain(SUBJECT_PREFIX);
      expect(email.localId).toBeDefined();
      expect(email.from).toBeDefined();
      expect(email.text || email.html).toBeTruthy();
    }
  });

  // -----------------------------------------------------------------------
  // Phase 8: Simulate search in local storage
  // -----------------------------------------------------------------------
  it('should be able to search local storage by subject, sender, and content', () => {
    // Search by subject keyword
    const bySubject = [...localStorage.values()].filter((e) =>
      e.subject.toLowerCase().includes('(html)')
    );
    expect(bySubject.length).toBe(100);

    // Search by sender
    const bySender = [...localStorage.values()].filter(
      (e) => e.from?.address === ACCOUNT.email
    );
    expect(bySender.length).toBe(EMAIL_COUNT);

    // Search by body content — all multipart emails contain "HTML version"
    const byBody = [...localStorage.values()].filter((e) =>
      typeof e.html === 'string' && e.html.includes('HTML version')
    );
    expect(byBody.length).toBe(100); // only 'multipart' type

    // Search attachments by filename pattern
    const withJson = [...localStorage.values()].filter((e) =>
      e.attachments?.some((a) => a.filename?.endsWith('.json'))
    );
    expect(withJson.length).toBe(100); // only 'multi-attachment' type
  });

  // -----------------------------------------------------------------------
  // Phase 9: Simulate bulk re-delete from local (like clearing local cache)
  // -----------------------------------------------------------------------
  it('should handle bulk delete from local storage', () => {
    // Delete all plain text emails from local
    const plainIds = [...localStorage.entries()]
      .filter(([, e]) => e.subject.includes('(plain)'))
      .map(([id]) => id);

    expect(plainIds.length).toBe(100);
    for (const id of plainIds) {
      localStorage.delete(id);
    }
    expect(localStorage.size).toBe(400);

    // Delete all html-only emails
    const htmlIds = [...localStorage.entries()]
      .filter(([, e]) => e.subject.includes('(html)'))
      .map(([id]) => id);
    for (const id of htmlIds) {
      localStorage.delete(id);
    }
    expect(localStorage.size).toBe(300);

    // The remaining 300 should be multipart + attachment + multi-attachment
    const types = new Set([...localStorage.values()].map((e) => {
      if (e.subject.includes('(multipart)')) return 'multipart';
      if (e.subject.includes('(attachment)')) return 'attachment';
      if (e.subject.includes('(multi-attachment)')) return 'multi-attachment';
      return 'unknown';
    }));
    expect(types.size).toBe(3);
    expect(types.has('unknown')).toBe(false);

    // Wipe remaining
    localStorage.clear();
    expect(localStorage.size).toBe(0);

    // Clear testUids so afterAll doesn't try to delete already-deleted emails
    testUids.length = 0;
  });
});
