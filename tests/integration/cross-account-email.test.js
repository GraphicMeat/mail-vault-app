import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
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

const LUKE = {
  email: env.TEST_EMAIL,
  password: env.TEST_PASSWORD,
};
const VADER = {
  email: env.TEST_EMAIL2,
  password: env.TEST_PASSWORD2,
};
const IMAP_HOST = env.IMAP_HOST;
const IMAP_PORT = Number(env.IMAP_PORT) || 993;
const SMTP_HOST = env.SMTP_HOST;
const SMTP_PORT = Number(env.SMTP_PORT) || 587;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function createImap(account) {
  return new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: account.email, pass: account.password },
    logger: false,
    connectTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 30000,
  });
}

function createSmtp(account) {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    auth: { user: account.email, pass: account.password },
    connectionTimeout: 30000,
    greetingTimeout: 30000,
  });
}

const RUN_ID = Date.now();
const sent = { uids: [], account: null };

async function waitForDelivery(account, subject, maxWaitMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const client = createImap(account);
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = await client.search({ subject }, { uid: true });
        if (uids.length > 0) return uids[uids.length - 1];
      } finally {
        lock.release();
      }
      await client.logout();
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Email with subject "${subject}" not delivered within ${maxWaitMs}ms`);
}

async function fetchParsed(account, uid) {
  const client = createImap(account);
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const msg = await client.fetchOne(uid, { source: true }, { uid: true });
    return await simpleParser(msg.source);
  } finally {
    lock.release();
    await client.logout();
  }
}

function trackForCleanup(account, uid) {
  sent.uids.push({ account, uid });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('Cross-Account Email Tests (Luke ↔ Vader)', () => {
  beforeAll(() => {
    if (!LUKE.email || !LUKE.password || !VADER.email || !VADER.password) {
      throw new Error('Missing test credentials in .env.test');
    }
  });

  afterAll(async () => {
    // Clean up all test emails from both accounts
    for (const { account, uid } of sent.uids) {
      const client = createImap(account);
      try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');
        try {
          await client.messageDelete(uid, { uid: true });
        } finally {
          lock.release();
        }
        await client.logout();
      } catch {
        // best-effort
      }
    }
  });

  // -----------------------------------------------------------------------
  // 1. Plain text email
  // -----------------------------------------------------------------------
  describe('Plain text email', () => {
    const subject = `[Test-${RUN_ID}] Plain text`;
    let uid;

    it('Luke sends a plain text email to Vader', async () => {
      const smtp = createSmtp(LUKE);
      const result = await smtp.sendMail({
        from: LUKE.email,
        to: VADER.email,
        subject,
        text: 'I am a Jedi, like my father before me.',
      });
      expect(result.accepted).toContain(VADER.email);
    });

    it('Vader receives the plain text email', async () => {
      uid = await waitForDelivery(VADER, subject);
      trackForCleanup(VADER, uid);
      expect(uid).toBeDefined();

      const parsed = await fetchParsed(VADER, uid);
      expect(parsed.subject).toBe(subject);
      expect(parsed.text).toContain('I am a Jedi');
      expect(parsed.html).toBeFalsy();
      expect(parsed.from.value[0].address).toBe(LUKE.email);
    });
  });

  // -----------------------------------------------------------------------
  // 2. HTML email
  // -----------------------------------------------------------------------
  describe('HTML email', () => {
    const subject = `[Test-${RUN_ID}] HTML email`;
    let uid;

    it('Vader sends an HTML email to Luke', async () => {
      const smtp = createSmtp(VADER);
      const result = await smtp.sendMail({
        from: VADER.email,
        to: LUKE.email,
        subject,
        html: `
          <div style="font-family: Arial; color: #333;">
            <h1 style="color: red;">I am your father</h1>
            <p>Search your feelings, you <em>know</em> it to be true.</p>
            <ul>
              <li>The Dark Side</li>
              <li>The Force</li>
            </ul>
            <a href="https://example.com">Join me</a>
          </div>
        `,
      });
      expect(result.accepted).toContain(LUKE.email);
    });

    it('Luke receives the HTML email with correct structure', async () => {
      uid = await waitForDelivery(LUKE, subject);
      trackForCleanup(LUKE, uid);

      const parsed = await fetchParsed(LUKE, uid);
      expect(parsed.subject).toBe(subject);
      expect(parsed.html).toContain('I am your father');
      expect(parsed.html).toContain('<em>');
      expect(parsed.html).toContain('https://example.com');
      expect(parsed.from.value[0].address).toBe(VADER.email);
    });
  });

  // -----------------------------------------------------------------------
  // 3. HTML + plain text (multipart/alternative)
  // -----------------------------------------------------------------------
  describe('HTML + plain text multipart email', () => {
    const subject = `[Test-${RUN_ID}] Multipart`;
    let uid;

    it('Luke sends a multipart email to Vader', async () => {
      const smtp = createSmtp(LUKE);
      const result = await smtp.sendMail({
        from: LUKE.email,
        to: VADER.email,
        subject,
        text: 'There is still good in you.',
        html: '<p>There is still <strong>good</strong> in you.</p>',
      });
      expect(result.accepted).toContain(VADER.email);
    });

    it('Vader receives both HTML and text parts', async () => {
      uid = await waitForDelivery(VADER, subject);
      trackForCleanup(VADER, uid);

      const parsed = await fetchParsed(VADER, uid);
      expect(parsed.text).toContain('There is still good in you');
      expect(parsed.html).toContain('<strong>good</strong>');
    });
  });

  // -----------------------------------------------------------------------
  // 4. File attachment (binary)
  // -----------------------------------------------------------------------
  describe('Email with file attachment', () => {
    const subject = `[Test-${RUN_ID}] File attachment`;
    let uid;

    const pdfContent = Buffer.from('%PDF-1.4 fake pdf content for testing');
    const csvContent = Buffer.from(
      'Name,Side\nLuke Skywalker,Light\nDarth Vader,Dark\n'
    );

    it('Vader sends an email with PDF and CSV attachments to Luke', async () => {
      const smtp = createSmtp(VADER);
      const result = await smtp.sendMail({
        from: VADER.email,
        to: LUKE.email,
        subject,
        text: 'See attached plans.',
        attachments: [
          {
            filename: 'death-star-plans.pdf',
            content: pdfContent,
            contentType: 'application/pdf',
          },
          {
            filename: 'force-users.csv',
            content: csvContent,
            contentType: 'text/csv',
          },
        ],
      });
      expect(result.accepted).toContain(LUKE.email);
    });

    it('Luke receives the email with both attachments', async () => {
      uid = await waitForDelivery(LUKE, subject);
      trackForCleanup(LUKE, uid);

      const parsed = await fetchParsed(LUKE, uid);
      expect(parsed.subject).toBe(subject);
      expect(parsed.attachments).toHaveLength(2);

      const pdf = parsed.attachments.find((a) => a.filename === 'death-star-plans.pdf');
      expect(pdf).toBeDefined();
      expect(pdf.contentType).toBe('application/pdf');
      expect(pdf.content).toBeInstanceOf(Buffer);
      expect(pdf.content.length).toBe(pdfContent.length);

      const csv = parsed.attachments.find((a) => a.filename === 'force-users.csv');
      expect(csv).toBeDefined();
      expect(csv.content.toString()).toContain('Luke Skywalker');
    });
  });

  // -----------------------------------------------------------------------
  // 5. Image attachment
  // -----------------------------------------------------------------------
  describe('Email with image attachment', () => {
    const subject = `[Test-${RUN_ID}] Image attachment`;
    let uid;

    // 1x1 red PNG
    const pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64'
    );

    it('Luke sends an email with an image attachment to Vader', async () => {
      const smtp = createSmtp(LUKE);
      const result = await smtp.sendMail({
        from: LUKE.email,
        to: VADER.email,
        subject,
        text: 'Here is a photo from Tatooine.',
        attachments: [
          {
            filename: 'tatooine-sunset.png',
            content: pngBuffer,
            contentType: 'image/png',
          },
        ],
      });
      expect(result.accepted).toContain(VADER.email);
    });

    it('Vader receives the image attachment with correct content', async () => {
      uid = await waitForDelivery(VADER, subject);
      trackForCleanup(VADER, uid);

      const parsed = await fetchParsed(VADER, uid);
      expect(parsed.attachments).toHaveLength(1);

      const img = parsed.attachments[0];
      expect(img.filename).toBe('tatooine-sunset.png');
      expect(img.contentType).toBe('image/png');
      expect(img.content.equals(pngBuffer)).toBe(true);
      // Should NOT be marked as inline (no contentId)
      expect(img.contentId).toBeFalsy();
    });
  });

  // -----------------------------------------------------------------------
  // 6. Inline image (embedded in HTML)
  // -----------------------------------------------------------------------
  describe('Email with inline embedded image', () => {
    const subject = `[Test-${RUN_ID}] Inline image`;
    let uid;

    // 1x1 blue PNG
    const inlinePng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==',
      'base64'
    );

    it('Vader sends an HTML email with an inline image to Luke', async () => {
      const smtp = createSmtp(VADER);
      const result = await smtp.sendMail({
        from: VADER.email,
        to: LUKE.email,
        subject,
        html: '<p>Behold the Empire:</p><img src="cid:empire-logo" /><p>Impressive.</p>',
        attachments: [
          {
            filename: 'empire-logo.png',
            content: inlinePng,
            contentType: 'image/png',
            cid: 'empire-logo',
          },
        ],
      });
      expect(result.accepted).toContain(LUKE.email);
    });

    it('Luke receives the email — inline image has contentId and is embedded in HTML', async () => {
      uid = await waitForDelivery(LUKE, subject);
      trackForCleanup(LUKE, uid);

      const parsed = await fetchParsed(LUKE, uid);
      // mailparser replaces cid: references with data: URIs in the HTML
      expect(parsed.html).toContain('Behold the Empire');
      expect(parsed.html).toMatch(/src="(cid:empire-logo|data:image\/png;base64,)/);

      // The inline image should still be listed in attachments with a contentId
      const inlineAtt = parsed.attachments.find((a) => a.contentId);
      expect(inlineAtt).toBeDefined();
      expect(inlineAtt.contentType).toBe('image/png');
    });
  });

  // -----------------------------------------------------------------------
  // 7. Mixed: inline image + real attachment
  // -----------------------------------------------------------------------
  describe('Email with inline image AND real attachment', () => {
    const subject = `[Test-${RUN_ID}] Mixed inline + attachment`;
    let uid;

    const inlinePng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64'
    );
    const docContent = Buffer.from('The Jedi Code: There is no emotion, there is peace.');

    it('Luke sends an email with both inline image and a file attachment', async () => {
      const smtp = createSmtp(LUKE);
      const result = await smtp.sendMail({
        from: LUKE.email,
        to: VADER.email,
        subject,
        html: '<p>See logo: <img src="cid:jedi-logo" /></p><p>And the attached document.</p>',
        attachments: [
          {
            filename: 'jedi-logo.png',
            content: inlinePng,
            contentType: 'image/png',
            cid: 'jedi-logo',
          },
          {
            filename: 'jedi-code.txt',
            content: docContent,
            contentType: 'text/plain',
            contentDisposition: 'attachment',
          },
        ],
      });
      expect(result.accepted).toContain(VADER.email);
    });

    it('Vader receives — can distinguish inline from real attachment', async () => {
      uid = await waitForDelivery(VADER, subject);
      trackForCleanup(VADER, uid);

      const parsed = await fetchParsed(VADER, uid);
      expect(parsed.attachments.length).toBeGreaterThanOrEqual(2);

      const inline = parsed.attachments.find((a) => a.contentId && a.contentId.includes('jedi-logo'));
      expect(inline).toBeDefined();
      expect(inline.contentType).toBe('image/png');

      const real = parsed.attachments.find((a) => a.filename === 'jedi-code.txt');
      expect(real).toBeDefined();
      expect(real.content.toString()).toContain('Jedi Code');
      expect(real.contentId).toBeFalsy();
    });
  });

  // -----------------------------------------------------------------------
  // 8. Email-as-attachment (.eml)
  // -----------------------------------------------------------------------
  describe('Email with .eml attachment (forwarded email)', () => {
    const subject = `[Test-${RUN_ID}] EML attachment`;
    let uid;

    // A minimal RFC 2822 email
    const innerEml = [
      'From: yoda@forceunwrap.com',
      'To: luke@forceunwrap.com',
      'Subject: Do or do not',
      'Date: Thu, 01 Jan 2026 00:00:00 +0000',
      'Content-Type: text/plain; charset="utf-8"',
      '',
      'There is no try.',
    ].join('\r\n');

    it('Vader sends an email with an .eml file attached to Luke', async () => {
      const smtp = createSmtp(VADER);
      const result = await smtp.sendMail({
        from: VADER.email,
        to: LUKE.email,
        subject,
        text: 'Forwarding this message from the old master.',
        attachments: [
          {
            filename: 'yoda-message.eml',
            content: Buffer.from(innerEml),
            contentType: 'message/rfc822',
          },
        ],
      });
      expect(result.accepted).toContain(LUKE.email);
    });

    it('Luke receives the .eml attachment and can parse it', async () => {
      uid = await waitForDelivery(LUKE, subject);
      trackForCleanup(LUKE, uid);

      const parsed = await fetchParsed(LUKE, uid);
      expect(parsed.text).toContain('Forwarding this message');

      const emlAtt = parsed.attachments.find(
        (a) => a.filename === 'yoda-message.eml' || a.contentType === 'message/rfc822'
      );
      expect(emlAtt).toBeDefined();

      // Parse the inner .eml
      const inner = await simpleParser(emlAtt.content);
      expect(inner.subject).toBe('Do or do not');
      expect(inner.text).toContain('There is no try');
      expect(inner.from.value[0].address).toBe('yoda@forceunwrap.com');
    });
  });

  // -----------------------------------------------------------------------
  // 9. Multiple attachments of different types
  // -----------------------------------------------------------------------
  describe('Email with multiple mixed attachments', () => {
    const subject = `[Test-${RUN_ID}] Multiple attachments`;
    let uid;

    it('Luke sends an email with 4 different attachments', async () => {
      const smtp = createSmtp(LUKE);
      const result = await smtp.sendMail({
        from: LUKE.email,
        to: VADER.email,
        subject,
        html: '<h2>Mission Briefing</h2><p>All files attached below.</p>',
        attachments: [
          {
            filename: 'briefing.txt',
            content: Buffer.from('Attack the Death Star exhaust port.'),
            contentType: 'text/plain',
          },
          {
            filename: 'coordinates.json',
            content: Buffer.from(JSON.stringify({ x: 12.5, y: -3.2, z: 88.1 })),
            contentType: 'application/json',
          },
          {
            filename: 'map.png',
            content: Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==',
              'base64'
            ),
            contentType: 'image/png',
          },
          {
            filename: 'roster.csv',
            content: Buffer.from('Pilot,Callsign\nLuke,Red Five\nWedge,Red Two\n'),
            contentType: 'text/csv',
          },
        ],
      });
      expect(result.accepted).toContain(VADER.email);
    });

    it('Vader receives all 4 attachments with correct types and content', async () => {
      uid = await waitForDelivery(VADER, subject);
      trackForCleanup(VADER, uid);

      const parsed = await fetchParsed(VADER, uid);
      expect(parsed.attachments).toHaveLength(4);

      const filenames = parsed.attachments.map((a) => a.filename).sort();
      expect(filenames).toEqual(['briefing.txt', 'coordinates.json', 'map.png', 'roster.csv']);

      const json = parsed.attachments.find((a) => a.filename === 'coordinates.json');
      const data = JSON.parse(json.content.toString());
      expect(data.x).toBe(12.5);

      const png = parsed.attachments.find((a) => a.filename === 'map.png');
      expect(png.contentType).toBe('image/png');
      expect(png.content.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // 10. Large HTML email with complex styling
  // -----------------------------------------------------------------------
  describe('Complex HTML email (newsletter-style)', () => {
    const subject = `[Test-${RUN_ID}] Complex HTML`;
    let uid;

    const html = `
      <!DOCTYPE html>
      <html>
        <head><meta charset="utf-8"></head>
        <body style="margin:0; padding:0; background:#f4f4f4;">
          <table width="600" cellpadding="0" cellspacing="0" style="margin:0 auto; background:#fff;">
            <tr>
              <td style="padding:20px; background:#1a1a2e; color:#fff; text-align:center;">
                <h1 style="margin:0;">Galactic Empire Newsletter</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:20px;">
                <h2 style="color:#333;">Issue #42</h2>
                <p style="color:#666; line-height:1.6;">
                  The construction of the second Death Star is proceeding on schedule.
                  All regional governors have been notified.
                </p>
                <table width="100%">
                  <tr>
                    <td style="padding:10px; background:#f0f0f0; border-radius:8px;">
                      <strong>Upcoming Events:</strong>
                      <ul>
                        <li>Fleet review — Endor system</li>
                        <li>Sith training seminar</li>
                      </ul>
                    </td>
                  </tr>
                </table>
                <p><a href="https://example.com/unsubscribe" style="color:#6366f1;">Unsubscribe</a></p>
              </td>
            </tr>
          </table>
        </body>
      </html>
    `;

    it('Vader sends a newsletter-style HTML email to Luke', async () => {
      const smtp = createSmtp(VADER);
      const result = await smtp.sendMail({
        from: `"Galactic Empire" <${VADER.email}>`,
        to: LUKE.email,
        subject,
        html,
      });
      expect(result.accepted).toContain(LUKE.email);
    });

    it('Luke receives the full HTML structure intact', async () => {
      uid = await waitForDelivery(LUKE, subject);
      trackForCleanup(LUKE, uid);

      const parsed = await fetchParsed(LUKE, uid);
      expect(parsed.html).toContain('Galactic Empire Newsletter');
      expect(parsed.html).toContain('Issue #42');
      expect(parsed.html).toContain('Sith training seminar');
      expect(parsed.html).toContain('https://example.com/unsubscribe');
      // Should also have an auto-generated text version
      expect(parsed.text).toBeTruthy();
    });
  });

  // -----------------------------------------------------------------------
  // 11. CC and Reply-To headers
  // -----------------------------------------------------------------------
  describe('Email with CC and Reply-To headers', () => {
    const subject = `[Test-${RUN_ID}] CC and ReplyTo`;
    let uid;

    it('Luke sends to Vader with CC to self and a Reply-To', async () => {
      const smtp = createSmtp(LUKE);
      const result = await smtp.sendMail({
        from: LUKE.email,
        to: VADER.email,
        cc: LUKE.email,
        replyTo: 'no-reply@forceunwrap.com',
        subject,
        text: 'Check the headers on this one.',
      });
      expect(result.accepted).toContain(VADER.email);
    });

    it('Vader receives email with correct CC and Reply-To', async () => {
      uid = await waitForDelivery(VADER, subject);
      trackForCleanup(VADER, uid);

      const parsed = await fetchParsed(VADER, uid);
      expect(parsed.subject).toBe(subject);
      expect(parsed.to.value[0].address).toBe(VADER.email);

      const ccAddresses = parsed.cc.value.map((c) => c.address);
      expect(ccAddresses).toContain(LUKE.email);

      expect(parsed.replyTo.value[0].address).toBe('no-reply@forceunwrap.com');
    });
  });

  // -----------------------------------------------------------------------
  // 12. Unicode / emoji subject and body
  // -----------------------------------------------------------------------
  describe('Unicode and emoji email', () => {
    const subject = `[Test-${RUN_ID}] 日本語テスト 🚀✨`;
    let uid;

    it('Vader sends a Unicode-heavy email to Luke', async () => {
      const smtp = createSmtp(VADER);
      const result = await smtp.sendMail({
        from: VADER.email,
        to: LUKE.email,
        subject,
        text: '中文测试 · Ελληνικά · العربية · 🌟💫⚡',
        html: '<p>中文测试 · Ελληνικά · العربية · 🌟💫⚡</p><p>Ñoño café résumé naïve</p>',
      });
      expect(result.accepted).toContain(LUKE.email);
    });

    it('Luke receives all Unicode characters intact', async () => {
      uid = await waitForDelivery(LUKE, subject);
      trackForCleanup(LUKE, uid);

      const parsed = await fetchParsed(LUKE, uid);
      expect(parsed.subject).toContain('日本語テスト');
      expect(parsed.subject).toContain('🚀');
      expect(parsed.text).toContain('中文测试');
      expect(parsed.text).toContain('العربية');
      expect(parsed.html).toContain('Ñoño café résumé naïve');
    });
  });
});
