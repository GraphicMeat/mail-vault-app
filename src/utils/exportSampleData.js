// The sample mailbox every marketing surface shares: fictional studios,
// fictional people, professional mail. Nothing here belongs to anyone.
// Same cast as scripts/screenshots/demoData.js so the whole set reads as one
// mailbox rather than fifteen unrelated captures.

const at = (iso) => new Date(iso);

export const SAMPLE_MESSAGE = {
  uid: 900001,
  from: 'Ana Brandt <ana@sizzlemedia.co>',
  to: 'Rowan Marsh <rowan@primecut.studio>',
  date: at('2026-08-28T09:14:00'),
  subject: 'Brisket Sans — licence renews 4 September',
  messageId: '<sample-1@sizzlemedia.co>',
  html: `<p>Rowan,</p>
<p>The <strong>Brisket Sans</strong> licence renews on 4 September. Same seat count as last year,
so nothing to sign — the invoice will land the morning it renews.</p>
<p>One thing worth flagging: the display cut is now bundled at no extra cost. If the packaging
work is still using the text cut at 48pt and up, switching is free and it will kern properly.</p>
<p>Ana</p>
<p style="color:#6b7280;font-size:12px">Sizzle Media &middot; type licensing</p>`,
  attachments: [],
};

export const SAMPLE_THREAD = [
  {
    uid: 900010,
    from: 'Theo Lomas <theo@skewer.systems>',
    to: 'Rowan Marsh <rowan@primecut.studio>',
    date: at('2026-08-12T08:02:00'),
    subject: 'Press slot Friday 06:00 — confirmed',
    messageId: '<sample-t1@skewer.systems>',
    html: `<p>Rowan,</p><p>Friday 06:00 is confirmed on the six-colour. Plates go on Thursday evening,
so anything you want changed has to be with us by 15:00 Thursday.</p><p>Theo</p>`,
    attachments: [],
  },
  {
    uid: 900011,
    from: 'Rowan Marsh <rowan@primecut.studio>',
    to: 'Theo Lomas <theo@skewer.systems>',
    date: at('2026-08-12T09:41:00'),
    subject: 'Re: Press slot Friday 06:00 — confirmed',
    messageId: '<sample-t2@primecut.studio>',
    html: `<p>Perfect. One change on the way — the back panel copy shrank by two lines,
so the block sits 4mm higher. New PDF before lunch.</p>`,
    attachments: [],
  },
  {
    uid: 900012,
    from: 'Theo Lomas <theo@skewer.systems>',
    to: 'Rowan Marsh <rowan@primecut.studio>',
    date: at('2026-08-13T14:20:00'),
    subject: 'Re: Press slot Friday 06:00 — confirmed',
    messageId: '<sample-t3@skewer.systems>',
    html: `<p>Got it, plates updated. Proof attached in the morning — if it reads right,
we run it and you will have pallets Monday.</p><p>Theo</p>`,
    attachments: [],
  },
];

export const SAMPLE_META = { account: 'rowan@primecut.studio', mailbox: 'INBOX' };
