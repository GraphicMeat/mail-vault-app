/**
 * Mock-server harness for the integration suite.
 *
 * These suites used to run against a live provider with credentials from
 * .env.test. They now run against `src-mock-imap` on loopback — hermetic, no
 * credentials, no rate limits. Reuses the e2e harness for build/spawn.
 *
 * SMTP is gone: the mock speaks IMAP only, so "send" in these tests is an
 * APPEND into the target INBOX via `deliver()`. Provider SMTP conformance is
 * not testable against a mock and is intentionally out of scope here.
 */

import { ImapFlow } from 'imapflow';
import { startMockImap, scenario, mailbox } from '../e2e/mockImap.js';

export { startMockImap, scenario, mailbox };

/**
 * Start a server whose INBOX already holds `inbox` messages, mirroring the
 * seeded live mailboxes the old suite assumed (fetch tests need messages).
 */
export function startSeededServer({ owner = 'luke@example.test', inbox = 20, faults = [] } = {}) {
  return startMockImap(scenario({ owner, inbox, faults }));
}

/** ImapFlow client against a mock server. Plaintext loopback — no TLS. */
export function createClient(server, { user = 'luke@example.test', pass = 'mock-password' } = {}) {
  return new ImapFlow({
    host: server.host,
    port: server.port,
    secure: false,
    auth: { user, pass },
    logger: false,
    connectTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });
}

/**
 * "Send" a message: APPEND it to a mailbox on the target server.
 * Stands in for the SMTP send + delivery wait of the live suite.
 *
 * Pass `raw` to APPEND a fully-formed RFC 822 message verbatim (multipart,
 * attachments, custom headers) instead of the plain-text template built here.
 * @returns {number} UID of the delivered message
 */
export async function deliver(server, { to, from, subject, text, mailbox: box = 'INBOX', flags = [], auth, raw } = {}) {
  const message = raw || [
    `From: ${from || 'sender@example.test'}`,
    `To: ${to || 'luke@example.test'}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <mock-${Date.now()}-${Math.random().toString(36).slice(2)}@test>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    text || '',
    '',
  ].join('\r\n');

  const client = createClient(server, auth);
  await client.connect();
  try {
    const result = await client.append(box, message, flags);
    return result.uid;
  } finally {
    await client.logout();
  }
}
