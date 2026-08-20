/**
 * Demo mailbox for marketing screenshots.
 *
 * One fictional studio, three accounts, one consistent cast — every screenshot
 * in the README and on the website is shot against this data, so the whole set
 * reads as one mailbox instead of fifteen unrelated captures.
 *
 * Nothing here is real: no real people, no real companies, no address that
 * belongs to anyone. Feeds the same mock IMAP server the E2E suite uses
 * (`tests/e2e/mockImap.js` → `src-mock-imap`).
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Newest message is `today - 0`; dates walk backwards from there. */
const TODAY = new Date();

/**
 * A date `daysAgo` days back, at a fixed hour so a re-shoot of one screenshot
 * still matches the rest of the set.
 */
function stamp(daysAgo, hour = 9, minute = 14) {
  const d = new Date(TODAY);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return {
    internalDate: `${dd}-${MONTHS[d.getMonth()]}-${d.getFullYear()} ${hh}:${mm}:00 +0000`,
    header: `${DOW[d.getDay()]}, ${dd} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${hh}:${mm}:00 +0000`,
  };
}

// ── The cast ────────────────────────────────────────────────────────────────
// Fictional studios, foundries and suppliers. Cheeky names, professional mail.

const CAST = {
  ana: 'Ana Brandt <ana@sizzlemedia.co>',
  theo: 'Theo Lomas <theo@skewer.systems>',
  priya: 'Priya Raines <priya@tenderloin.type>',
  dario: 'Dario Vella <dario@rackandrind.com>',
  nell: 'Nell Okafor <nell@smokehouse.design>',
  marbled: 'Marbled Coffee Co. <orders@marbledcoffee.co>',
  cleaver: 'Cleaver Cloud <billing@cleavercloud.io>',
  meatpad: 'MeatPad <release@meatpad.app>',
  flank: 'Flank & Co <talent@flankandco.com>',
  charcuterie: 'Charcuterie Weekly <dispatch@charcuterieweekly.com>',
  marinade: 'The Marinade <weekly@themarinade.news>',
  brine: 'Brine & Board <bookings@brineandboard.com>',
  welldone: 'Well Done Legal <contracts@welldonelegal.com>',
  offal: 'Offal Good <hi@offalgood.fm>',
  mediumrare: 'Medium Rare Films <production@mediumrare.film>',
  grill: 'Grill Theory <hello@grilltheory.co>',
  ledger: "Butcher's Ledger <statements@butchersledger.co>",
  drygoods: 'Dry Goods Supply <dispatch@drygoodssupply.co>',
};

const OWNER = 'Rowan Marsh <rowan@primecut.studio>';

// ── MIME builders ───────────────────────────────────────────────────────────

function headers({ from, to, subject, date, messageId, extra = [] }) {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: <${messageId}>`,
    ...extra,
    'MIME-Version: 1.0',
  ];
}

function textMessage({ uid, daysAgo, hour, minute, from, to, subject, body, seen = true, messageId, extra = [] }) {
  const { internalDate, header } = stamp(daysAgo, hour, minute);
  return {
    uid,
    flags: seen ? ['\\Seen'] : [],
    internal_date: internalDate,
    modseq: uid,
    raw: [
      ...headers({ from, to, subject, date: header, messageId: messageId || `demo-${uid}@primecut.studio`, extra }),
      'Content-Type: text/plain; charset=UTF-8',
      '',
      body,
      '',
    ].join('\n'),
  };
}

function htmlMessage({ uid, daysAgo, hour, minute, from, to, subject, text, html, seen = true, messageId, extra = [] }) {
  const { internalDate, header } = stamp(daysAgo, hour, minute);
  const boundary = 'PrimeCutAlt';
  return {
    uid,
    flags: seen ? ['\\Seen'] : [],
    internal_date: internalDate,
    modseq: uid,
    raw: [
      ...headers({ from, to, subject, date: header, messageId: messageId || `demo-html-${uid}@primecut.studio`, extra }),
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      '',
      text,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      '',
      html,
      '',
      `--${boundary}--`,
      '',
    ].join('\n'),
  };
}

/** A message carrying one small PDF attachment, so the attachment chip shows. */
function messageWithAttachment({ uid, daysAgo, hour, from, to, subject, body, filename, seen = true }) {
  const { internalDate, header } = stamp(daysAgo, hour);
  const boundary = 'PrimeCutMixed';
  // Smallest valid-enough PDF: the viewer only needs a name, size and type.
  const pdf = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
    + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
    + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n'
    + 'trailer<</Root 1 0 R>>\n%%EOF\n',
  ).toString('base64');
  return {
    uid,
    flags: seen ? ['\\Seen'] : [],
    internal_date: internalDate,
    modseq: uid,
    raw: [
      ...headers({ from, to, subject, date: header, messageId: `demo-att-${uid}@primecut.studio` }),
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      '',
      body,
      '',
      `--${boundary}`,
      'Content-Type: application/pdf',
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${filename}"`,
      '',
      pdf.replace(/(.{76})/g, '$1\n'),
      '',
      `--${boundary}--`,
      '',
    ].join('\n'),
  };
}

// ── Shared HTML shell ───────────────────────────────────────────────────────
// Inline styles only — that is what real senders ship, and it exercises the
// app's dark-mode rewrite the same way a newsletter does.

function newsletterHtml({ brand, accent, kicker, title, paragraphs, cta }) {
  return [
    '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;color:#1c1917;line-height:1.6;">',
    `<p style="margin:0 0 4px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:${accent};font-weight:700;">${brand}</p>`,
    `<p style="margin:0 0 18px;font-size:13px;color:#78716c;">${kicker}</p>`,
    `<h1 style="margin:0 0 16px;font-size:24px;line-height:1.25;font-weight:700;">${title}</h1>`,
    ...paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;">${p}</p>`),
    cta
      ? `<p style="margin:22px 0 0;"><a href="${cta.href}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;font-size:14px;">${cta.label}</a></p>`
      : '',
    '</div>',
  ].join('');
}

// ── The Rack & Rind campaign thread ─────────────────────────────────────────
// Runs across INBOX and Sent so threading, the chat view and the reply chain
// all have the same real conversation to show.

const THREAD_SUBJECT = 'Rack & Rind — launch campaign, round three';
const THREAD_ROOT = 'rr-launch-root@sizzlemedia.co';

function threadInbox(uidBase) {
  return [
    textMessage({
      uid: uidBase,
      daysAgo: 6, hour: 10, minute: 2,
      from: CAST.ana, to: OWNER,
      subject: THREAD_SUBJECT,
      messageId: THREAD_ROOT,
      body: [
        'Rowan,',
        '',
        'Round three is attached to the shared board. The client loved the type,',
        'wants the hero image warmer, and asked — politely, but they asked —',
        'whether the smoke could look "less like a fire alarm".',
        '',
        'Can we get final artwork to Skewer by Thursday? They print Friday.',
        '',
        'Ana',
      ].join('\n'),
    }),
    textMessage({
      uid: uidBase + 1,
      daysAgo: 5, hour: 16, minute: 41,
      from: CAST.dario, to: OWNER,
      subject: `Re: ${THREAD_SUBJECT}`,
      messageId: 'rr-launch-client@rackandrind.com',
      extra: [`In-Reply-To: <${THREAD_ROOT}>`, `References: <${THREAD_ROOT}>`],
      body: [
        'Adding myself to this one.',
        '',
        'Warmer hero: yes. Smoke: yes. Everything else: do not touch it, it is',
        'the first version my co-founder has not tried to redesign in Keynote.',
        '',
        'Dario',
      ].join('\n'),
    }),
    textMessage({
      uid: uidBase + 2,
      daysAgo: 3, hour: 8, minute: 27,
      from: CAST.theo, to: OWNER,
      subject: `Re: ${THREAD_SUBJECT}`,
      messageId: 'rr-launch-print@skewer.systems',
      extra: [`In-Reply-To: <${THREAD_ROOT}>`, `References: <${THREAD_ROOT}>`],
      seen: false,
      body: [
        'Press slot is held for Friday 06:00. I need print-ready PDFs by Thursday',
        'noon or the slot goes to a company that makes garden furniture.',
        '',
        'Bleed 3mm, no spot varnish this time — the last batch stuck together.',
        '',
        'Theo',
      ].join('\n'),
    }),
  ];
}

function threadSent(uidBase) {
  return [
    textMessage({
      uid: uidBase,
      daysAgo: 5, hour: 11, minute: 18,
      from: OWNER, to: CAST.ana,
      subject: `Re: ${THREAD_SUBJECT}`,
      messageId: 'rr-launch-reply-1@primecut.studio',
      extra: [`In-Reply-To: <${THREAD_ROOT}>`, `References: <${THREAD_ROOT}>`],
      body: [
        'Ana,',
        '',
        'Warmer hero is a five minute job. The smoke stays — it is the campaign —',
        'but I will bring the density down about 20% so it reads as atmosphere',
        'rather than evacuation.',
        '',
        'Thursday works. You will have print-ready PDFs Wednesday evening.',
        '',
        'Rowan',
      ].join('\n'),
    }),
    textMessage({
      uid: uidBase + 1,
      daysAgo: 2, hour: 18, minute: 5,
      from: OWNER, to: CAST.theo,
      subject: `Re: ${THREAD_SUBJECT}`,
      messageId: 'rr-launch-reply-2@primecut.studio',
      extra: [`In-Reply-To: <${THREAD_ROOT}>`, `References: <${THREAD_ROOT}>`],
      body: [
        'Theo,',
        '',
        'PDFs are with you — 3mm bleed, no varnish, fonts outlined.',
        'Keep the slot, the garden furniture people can wait.',
        '',
        'Rowan',
      ].join('\n'),
    }),
  ];
}

// ── Hero messages ───────────────────────────────────────────────────────────
// The newest and most visible rows: what a visitor actually reads in a
// screenshot. Everything below the fold is filler from the same cast.

function heroMessages(startUid) {
  let uid = startUid;
  const next = () => uid++;
  const to = OWNER;

  return [
    htmlMessage({
      uid: next(), daysAgo: 0, hour: 8, minute: 12,
      from: CAST.meatpad, to, seen: false,
      subject: 'MeatPad 0.9 — code folding, themes, and no cloud',
      text: 'MeatPad 0.9 is out: real code folding, project-wide search, editable themes.',
      html: newsletterHtml({
        brand: 'MeatPad', accent: '#c2410c',
        kicker: 'Release notes · version 0.9',
        title: 'Fold it, search it, theme it',
        paragraphs: [
          'Code folding is now syntax-defined rather than indentation-guessed, so a collapsed region reopens exactly where you left it.',
          'Project-wide search and replace landed in the same panel: grouped matches, per-file preview, one confirm.',
          'Themes are editable token by token, with a live preview and no restart.',
        ],
        cta: { label: 'Read the full notes', href: 'https://meatpad.app/releases/0-9' },
      }),
    }),
    textMessage({
      uid: next(), daysAgo: 0, hour: 7, minute: 48,
      from: CAST.theo, to, seen: false,
      subject: 'Press slot Friday 06:00 — confirmed',
      body: [
        'Rowan,',
        '',
        'Slot confirmed, plates burn tonight. Two hundred posters, matte stock,',
        'delivered to the studio Monday before ten.',
        '',
        'If anything changes tell me before 22:00 — after that the press is booked',
        'by people who will not answer their phone.',
        '',
        'Theo',
      ].join('\n'),
    }),
    messageWithAttachment({
      uid: next(), daysAgo: 1, hour: 15,
      from: CAST.cleaver, to,
      subject: 'Invoice CC-2026-0413 — paid, no strings',
      filename: 'invoice-CC-2026-0413.pdf',
      body: [
        'Thanks — payment received for August.',
        '',
        'Plan: Studio, 3 seats, 240 GB object storage.',
        'Amount: EUR 48.00. Next charge: 14 September 2026.',
        '',
        'The invoice PDF is attached for your records.',
        '',
        'Cleaver Cloud Billing',
      ].join('\n'),
    }),
    textMessage({
      uid: next(), daysAgo: 1, hour: 11, minute: 33,
      from: CAST.priya, to, seen: false,
      subject: 'Brisket Sans — licence renews 4 September',
      body: [
        'Hello Rowan,',
        '',
        'Your studio licence for Brisket Sans (5 seats, desktop + web) renews on',
        '4 September. Nothing to do if you are happy — we will invoice as usual.',
        '',
        'One note: the variable version now ships an optical size axis, so the',
        'poster weights hold up much better at small sizes.',
        '',
        'Priya',
        'Tenderloin Type Foundry',
      ].join('\n'),
    }),
    htmlMessage({
      uid: next(), daysAgo: 2, hour: 9, minute: 5,
      from: CAST.marinade, to,
      subject: 'The Marinade #142 — kerning is a slow cook',
      text: 'This week: kerning as a slow process, three studios that stopped rebranding, and a font that should not work.',
      html: newsletterHtml({
        brand: 'The Marinade', accent: '#b45309',
        kicker: 'Issue #142 · design, weekly, unhurried',
        title: 'Kerning is a slow cook',
        paragraphs: [
          'Nobody kerns a headline once. You kern it, leave it overnight, and hate it in the morning — that part is the process, not a failure of taste.',
          'Also this week: three studios that stopped rebranding mid-flight and shipped instead, and a display face with a lowercase g that has no business working as well as it does.',
        ],
        cta: { label: 'Read issue #142', href: 'https://themarinade.news/142' },
      }),
    }),
    textMessage({
      uid: next(), daysAgo: 2, hour: 14, minute: 20,
      from: CAST.welldone, to,
      subject: 'Medium Rare Films — NDA countersigned',
      body: [
        'Rowan,',
        '',
        'Countersigned copy is on file. Two changes from their draft: the term is',
        'now two years rather than five, and the confidentiality clause no longer',
        'covers "ideas discussed in passing", which was doing a lot of work.',
        '',
        'You are clear to start on the title sequence.',
        '',
        'Sana Whitlock',
        'Well Done Legal',
      ].join('\n'),
    }),
    textMessage({
      uid: next(), daysAgo: 3, hour: 12, minute: 40,
      from: CAST.brine, to,
      subject: 'Table for six, Thursday 19:30 — confirmed',
      body: [
        'Booked and confirmed: six people, Thursday 19:30, the long table at the back.',
        '',
        'The kitchen has noted one vegetarian and one guest who "does not eat',
        'anything that looks back". We have interpreted that generously.',
        '',
        'Brine & Board',
      ].join('\n'),
    }),
    htmlMessage({
      uid: next(), daysAgo: 4, hour: 10, minute: 10,
      from: CAST.marbled, to,
      subject: 'Your House Blend is on the way',
      text: 'Order #4417 shipped: 2 kg House Blend, whole bean. Arriving Thursday.',
      html: newsletterHtml({
        brand: 'Marbled Coffee Co.', accent: '#7c2d12',
        kicker: 'Order #4417 · shipped',
        title: 'Two kilos, whole bean, on the way',
        paragraphs: [
          'Roasted Tuesday, packed Wednesday, and out for delivery Thursday — the studio subscription rate is applied.',
          'Grind setting for the machine you told us about: two clicks coarser than last time.',
        ],
        cta: { label: 'Track the delivery', href: 'https://marbledcoffee.co/orders/4417' },
      }),
    }),
    textMessage({
      uid: next(), daysAgo: 4, hour: 16, minute: 55,
      from: CAST.nell, to,
      subject: 'Studio swap: can you take the Tuesday slot?',
      body: [
        'Rowan — can you take the Tuesday photo studio slot? Our shoot moved and',
        "I would rather it went to you than back to the pool. It is the big cyc",
        'wall, 9:00 to 15:00, lighting kit included.',
        '',
        'Nell',
      ].join('\n'),
    }),
    textMessage({
      uid: next(), daysAgo: 5, hour: 13, minute: 25,
      from: CAST.flank, to, seen: false,
      subject: 'Brand designer role — three candidates worth your Friday',
      body: [
        'Rowan,',
        '',
        'Three shortlisted, all senior, all available within a month. Portfolios and',
        'notes are in the shared folder — the second one has the strongest editorial',
        'work I have seen this year and the weakest website, which I suspect you',
        'will find reassuring rather than alarming.',
        '',
        'Marta',
        'Flank & Co',
      ].join('\n'),
    }),
    textMessage({
      uid: next(), daysAgo: 7, hour: 9, minute: 30,
      from: CAST.offal, to,
      subject: "Episode 31 — you're on for the 12th",
      body: [
        'You are booked for episode 31, recording the 12th at 14:00.',
        '',
        'Topic as agreed: why studios keep their own archives, and what happens the',
        'day a provider decides eight years of mail is a storage problem.',
        '',
        'Offal Good',
      ].join('\n'),
    }),
    htmlMessage({
      uid: next(), daysAgo: 8, hour: 11, minute: 45,
      from: CAST.charcuterie, to,
      subject: 'Charcuterie Weekly — the board, assembled',
      text: 'Six boards, one rule: nothing on the plate that needs explaining.',
      html: newsletterHtml({
        brand: 'Charcuterie Weekly', accent: '#9f1239',
        kicker: 'Weekly dispatch · issue 88',
        title: 'Six boards, one rule',
        paragraphs: [
          'Nothing on the plate that needs explaining. If a guest has to ask what it is twice, it is a garnish, not a course.',
          'Also: the correct number of cheeses is three, and we will be taking no correspondence on the matter.',
        ],
        cta: null,
      }),
    }),
  ];
}

// ── Filler ──────────────────────────────────────────────────────────────────
// Below-the-fold rows. Same cast, plausible subjects, no lorem ipsum and no
// "Message 47" — a screenshot is read at full size and repetition shows.

const FILLER = [
  [CAST.grill, 'Quarterly review: less char, more flavour'],
  [CAST.drygoods, 'Dispatch note DG-8841 — paper stock back in'],
  [CAST.ledger, 'August statement is ready'],
  [CAST.ana, 'Moodboard for the autumn shoot'],
  [CAST.theo, 'Proof collected — signed for at reception'],
  [CAST.priya, 'Trial licence for Rind Display, 30 days'],
  [CAST.mediumrare, 'Title sequence — first look Friday?'],
  [CAST.nell, 'Studio insurance renewal, forwarding for your records'],
  [CAST.marbled, 'Subscription paused as requested'],
  [CAST.dario, 'Two small notes on the deck, nothing structural'],
  [CAST.cleaver, 'Storage report: 62% of your plan'],
  [CAST.flank, 'Contract signed — start date confirmed'],
  [CAST.welldone, 'Retainer terms, redlined'],
  [CAST.charcuterie, 'Issue 87: the case against the giant board'],
  [CAST.marinade, 'The Marinade #141 — a font with a temper'],
  [CAST.brine, 'Your table is confirmed for the 4th'],
  [CAST.offal, 'Draft questions for episode 31'],
  [CAST.grill, 'Workshop places open — two left'],
  [CAST.drygoods, 'Back-order cleared: cotton rag, 300gsm'],
  [CAST.ledger, 'Standing order updated'],
  [CAST.ana, 'Re: Moodboard for the autumn shoot'],
  [CAST.theo, 'Foil stamping quote for the box sleeves'],
  [CAST.priya, 'Rind Display is out of beta'],
  [CAST.mediumrare, 'Location scout photos, batch two'],
  [CAST.nell, 'Cyc wall repainted — booking rules changed'],
  [CAST.marbled, 'Your subscription resumes Monday'],
  [CAST.dario, 'Board deck for the investor update'],
  [CAST.cleaver, 'Scheduled maintenance, Sunday 02:00–04:00'],
  [CAST.flank, 'Two more portfolios worth ten minutes'],
  [CAST.welldone, 'Re: Retainer terms, redlined'],
  [CAST.charcuterie, 'Issue 86: brine times, settled'],
  [CAST.marinade, 'The Marinade #140 — the em dash discourse'],
  [CAST.brine, 'Menu change for Thursday'],
  [CAST.offal, 'Episode 30 is live'],
  [CAST.grill, 'Certificates from the June workshop'],
  [CAST.drygoods, 'Price list, valid to December'],
  [CAST.ledger, 'Card ending 4417 expires next month'],
  [CAST.mediumrare, 'Re: Title sequence — first look Friday?'],
  [CAST.nell, 'Smokehouse open studio, 14th'],
  [CAST.cleaver, 'Two-factor is now on for your team'],
];

const FILLER_BODIES = [
  'Short one — details are in the shared folder, shout if anything is missing.',
  'No action needed, keeping you in the loop so it is on record.',
  'Confirming what we agreed on the call this morning. Nothing has changed.',
  'Numbers attached below. Happy to walk through them whenever suits.',
  'This is the third version and, I think, the last one. Famous last words.',
];

function fillerMessages(startUid, count, startDaysAgo) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const [from, subject] = FILLER[i % FILLER.length];
    const daysAgo = startDaysAgo + Math.floor(i * 1.7);
    out.push(textMessage({
      uid: startUid + i,
      daysAgo,
      hour: 8 + (i % 10),
      minute: (i * 7) % 60,
      from,
      to: OWNER,
      subject: i < FILLER.length ? subject : `Re: ${subject}`,
      seen: i % 7 !== 3,
      body: `${FILLER_BODIES[i % FILLER_BODIES.length]}\n\n— sent from the studio`,
    }));
  }
  return out;
}

// ── Security demo messages ──────────────────────────────────────────────────
// Two shapes the app warns about, both fictional: a link whose text is not its
// destination, and a Reply-To that is not the sender.

function phishingMessage(uid) {
  return htmlMessage({
    uid,
    daysAgo: 1, hour: 6, minute: 3,
    from: "Butcher's Ledger Security <alerts@butchersledger-secure.help>",
    to: OWNER,
    seen: false,
    subject: 'Action required: your August payment could not be processed',
    text: 'Your payment could not be processed. Confirm your details to avoid interruption.',
    html: [
      '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;color:#1c1917;line-height:1.6;">',
      '<h2 style="margin:0 0 12px;font-size:20px;">We could not process your August payment</h2>',
      '<p style="margin:0 0 14px;font-size:15px;">Your account will be limited within 24 hours unless the payment method is confirmed.</p>',
      '<p style="margin:0 0 14px;font-size:15px;">Confirm here: '
        + '<a href="https://butchersledger-secure.help/verify/session?id=8842">https://butchersledger.co/account/billing</a></p>',
      '<p style="margin:0;font-size:13px;color:#78716c;">Butcher\'s Ledger · automated notice</p>',
      '</div>',
    ].join(''),
  });
}

function replyToMismatchMessage(uid) {
  return textMessage({
    uid,
    daysAgo: 2, hour: 7, minute: 22,
    from: CAST.marbled,
    to: OWNER,
    seen: false,
    subject: 'Refund for order #4417 — confirm your bank details',
    extra: ['Reply-To: refunds@marbled-support.help'],
    body: [
      'We are processing a refund for order #4417.',
      '',
      'Reply to this message with the account the refund should be sent to and we',
      'will release it within one working day.',
      '',
      'Marbled Coffee Co. Customer Care',
    ].join('\n'),
  });
}

// ── Mailboxes ───────────────────────────────────────────────────────────────

function box(name, messages, attrs = ['\\HasNoChildren']) {
  const maxUid = messages.reduce((max, m) => Math.max(max, m.uid), 0);
  return {
    name,
    attrs,
    uid_validity: 1,
    uid_next: maxUid + 1,
    highest_modseq: maxUid + 1,
    messages,
  };
}

/** Work account: the mailbox every hero screenshot is taken from. */
export function studioScenario() {
  const hero = heroMessages(200);
  const heroTop = hero.reduce((max, m) => Math.max(max, m.uid), 0);
  const thread = threadInbox(heroTop + 1);
  const security = [phishingMessage(heroTop + 10), replyToMismatchMessage(heroTop + 11)];
  const filler = fillerMessages(100, 64, 9);

  return {
    // Stall FULL-BODY fetches only — `BODY.PEEK[]`, not the
    // `BODY.PEEK[HEADER.FIELDS (…)]` pages the list is built from. Opening one
    // message costs 350ms; archiving 66 of them takes ~20s, which is the only
    // way to photograph a progress bar that an un-faulted loopback mock
    // finishes before the shutter opens.
    faults: [{
      trigger: { OnCommandWith: ['FETCH', 'BODY.PEEK[]'] },
      action: { Delay: { secs: 0, nanos: 350000000 } },
    }],
    state: {
      mailboxes: [
        box('INBOX', [...filler, ...hero, ...thread, ...security]),
        box('Sent', [
          ...threadSent(400),
          textMessage({
            uid: 410, daysAgo: 1, hour: 17, minute: 12,
            from: OWNER, to: CAST.priya,
            subject: 'Re: Brisket Sans — licence renews 4 September',
            body: 'Happy to renew. Same five seats, invoice to accounts@primecut.studio please.\n\nRowan',
          }),
          textMessage({
            uid: 411, daysAgo: 3, hour: 9, minute: 2,
            from: OWNER, to: CAST.nell,
            subject: 'Re: Studio swap: can you take the Tuesday slot?',
            body: 'Taking it — thank you. I will bring the good lens and leave the cyc wall cleaner than I found it.\n\nRowan',
          }),
          textMessage({
            uid: 412, daysAgo: 6, hour: 15, minute: 40,
            from: OWNER, to: CAST.dario,
            subject: 'Rack & Rind — invoice 0119 attached',
            body: 'Dario — invoice 0119 for round three, 30 days as usual.\n\nRowan',
          }),
        ], ['\\HasNoChildren', '\\Sent']),
        box('Archive', fillerMessages(600, 12, 40), ['\\HasNoChildren', '\\Archive']),
        box('Drafts', [], ['\\HasNoChildren', '\\Drafts']),
        box('Trash', [], ['\\HasNoChildren', '\\Trash']),
        box('Clients', fillerMessages(700, 9, 25)),
        box('Suppliers', fillerMessages(800, 7, 30)),
      ],
    },
  };
}

/** Personal account: quieter, so account switching visibly changes the list. */
export function personalScenario() {
  const owner = 'Rowan Marsh <rowan.marsh@gmail.com>';
  const messages = [
    textMessage({
      uid: 300, daysAgo: 0, hour: 12, minute: 5, seen: false,
      from: CAST.brine, to: owner,
      subject: 'Saturday, 20:00 — the usual table',
      body: 'Held for four. The kitchen is doing the short rib again, which we know is why you are coming.',
    }),
    textMessage({
      uid: 301, daysAgo: 2, hour: 19, minute: 30,
      from: 'Ida Marsh <ida.marsh@fastmail.example>', to: owner,
      subject: 'Photos from the weekend',
      body: 'Sending the good ones only. The rest are of my thumb.\n\nIda',
    }),
    textMessage({
      uid: 302, daysAgo: 5, hour: 8, minute: 15,
      from: CAST.grill, to: owner,
      subject: 'Your workshop place is confirmed',
      body: 'Saturday the 12th, 10:00. Bring an apron and low expectations.',
    }),
    ...fillerMessages(310, 28, 6),
  ];
  return {
    state: {
      mailboxes: [
        box('INBOX', messages),
        box('Sent', fillerMessages(500, 6, 3), ['\\HasNoChildren', '\\Sent']),
        box('Archive', fillerMessages(560, 5, 30), ['\\HasNoChildren', '\\Archive']),
        box('Drafts', [], ['\\HasNoChildren', '\\Drafts']),
        box('Trash', [], ['\\HasNoChildren', '\\Trash']),
      ],
    },
    faults: [],
  };
}

/** Billing account: invoices only — gives the unified inbox a third colour. */
export function billingScenario() {
  const owner = 'Prime Cut Studio <accounts@primecut.studio>';
  return {
    state: {
      mailboxes: [
        box('INBOX', [
          messageWithAttachment({
            uid: 320, daysAgo: 1, hour: 10,
            from: CAST.ledger, to: owner,
            subject: 'August statement — Prime Cut Studio',
            filename: 'statement-august-2026.pdf',
            body: 'Your August statement is attached. Closing balance and the two standing orders are unchanged.',
          }),
          textMessage({
            uid: 321, daysAgo: 3, hour: 11, minute: 20, seen: false,
            from: CAST.dario, to: owner,
            subject: 'Invoice 0119 — scheduled for the 30th',
            body: 'Approved and scheduled for the 30th. Accounts have it, nobody has to chase anybody.\n\nDario',
          }),
          ...fillerMessages(330, 18, 4),
        ]),
        box('Sent', fillerMessages(520, 4, 5), ['\\HasNoChildren', '\\Sent']),
        box('Archive', fillerMessages(580, 6, 60), ['\\HasNoChildren', '\\Archive']),
        box('Drafts', [], ['\\HasNoChildren', '\\Drafts']),
        box('Trash', [], ['\\HasNoChildren', '\\Trash']),
      ],
    },
    faults: [],
  };
}

/** Accounts in sidebar order. Ids must be 36-char UUIDs (see wdio.conf.js). */
export const DEMO_ACCOUNTS = [
  {
    id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    email: 'rowan@primecut.studio',
    name: 'Prime Cut Studio',
    scenario: studioScenario,
  },
  {
    id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
    email: 'rowan.marsh@gmail.com',
    name: 'Rowan Marsh',
    scenario: personalScenario,
  },
  {
    id: 'cccccccc-3333-4333-8333-cccccccccccc',
    email: 'accounts@primecut.studio',
    name: 'Studio Accounts',
    scenario: billingScenario,
  },
];

/** Subjects the capture script needs to find specific rows. */
export const MARKERS = {
  thread: THREAD_SUBJECT,
  phishing: 'Action required: your August payment could not be processed',
  replyTo: 'Refund for order #4417 — confirm your bank details',
  newsletter: 'MeatPad 0.9 — code folding, themes, and no cloud',
  invoice: 'Invoice CC-2026-0413 — paid, no strings',
};
