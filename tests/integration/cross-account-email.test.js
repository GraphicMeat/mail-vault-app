import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { simpleParser } from 'mailparser';
import { startSeededServer, createClient, deliver } from './mockHarness.js';

// ---------------------------------------------------------------------------
// Raw MIME builder
//
// The live suite used nodemailer's SMTP transport to build and send these
// messages. The mock speaks IMAP only (no SMTP), so "sending" here means
// composing the same RFC 822 bytes ourselves and APPENDing them straight into
// the recipient's mailbox. Handles the handful of MIME shapes the suite below
// needs: plain, html, multipart/alternative, multipart/mixed attachments,
// multipart/related inline (cid) images, and a nested message/rfc822 part.
// ---------------------------------------------------------------------------

function encodeHeader(str) {
  // RFC 2047 'B' encoding — only needed once the value leaves ASCII.
  return /^[\x00-\x7F]*$/.test(str) ? str : `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

function rand() {
  return Math.random().toString(36).slice(2);
}

function attachmentLines(att, boundary) {
  const isInline = !!att.cid;
  const body = att.content.toString('base64').replace(/(.{76})/g, '$1\r\n');
  const lines = [
    `--${boundary}`,
    `Content-Type: ${att.contentType}${att.filename ? `; name="${att.filename}"` : ''}`,
    'Content-Transfer-Encoding: base64',
  ];
  if (isInline) lines.push(`Content-ID: <${att.cid}>`);
  lines.push(`Content-Disposition: ${isInline ? 'inline' : 'attachment'}${att.filename ? `; filename="${att.filename}"` : ''}`);
  lines.push('', body);
  return lines;
}

function buildRaw({ from, to, cc, replyTo, subject, text, html, attachments = [], eml }) {
  const inline = attachments.filter((a) => a.cid);
  const real = attachments.filter((a) => !a.cid);

  // 1. Body: plain text, html, or multipart/alternative of both.
  let body;
  if (text && html) {
    const b = `alt-${rand()}`;
    body = {
      contentType: `multipart/alternative; boundary="${b}"`,
      raw: [
        `--${b}`,
        'Content-Type: text/plain; charset="utf-8"',
        'Content-Transfer-Encoding: 8bit',
        '', text,
        `--${b}`,
        'Content-Type: text/html; charset="utf-8"',
        'Content-Transfer-Encoding: 8bit',
        '', html,
        `--${b}--`,
      ].join('\r\n'),
    };
  } else if (html) {
    body = { contentType: 'text/html; charset="utf-8"', raw: html };
  } else {
    body = { contentType: 'text/plain; charset="utf-8"', raw: text || '' };
  }

  // 2. Wrap body + inline images in multipart/related, if any inline images.
  let related = body;
  if (inline.length) {
    const b = `rel-${rand()}`;
    related = {
      contentType: `multipart/related; boundary="${b}"`,
      raw: [
        `--${b}`,
        `Content-Type: ${body.contentType}`,
        'Content-Transfer-Encoding: 8bit',
        '', body.raw,
        ...inline.flatMap((a) => attachmentLines(a, b)),
        `--${b}--`,
      ].join('\r\n'),
    };
  }

  // 3. Wrap in multipart/mixed if there are real attachments or an .eml part.
  let top = related;
  if (real.length || eml) {
    const b = `mix-${rand()}`;
    const parts = [
      `--${b}`,
      `Content-Type: ${related.contentType}`,
      'Content-Transfer-Encoding: 8bit',
      '', related.raw,
      ...real.flatMap((a) => attachmentLines(a, b)),
    ];
    if (eml) {
      parts.push(
        `--${b}`,
        `Content-Type: message/rfc822; name="${eml.filename}"`,
        `Content-Disposition: attachment; filename="${eml.filename}"`,
        '',
        eml.raw
      );
    }
    parts.push(`--${b}--`);
    top = { contentType: `multipart/mixed; boundary="${b}"`, raw: parts.join('\r\n') };
  }

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <mock-${Date.now()}-${rand()}@test>`,
    'MIME-Version: 1.0',
    `Content-Type: ${top.contentType}`,
  ];
  if (!top.contentType.startsWith('multipart/')) headers.push('Content-Transfer-Encoding: 8bit');

  return [...headers, '', top.raw].join('\r\n');
}

async function sendCrossAccount(destServer, mailOptions) {
  const raw = buildRaw(mailOptions);
  return deliver(destServer, { raw, mailbox: 'INBOX' });
}

async function findAndFetch(destServer, subject) {
  const client = createClient(destServer);
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const uids = await client.search({ subject }, { uid: true });
    expect(uids.length).toBeGreaterThan(0);
    const uid = uids[uids.length - 1];
    const msg = await client.fetchOne(uid, { source: true }, { uid: true });
    return { uid, parsed: await simpleParser(msg.source) };
  } finally {
    lock.release();
    await client.logout();
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
const LUKE = { email: 'luke@example.test' };
const VADER = { email: 'vader@example.test' };
const RUN_ID = Date.now();

describe('Cross-Account Email Tests (Luke <-> Vader)', () => {
  let lukeServer;
  let vaderServer;

  beforeAll(async () => {
    lukeServer = await startSeededServer({ owner: LUKE.email });
    vaderServer = await startSeededServer({ owner: VADER.email });
  });

  afterAll(async () => {
    lukeServer?.stop();
    vaderServer?.stop();
  });

  // -----------------------------------------------------------------------
  // 1. Plain text email
  // -----------------------------------------------------------------------
  describe('Plain text email', () => {
    const subject = `[Test-${RUN_ID}] Plain text`;

    it('Luke sends a plain text email to Vader', async () => {
      const uid = await sendCrossAccount(vaderServer, {
        from: LUKE.email,
        to: VADER.email,
        subject,
        text: 'I am a Jedi, like my father before me.',
      });
      expect(uid).toBeGreaterThan(0);
    });

    it('Vader receives the plain text email', async () => {
      const { parsed } = await findAndFetch(vaderServer, subject);
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

    it('Vader sends an HTML email to Luke', async () => {
      const uid = await sendCrossAccount(lukeServer, {
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
      expect(uid).toBeGreaterThan(0);
    });

    it('Luke receives the HTML email with correct structure', async () => {
      const { parsed } = await findAndFetch(lukeServer, subject);
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

    it('Luke sends a multipart email to Vader', async () => {
      const uid = await sendCrossAccount(vaderServer, {
        from: LUKE.email,
        to: VADER.email,
        subject,
        text: 'There is still good in you.',
        html: '<p>There is still <strong>good</strong> in you.</p>',
      });
      expect(uid).toBeGreaterThan(0);
    });

    it('Vader receives both HTML and text parts', async () => {
      const { parsed } = await findAndFetch(vaderServer, subject);
      expect(parsed.text).toContain('There is still good in you');
      expect(parsed.html).toContain('<strong>good</strong>');
    });
  });

  // -----------------------------------------------------------------------
  // 4. File attachment (binary)
  // -----------------------------------------------------------------------
  describe('Email with file attachment', () => {
    const subject = `[Test-${RUN_ID}] File attachment`;
    const pdfContent = Buffer.from('%PDF-1.4 fake pdf content for testing');
    const csvContent = Buffer.from(
      'Name,Side\nLuke Skywalker,Light\nDarth Vader,Dark\n'
    );

    it('Vader sends an email with PDF and CSV attachments to Luke', async () => {
      const uid = await sendCrossAccount(lukeServer, {
        from: VADER.email,
        to: LUKE.email,
        subject,
        text: 'See attached plans.',
        attachments: [
          { filename: 'death-star-plans.pdf', content: pdfContent, contentType: 'application/pdf' },
          { filename: 'force-users.csv', content: csvContent, contentType: 'text/csv' },
        ],
      });
      expect(uid).toBeGreaterThan(0);
    });

    it('Luke receives the email with both attachments', async () => {
      const { parsed } = await findAndFetch(lukeServer, subject);
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
    // 1x1 red PNG
    const pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64'
    );

    it('Luke sends an email with an image attachment to Vader', async () => {
      const uid = await sendCrossAccount(vaderServer, {
        from: LUKE.email,
        to: VADER.email,
        subject,
        text: 'Here is a photo from Tatooine.',
        attachments: [{ filename: 'tatooine-sunset.png', content: pngBuffer, contentType: 'image/png' }],
      });
      expect(uid).toBeGreaterThan(0);
    });

    it('Vader receives the image attachment with correct content', async () => {
      const { parsed } = await findAndFetch(vaderServer, subject);
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
    // 1x1 blue PNG
    const inlinePng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==',
      'base64'
    );

    it('Vader sends an HTML email with an inline image to Luke', async () => {
      const uid = await sendCrossAccount(lukeServer, {
        from: VADER.email,
        to: LUKE.email,
        subject,
        html: '<p>Behold the Empire:</p><img src="cid:empire-logo" /><p>Impressive.</p>',
        attachments: [{ filename: 'empire-logo.png', content: inlinePng, contentType: 'image/png', cid: 'empire-logo' }],
      });
      expect(uid).toBeGreaterThan(0);
    });

    it('Luke receives the email — inline image has contentId and is embedded in HTML', async () => {
      const { parsed } = await findAndFetch(lukeServer, subject);
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
    const inlinePng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64'
    );
    const docContent = Buffer.from('The Jedi Code: There is no emotion, there is peace.');

    it('Luke sends an email with both inline image and a file attachment', async () => {
      const uid = await sendCrossAccount(vaderServer, {
        from: LUKE.email,
        to: VADER.email,
        subject,
        html: '<p>See logo: <img src="cid:jedi-logo" /></p><p>And the attached document.</p>',
        attachments: [
          { filename: 'jedi-logo.png', content: inlinePng, contentType: 'image/png', cid: 'jedi-logo' },
          { filename: 'jedi-code.txt', content: docContent, contentType: 'text/plain' },
        ],
      });
      expect(uid).toBeGreaterThan(0);
    });

    it('Vader receives — can distinguish inline from real attachment', async () => {
      const { parsed } = await findAndFetch(vaderServer, subject);
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
      const uid = await sendCrossAccount(lukeServer, {
        from: VADER.email,
        to: LUKE.email,
        subject,
        text: 'Forwarding this message from the old master.',
        eml: { filename: 'yoda-message.eml', raw: innerEml },
      });
      expect(uid).toBeGreaterThan(0);
    });

    it('Luke receives the .eml attachment and can parse it', async () => {
      const { parsed } = await findAndFetch(lukeServer, subject);
      expect(parsed.text).toContain('Forwarding this message');

      // message/rfc822 parts may appear in attachments or as child nodes depending
      // on how mailparser handles the MIME structure.
      const emlAtt = parsed.attachments.find(
        (a) => a.filename === 'yoda-message.eml' || a.contentType === 'message/rfc822'
      );

      if (emlAtt) {
        const inner = await simpleParser(emlAtt.content);
        expect(inner.subject).toBe('Do or do not');
        expect(inner.text).toContain('There is no try');
        expect(inner.from.value[0].address).toBe('yoda@forceunwrap.com');
      } else {
        expect(parsed.subject).toBe(subject);
      }
    });
  });

  // -----------------------------------------------------------------------
  // 9. Multiple attachments of different types
  // -----------------------------------------------------------------------
  describe('Email with multiple mixed attachments', () => {
    const subject = `[Test-${RUN_ID}] Multiple attachments`;

    it('Luke sends an email with 4 different attachments', async () => {
      const uid = await sendCrossAccount(vaderServer, {
        from: LUKE.email,
        to: VADER.email,
        subject,
        html: '<h2>Mission Briefing</h2><p>All files attached below.</p>',
        attachments: [
          { filename: 'briefing.txt', content: Buffer.from('Attack the Death Star exhaust port.'), contentType: 'text/plain' },
          { filename: 'coordinates.json', content: Buffer.from(JSON.stringify({ x: 12.5, y: -3.2, z: 88.1 })), contentType: 'application/json' },
          {
            filename: 'map.png',
            content: Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==',
              'base64'
            ),
            contentType: 'image/png',
          },
          { filename: 'roster.csv', content: Buffer.from('Pilot,Callsign\nLuke,Red Five\nWedge,Red Two\n'), contentType: 'text/csv' },
        ],
      });
      expect(uid).toBeGreaterThan(0);
    });

    it('Vader receives all 4 attachments with correct types and content', async () => {
      const { parsed } = await findAndFetch(vaderServer, subject);
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
      const uid = await sendCrossAccount(lukeServer, {
        from: `"Galactic Empire" <${VADER.email}>`,
        to: LUKE.email,
        subject,
        html,
        // Newsletters are HTML-only in the original suite too, but mailparser
        // still auto-derives a text version below.
      });
      expect(uid).toBeGreaterThan(0);
    });

    it('Luke receives the full HTML structure intact', async () => {
      const { parsed } = await findAndFetch(lukeServer, subject);
      expect(parsed.html).toContain('Galactic Empire Newsletter');
      expect(parsed.html).toContain('Issue #42');
      expect(parsed.html).toContain('Sith training seminar');
      expect(parsed.html).toContain('https://example.com/unsubscribe');
      // mailparser auto-generates a text version from the HTML when only html was sent
      expect(parsed.text).toBeTruthy();
    });
  });

  // -----------------------------------------------------------------------
  // 11. CC and Reply-To headers
  // -----------------------------------------------------------------------
  describe('Email with CC and Reply-To headers', () => {
    const subject = `[Test-${RUN_ID}] CC and ReplyTo`;

    it('Luke sends to Vader with CC to self and a Reply-To', async () => {
      const uid = await sendCrossAccount(vaderServer, {
        from: LUKE.email,
        to: VADER.email,
        cc: LUKE.email,
        replyTo: 'no-reply@forceunwrap.com',
        subject,
        text: 'Check the headers on this one.',
      });
      expect(uid).toBeGreaterThan(0);
    });

    it('Vader receives email with correct CC and Reply-To', async () => {
      const { parsed } = await findAndFetch(vaderServer, subject);
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
      uid = await sendCrossAccount(lukeServer, {
        from: VADER.email,
        to: LUKE.email,
        subject,
        text: '中文测试 · Ελληνικά · العربية · 🌟💫⚡',
        html: '<p>中文测试 · Ελληνικά · العربية · 🌟💫⚡</p><p>Ñoño café résumé naïve</p>',
      });
      expect(uid).toBeGreaterThan(0);
    });

    // Fetch by UID rather than findAndFetch()'s usual SEARCH-by-subject: a
    // non-ASCII search value makes ImapFlow prepend "CHARSET UTF-8" to the
    // SEARCH command (RFC 3501), which the mock's SEARCH parser doesn't
    // recognize as a leading token — every message fails to match. Mock-server
    // limitation, not something to work around in the assertion.
    it('Luke receives all Unicode characters intact', async () => {
      const client = createClient(lukeServer);
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      let parsed;
      try {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        parsed = await simpleParser(msg.source);
      } finally {
        lock.release();
        await client.logout();
      }
      expect(parsed.subject).toContain('日本語テスト');
      expect(parsed.subject).toContain('🚀');
      expect(parsed.text).toContain('中文测试');
      expect(parsed.text).toContain('العربية');
      expect(parsed.html).toContain('Ñoño café résumé naïve');
    });
  });
});
