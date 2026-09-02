/**
 * A raw IMAP session to the mock server — the "other client".
 *
 * The same wire the app uses, with none of the app in the way: what a spec
 * reads here is what the server holds, whatever the list on screen says.
 */

import { createConnection } from 'node:net';
import { MOCK_PASSWORD } from './mockImap.js';

/**
 * One command per call, on a fresh plaintext session to the mock: LOGIN,
 * SELECT, the command, LOGOUT. Returns the untagged lines the command produced.
 */
export function imap(port, mailbox, command) {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: '127.0.0.1', port });
    const steps = [
      // The mock accepts any credentials; the name only has to read as a
      // different client in its log.
      `A1 LOGIN "other-client" "${MOCK_PASSWORD}"`,
      `A2 SELECT "${mailbox}"`,
      `A3 ${command}`,
      'A4 LOGOUT',
    ];
    let buf = '';
    let step = -1;
    const collected = [];
    const fail = (why) => { sock.destroy(); reject(new Error(`mock imap :${port} ${mailbox} "${command}" — ${why}`)); };
    const timer = setTimeout(() => fail('timed out'), 10_000);
    const next = () => {
      step += 1;
      if (step >= steps.length) { clearTimeout(timer); sock.end(); resolve(collected); return; }
      sock.write(`${steps[step]}\r\n`);
    };
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (step < 0) { if (line.startsWith('* OK')) next(); continue; }
        const tag = `A${step + 1} `;
        if (line.startsWith(tag)) {
          if (!line.startsWith(`${tag}OK`)) return fail(line);
          next();
        } else if (step === 2 && line.startsWith('* ')) {
          collected.push(line);
        }
      }
    });
    sock.on('error', (e) => fail(e.message));
  });
}

/** The flags the server holds for `uid`. */
export async function serverFlags(port, mailbox, uid) {
  const lines = await imap(port, mailbox, `UID FETCH ${uid} (FLAGS)`);
  const line = lines.find((l) => l.includes(`UID ${uid} `) || l.endsWith(`UID ${uid})`));
  const m = line && line.match(/FLAGS \(([^)]*)\)/);
  return m ? m[1].split(/\s+/).filter(Boolean) : null;
}

export const storeFlag = (port, mailbox, uid, op) => imap(port, mailbox, `UID STORE ${uid} ${op} (\\Seen)`);
