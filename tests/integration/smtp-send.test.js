import { describe, it, expect, beforeAll } from 'vitest';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env.test
const envPath = resolve(import.meta.dirname, '../../.env.test');
const envContent = readFileSync(envPath, 'utf-8');
const env = Object.fromEntries(
  envContent
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => {
      const [key, ...rest] = line.split('=');
      return [key.trim(), rest.join('=').trim()];
    })
);

const TEST_EMAIL = env.TEST_EMAIL;
const TEST_PASSWORD = env.TEST_PASSWORD;
const IMAP_HOST = env.IMAP_HOST;
const IMAP_PORT = Number(env.IMAP_PORT) || 993;
const SMTP_HOST = env.SMTP_HOST;
const SMTP_PORT = Number(env.SMTP_PORT) || 587;

function createImapClient() {
  return new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: TEST_EMAIL, pass: TEST_PASSWORD },
    logger: false,
    connectTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 30000,
  });
}

describe('SMTP Send Integration Tests', { timeout: 60000 }, () => {
  beforeAll(() => {
    if (!TEST_EMAIL || !TEST_PASSWORD || TEST_EMAIL === 'your-email@example.com') {
      throw new Error(
        'Missing test credentials. Fill in .env.test with real email/password before running tests.'
      );
    }
  });

  it('should send an email via SMTP and verify delivery via IMAP', async () => {
    const uniqueSubject = `SMTP Test ${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let deliveredUid;

    // Send via SMTP
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: false,
      auth: { user: TEST_EMAIL, pass: TEST_PASSWORD },
      connectionTimeout: 30000,
      greetingTimeout: 30000,
    });

    const result = await transporter.sendMail({
      from: TEST_EMAIL,
      to: TEST_EMAIL,
      subject: uniqueSubject,
      text: `Automated SMTP integration test at ${new Date().toISOString()}.`,
    });

    expect(result).toBeDefined();
    expect(result.messageId).toBeDefined();
    expect(result.accepted).toContain(TEST_EMAIL);

    // Poll IMAP for delivery (up to 30 seconds)
    const maxAttempts = 6;
    const delayMs = 5000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, delayMs));

      const client = createImapClient();
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = await client.search({ subject: uniqueSubject }, { uid: true });
        if (uids.length > 0) {
          deliveredUid = uids[uids.length - 1];
          break;
        }
      } finally {
        lock.release();
        await client.logout();
      }
    }

    expect(deliveredUid).toBeDefined();

    // Clean up: delete the delivered message
    if (deliveredUid) {
      const cleanup = createImapClient();
      try {
        await cleanup.connect();
        const lock = await cleanup.getMailboxLock('INBOX');
        try {
          await cleanup.messageDelete(deliveredUid, { uid: true });
        } finally {
          lock.release();
        }
        await cleanup.logout();
      } catch {
        // best-effort cleanup
      }
    }
  });
});
