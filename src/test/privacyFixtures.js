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
  ...PEOPLE.emails, ...PEOPLE.emails.map(e => e.split('@')[0]),
  ...PEOPLE.phones, ...PEOPLE.phones.map(p => p.replace(/\s/g, '')), 'Joanna_Kowalczyk',
];

/**
 * No needle in the text or in any attribute of any element (a DOM clone or a
 * screen reader gets those too), nor in an input's live value. Pass
 * `document.body` to cover what a surface portals out of its container
 * (dialogs, popovers).
 *
 * Two deliberate exceptions: an editable person field masked by CSS
 * (`.mv-private-input`, ruling R14) keeps its value, since the user types into
 * it; and a message frame's `srcdoc` is the body source the frame's own
 * redaction pass masks after load (useBodyPrivacy, guarded by its own tests).
 */
export function expectNoLeak(root) {
  const haystacks = [root.textContent];
  for (const el of root.querySelectorAll('*')) {
    const typedInto = el.classList.contains('mv-private-input');
    for (const { name, value } of el.attributes) {
      if (!value || name === 'srcdoc' || (typedInto && name === 'value')) continue;
      haystacks.push(value);
    }
    // A live input's typed value is a property, not the attribute.
    if (!typedInto && 'value' in el && typeof el.value === 'string' && el.value) haystacks.push(el.value);
  }
  const all = haystacks.join('\n');
  for (const needle of NEEDLES) expect(all, `leaked "${needle}"`).not.toContain(needle);
}
