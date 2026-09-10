// Synthetic mail only. No default Luke/Vader fixtures or real user data.
const FIRST = '41111111-1111-4111-8111-111111111111';
const SECOND = '42222222-2222-4222-8222-222222222222';
const OWNER = 'me@insights.test';
const OTHER_OWNER = 'other-me@insights.test';

function message({ uid, from, to = OWNER, subject, id, day = '09', time = '12:00:00', headerDay = day, headerTime = time, extra = [], flags = [] }) {
  return { uid, flags, internal_date: `${day}-Sep-2026 ${time} +0000`, modseq: uid,
    raw: [
      `From: ${from}`, `To: ${to}`, `Subject: ${subject}`,
      `Date: ${headerDay} Sep 2026 ${headerTime} +0000`, `Message-ID: <${id}@fixture.test>`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', ...extra,
      '', `INSIGHTS BODY ${id}. ${subject}. Recipient ${to}.`, '',
    ].join('\r\n') };
}
function mailbox(name, messages, specialUse) {
  const next = Math.max(0, ...messages.map(m => m.uid)) + 1;
  return { name, attrs: ['\\HasNoChildren', ...(specialUse ? [specialUse] : [])], uid_validity: 101,
    uid_next: next, highest_modseq: next, messages };
}

/** Returns actual mock-server Scenario payloads and independently stated oracles. */
export function buildInsightsScenario({ inboxCount = 700 } = {}) {
  if (!Number.isInteger(inboxCount) || inboxCount < 700) throw new Error('Insights scenario needs at least 700 messages');
  const inbox = Array.from({ length: inboxCount }, (_, index) => {
    const uid = index + 1;
    if (uid <= 100) return message({ uid, from: 'Old contact <old@insights.test>', subject: `Old contact ${uid}`, id: `old-${uid}`, day: '01' });
    if (uid <= 110) return message({ uid, from: 'Recent contact <recent@insights.test>', subject: `Recent contact ${uid}`, id: `recent-${uid}` });
    if (uid === 111) return message({ uid, from: 'Automated digest <no-reply@insights.test>', subject: 'Automated digest', id: 'automated', extra: ['List-Id: Digest <digest.insights.test>', 'List-Unsubscribe: <https://example.test/unsubscribe>'] });
    if (uid === 112) return message({ uid, from: 'Boundary sender <boundary@insights.test>', subject: 'Receive time boundary', id: 'insights-boundary', day: '08', time: '22:30:00', headerDay: '08', headerTime: '19:00:00' });
    const contact = (uid - 113) % 40;
    return message({ uid, from: `Correspondent ${contact} <person${String(contact).padStart(2, '0')}@insights.test>`, subject: `Inventory message ${uid}`, id: `inventory-${uid}`, day: '04' });
  });
  const firstBoxes = [
    mailbox('INBOX', inbox),
    mailbox('Sent', [
      message({ uid: 1, from: OWNER, to: 'ana@insights.test, bob@insights.test, carol@insights.test', subject: 'Three recipients, one send', id: 'sent-multi', flags: ['\\Seen'] }),
      message({ uid: 2, from: OWNER, to: 'old@insights.test', subject: 'A sent reply', id: 'sent-reply', flags: ['\\Seen'] }),
      message({ uid: 3, from: OWNER, subject: 'A note to myself', id: 'self-mail', flags: ['\\Seen'] }),
    ], '\\Sent'),
    mailbox('Archive', [{ ...inbox[699], uid: 1 }], '\\Archive'),
    mailbox('Projects/Archive', [message({ uid: 1, from: 'Nested sender <nested@insights.test>', subject: 'Nested project record', id: 'nested' })]),
    mailbox('Drafts', [message({ uid: 1, from: OWNER, to: 'unsent@insights.test', subject: 'Unsent draft excluded', id: 'draft', flags: ['\\Draft'] })], '\\Drafts'),
    mailbox('Trash', [message({ uid: 1, from: 'trash@insights.test', subject: 'Trash excluded', id: 'trash' })], '\\Trash'),
    mailbox('Junk', [message({ uid: 1, from: 'junk@insights.test', subject: 'Junk excluded', id: 'junk' })], '\\Junk'),
  ];
  const secondBoxes = [mailbox('INBOX', [message({ uid: 1, from: 'Other account sender <other-account@insights.test>', to: OTHER_OWNER, subject: 'Another account, same UID', id: 'account-b' })])];
  return {
    accounts: [
      { id: FIRST, email: OWNER, name: 'Insights primary', inbox: inboxCount, scenario: { state: { mailboxes: firstBoxes }, faults: [], smtp: {} } },
      { id: SECOND, email: OTHER_OWNER, name: 'Insights second', inbox: 1, scenario: { state: { mailboxes: secondBoxes }, faults: [], smtp: {} } },
    ],
    // 700 Inbox + nested + second account + one self-mail receipt. Sent has
    // three messages; one physical Archive copy deduplicates with Inbox 700.
    expected: { startDate: '2026-09-01', endDate: '2026-09-30', received: inboxCount + 3, sent: 3, both: inboxCount + 6,
      receivedWithoutAutomated: inboxCount + 2, physicalIncluded: inboxCount + 6,
      daysEuropeVilnius: { '2026-09-01': { received: 100, sent: 0 }, '2026-09-04': { received: inboxCount - 112, sent: 0 }, '2026-09-09': { received: 15, sent: 3 } },
      oldSenderReceived: 100, recentSenderReceived: 10, excludedDraftsTrashJunk: 3 },
    // The Insights UI selects one account. Keep the cross-account inventory
    // oracle above for native snapshot checks, and state this scope explicitly.
    firstAccountExpected: { received: inboxCount + 2, sent: 3, both: inboxCount + 5,
      receivedWithoutAutomated: inboxCount + 1 },
  };
}
