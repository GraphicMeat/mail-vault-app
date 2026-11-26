import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const mail = require('../api/signin-code-email.js');
const { LOCALES } = require('../api/send-link-email.js');

// The Rust code detector is tested against these mails (src-core verification_code.rs), and the
// app looks for them by subject (src/services/workflows/signinCodeWatch.js). Both copies must follow the
// mail: regenerate the fixture and the subject list when the copy changes.
describe('sign-in mail copies outside the website', () => {
  it('the src-core fixture is the mail as built today', () => {
    const fixture = JSON.parse(readFileSync(new URL('../../src-core/tests/fixtures/signin-code-mails.json', import.meta.url), 'utf8'));
    const built = Object.keys(LOCALES).map((lang) => {
      const { subject, text } = mail.buildSigninCodeEmail(lang, '482913');
      return { lang, subject, text };
    });
    expect(fixture).toEqual(built);
  });

  it('the app knows every subject', () => {
    const src = readFileSync(new URL('../../src/services/workflows/signinCodeWatch.js', import.meta.url), 'utf8');
    for (const lang of Object.keys(LOCALES)) expect(src, lang).toContain(JSON.stringify(mail.COPY[lang].subject));
  });
});
