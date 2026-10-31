import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// Every "write to us" address — website mailto links, the app's bug-report
// compose — goes to one inbox. The old mailvaultapp.com mailboxes are gone.
const CONTACT = 'prime@graphicmeat.com';

const gitGrep = (flags) => (pattern, ...paths) => {
  try {
    return execFileSync('git', ['grep', flags, pattern, '--', ...paths], { encoding: 'utf8' });
  } catch {
    return '';
  }
};
const grep = gitGrep('-nIE');
const grepFixed = gitGrep('-nIF');

describe('contact address', () => {
  it('no page, locale string or app file names a mailvaultapp.com mailbox', () => {
    // A fixed-string search, then the mailbox pattern on the lines it found: git grep
    // running `[...]+@` over every line of the large fixtures took 10 minutes on CI.
    const lines = grepFixed('@mailvaultapp.com','website', 'src', 'src-tauri', 'src-daemon', 'src-core', 'index.html')
      .split('\n').filter((line) => /[A-Za-z0-9._%+-]@mailvaultapp\.com/.test(line));
    expect(lines).toEqual([]);
  });

  it('website mailto links all go to the contact inbox', () => {
    const others = grep('mailto:[^"?]+', 'website/*.html', 'website/**/*.html', 'index.html')
      .split('\n').filter(Boolean)
      .filter((line) => [...line.matchAll(/mailto:([^"?\s]+)/g)].some(([, to]) => to !== CONTACT));
    expect(others).toEqual([]);
  });

  it('the bug-report compose is addressed to the contact inbox', () => {
    expect(grep(`to: '${CONTACT}'`, 'src/App.jsx')).not.toBe('');
  });
});
