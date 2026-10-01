/**
 * The people privacy mode must never show, shared by every privacy leak test.
 * A plain module, not a test file, so test files import it without importing
 * each other.
 */
import { expect } from 'vitest';

// ponytail: the brief's third person was "Owen Account"; its token "Account"
// is also chrome ("Add Account", "Account switcher"), so it was renamed.
export const PEOPLE = {
  names: ['Joanna Kowalczyk', 'Rokas Ambrazevičius', 'Owen Ashcombe'],
  emails: ['joanna.k@example.org', 'rokas@example.lt', 'owen@own.example'],
  phones: ['+370 612 34567'],
  files: ['CV_Joanna_Kowalczyk.pdf'],
};

export const FIXTURE_MESSAGE = {
  uid: 1, subject: 'Lunch with Joanna Kowalczyk', date: new Date('2026-09-01T10:00:00Z'),
  from: { name: 'Joanna Kowalczyk', address: 'joanna.k@example.org' },
  to: [{ name: 'Rokas Ambrazevičius', address: 'rokas@example.lt' }],
  cc: [], snippet: 'Call me on +370 612 34567', flags: [],
  attachments: [{ filename: 'CV_Joanna_Kowalczyk.pdf', contentType: 'application/pdf', size: 1000 }],
};

export const NEEDLES = [
  ...PEOPLE.names, ...PEOPLE.names.flatMap(n => n.split(' ')),
  ...PEOPLE.emails, ...PEOPLE.phones, 'Joanna_Kowalczyk',
];

/**
 * No needle in the text or in any attribute a reader, a tooltip or a link
 * exposes. Pass `document.body` to cover what a surface portals out of its
 * container (dialogs, popovers).
 */
export function expectNoLeak(root) {
  const haystacks = [root.textContent];
  for (const el of root.querySelectorAll('*')) {
    for (const a of ['title', 'alt', 'aria-label', 'href', 'placeholder', 'value']) {
      const v = el.getAttribute(a); if (v) haystacks.push(v);
    }
    // A live input's typed value is a property, not the attribute.
    if ('value' in el && typeof el.value === 'string' && el.value) haystacks.push(el.value);
  }
  const all = haystacks.join('\n');
  for (const needle of NEEDLES) expect(all, `leaked "${needle}"`).not.toContain(needle);
}
