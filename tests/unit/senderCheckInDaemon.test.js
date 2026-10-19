/**
 * Phase 1, row 4: the sender verdict (SPF/DKIM/DMARC, display-name and
 * Reply-To checks, the DKIM signature's algorithm, domain and selector) and
 * the one-time code in a mail are the daemon's (`message.verify_sender`,
 * `message.code`, src-daemon/src/handlers/message.rs, rules in
 * src-core/src/sender_check.rs and verification_code.rs). The app words the
 * answer and draws the shield, the popover, the social card box and the code
 * bubble; it decides none of it. CI never runs `cargo test -p mailvault-daemon`,
 * so this reads the sources, same pattern as `networkInDaemon` and `vaultInDaemon`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { listSourceFiles } from '../../scripts/lib/sourceFiles.mjs';

const read = (path) => readFileSync(path, 'utf8');
const code = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const METHODS = ['message.verify_sender', 'message.code'];

describe('sender verdicts and one-time codes live in the daemon', () => {
  it('the JS ports are gone', () => {
    for (const gone of ['src/utils/senderCheck.js', 'src/utils/verificationCode.js']) {
      expect(existsSync(gone), gone).toBe(false);
    }
  });

  it.each(METHODS)('the daemon routes %s from its own handler file', (method) => {
    expect(read('src-daemon/src/handlers/message.rs')).toContain(`"${method}"`);
  });

  it('the handler is declared and in the route chain, its rules in src-core', () => {
    expect(read('src-daemon/src/handlers/mod.rs')).toMatch(/pub\(crate\) mod message;/);
    expect(code(read('src-daemon/src/server.rs'))).toMatch(/crate::handlers::message::route\(/);
    const lib = read('src-core/src/lib.rs');
    expect(lib).toMatch(/pub mod sender_check;/);
    expect(lib).toMatch(/pub mod verification_code;/);
  });

  it.each(METHODS)('the app reaches %s as a daemon-owned command, and the browser demo answers it', (method) => {
    expect(read('src/services/transport.js')).toContain(`'${method}'`);
    expect(read('src/demo/backend.js')).toContain(`'${method}'`);
  });

  it('no app source parses Authentication-Results or hunts for a code itself', () => {
    const files = listSourceFiles(['src'], ['.js', '.jsx'], { exclude: ['__tests__', '__mocks__', '.test.', '.spec.', 'src/demo/'] });
    const offenders = files.filter((f) => {
      const src = code(read(f));
      return /\b(spf|dkim|dmarc)=\(pass/i.test(src)
        || /checkSenderVerification|parseAuthResults|parseDkimSignature|findVerificationCode|looksLikeCodeMail/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it('the surfaces ask the daemon', () => {
    expect(code(read('src/services/senderVerdict.js'))).toContain("'message.verify_sender'");
    expect(code(read('src/services/api.js'))).toContain("'message.code'");
    expect(code(read('src/services/codeBubble.js'))).toMatch(/messageCode\(/);
    expect(code(read('src/components/email/EmailHeaderComponent.jsx'))).toMatch(/useSenderVerdict\(/);
    expect(code(read('src/services/export/exportService.js'))).toMatch(/verifySender\(/);
  });
});
