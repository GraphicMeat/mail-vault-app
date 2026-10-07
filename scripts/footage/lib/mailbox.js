/**
 * The mailbox a footage run boots on: the marketing demo mailbox
 * (scripts/screenshots/demoData.js), with three footage-only changes made to
 * the scenario objects before they reach the mock IMAP server. Nothing in the
 * demo module or the app changes.
 *
 * 1. Text patches (FOOTAGE_PATCH_TEXT, default on). The preview video must not
 *    show a price, a version number, a real product or an em dash, and the demo
 *    mailbox has one of each where the camera looks: the first row
 *    ("MeatPad 0.9"), the invoice body ("EUR 48.00"), a thread bubble
 *    ("Keynote"), and the em dash in half the subjects. `PATCHES` lists every
 *    substitution; each one is applied to the raw MIME source.
 *
 * 2. A multi-year history in the work account's INBOX (FOOTAGE_HISTORY):
 *    a few thousand older messages from the same fictional cast, spread over
 *    the years before the demo's own mail, so Explorer has years to open,
 *    Insights has a real map, search finds more than two hits and the bulk
 *    dialog offers a year to clear. History uids sit BELOW the demo's (the demo
 *    INBOX is renumbered above them), so nothing that walks uids newest-first
 *    surfaces 2022 mail before the hero rows.
 *
 * 3. The body-fetch stall (FOOTAGE_BODY_DELAY_MS). The demo holds every
 *    `BODY.PEEK[]` for 350 ms so an archive's progress bar is readable; a
 *    reading take wants it gone (0) and the archive take wants it tuned.
 */
import { deflateSync } from 'node:zlib';
import { demoScenarios } from '../../screenshots/demoData.js';
import { TIER2C_ON, tier2cMessages } from './tier2cMail.js';
import { TIER3B_ON, tier3bMessages } from './tier3bMail.js';

// ── 1. Text patches ─────────────────────────────────────────────────────────

/** [from, to] on the raw MIME source, in order. Specific before general. */
export const PATCHES = [
  ['MeatPad 0.9 is out: ', 'MeatPad is out: '],
  ['MeatPad 0.9', 'MeatPad'],
  ['Release notes · version 0.9', 'Release notes'],
  ['Amount: EUR 48.00. ', ''],
  ['redesign in Keynote.', 'redesign in a slide deck.'],
  ['rowan.marsh@gmail.com', 'rowan@marshfamily.me'],
  ['ida.marsh@fastmail.example', 'ida@marshfamily.me'],
  ['\u2014', '-'], // em dash, written as an escape
];

const PATCH_ON = process.env.FOOTAGE_PATCH_TEXT !== '0';

export function patchText(s) {
  if (!PATCH_ON || typeof s !== 'string') return s;
  let out = s;
  for (const [from, to] of PATCHES) out = out.split(from).join(to);
  return out;
}

// ── 2. History ──────────────────────────────────────────────────────────────

const DEFAULT_HISTORY = { 2022: 420, 2023: 560, 2024: 700, 2025: 820, 2026: 260 };

/**
 * FOOTAGE_HISTORY: unset / "0" = none; "1" = the default spread;
 * "2022:420,2023:560,..." = messages per year.
 */
export function historySpec(value = process.env.FOOTAGE_HISTORY) {
  if (!value || value === '0') return null;
  if (value === '1' || value === 'default') return { ...DEFAULT_HISTORY };
  const spec = {};
  for (const part of value.split(',')) {
    const [y, n] = part.split(':').map((x) => Number(x.trim()));
    if (y > 1990 && n > 0) spec[y] = n;
  }
  return Object.keys(spec).length ? spec : null;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const CLIENTS = ['Rack & Rind', 'Smokehouse', 'Medium Rare Films', 'Brine & Board', 'Grill Theory', 'Marbled Coffee'];
const SEASONS = ['spring', 'summer', 'autumn', 'winter'];

const OWNER = 'Rowan Marsh <rowan@primecut.studio>';

/**
 * The demo's own fictional cast (scripts/screenshots/demoData.js CAST), with
 * how often each writes and what about. `{c}` client, `{n}` small number,
 * `{d}` weekday, `{m}` month name, `{y}` year, `{s}` season, `{k}` 4-digit ref.
 */
const CAST = [
  { from: 'Ana Brandt <ana@sizzlemedia.co>', w: 14, sign: 'Ana', subjects: [
    'Moodboard for the {s} shoot', 'Round {n} of the {c} deck', 'Shared board updated for {c}',
    'Quick call about the {c} brief?', 'Notes from the {c} review', 'Hero image options for {c}'] },
  { from: 'Theo Lomas <theo@skewer.systems>', w: 12, sign: 'Theo', subjects: [
    'Press slot {d} 06:00', 'Proofs ready for collection', 'Paper stock for the {c} run',
    'Foil samples arrived', 'Print schedule for {m}', 'Bleed and trim for the {c} posters'] },
  { from: 'Dario Vella <dario@rackandrind.com>', w: 10, sign: 'Dario', subjects: [
    'Rack & Rind launch plan', 'Feedback on round {n}', 'Board meeting notes, {m}',
    'Can we move the review to {d}?', 'Packaging refresh, first thoughts'] },
  { from: 'Priya Raines <priya@tenderloin.type>', w: 6, sign: 'Priya', subjects: [
    'Font licence for {c}', 'New weights in Brisket Sans', 'Specimen PDFs attached', 'Rind Display trial'] },
  { from: 'Nell Okafor <nell@smokehouse.design>', w: 7, sign: 'Nell', subjects: [
    'Studio swap for {d}?', 'Cyc wall booking in {m}', 'Lighting kit is back in the studio', 'Open studio this {d}'] },
  { from: 'Marbled Coffee Co. <orders@marbledcoffee.co>', w: 5, sign: 'Marbled Coffee Co.', subjects: [
    'Your House Blend is on the way', 'Order confirmed', 'Subscription update for {m}'] },
  { from: 'Cleaver Cloud <billing@cleavercloud.io>', w: 6, sign: 'Cleaver Cloud Billing', subjects: [
    'Invoice CC-{y}-{k}', 'Invoice CC-{y}-{k} is ready', 'Storage report for {m}', 'Scheduled maintenance on {d}'] },
  { from: 'MeatPad <release@meatpad.app>', w: 4, sign: 'The MeatPad team', subjects: [
    'MeatPad release notes', 'Tips: project-wide search', 'Themes you can edit, token by token'] },
  { from: 'Flank & Co <talent@flankandco.com>', w: 3, sign: 'Marta', subjects: [
    'Candidates for the designer role', 'Interview schedule for {d}', 'Two portfolios worth ten minutes'] },
  { from: 'Charcuterie Weekly <dispatch@charcuterieweekly.com>', w: 8, sign: 'Charcuterie Weekly', subjects: [
    'Charcuterie Weekly, issue {k}', 'The board, assembled: issue {k}'] },
  { from: 'The Marinade <weekly@themarinade.news>', w: 8, sign: 'The Marinade', subjects: [
    'The Marinade #{k}', 'The Marinade #{k}: slow type, fast studios'] },
  { from: 'Brine & Board <bookings@brineandboard.com>', w: 4, sign: 'Brine & Board', subjects: [
    'Table for {n}, {d} 19:30', 'Your booking is confirmed', 'Menu change for {d}'] },
  { from: 'Well Done Legal <contracts@welldonelegal.com>', w: 3, sign: 'Sana Whitlock', subjects: [
    'Contract for {c}, countersigned', 'Retainer terms, redlined', 'Invoice for the {c} retainer'] },
  { from: 'Offal Good <hi@offalgood.fm>', w: 2, sign: 'Offal Good', subjects: [
    'Episode {k} is live', 'Guest questions for episode {k}'] },
  { from: 'Medium Rare Films <production@mediumrare.film>', w: 3, sign: 'Medium Rare Films', subjects: [
    'Title sequence, first look', 'Location scout photos', 'Call sheet for {d}'] },
  { from: 'Grill Theory <hello@grilltheory.co>', w: 3, sign: 'Grill Theory', subjects: [
    'Workshop places open', 'Certificates from the {m} workshop'] },
  { from: "Butcher's Ledger <statements@butchersledger.co>", w: 5, sign: "Butcher's Ledger", subjects: [
    '{m} statement is ready', 'Invoice {y}-{k} received', 'Standing order updated'] },
  { from: 'Dry Goods Supply <dispatch@drygoodssupply.co>', w: 4, sign: 'Dry Goods Supply', subjects: [
    'Dispatch note DG-{k}', 'Invoice DG-{k} for paper stock', 'Cotton rag back in stock'] },
];

const BODIES = [
  'Details are in the shared folder, shout if anything is missing.',
  'No action needed, keeping you in the loop so it is on record.',
  'Confirming what we agreed on the call this morning.',
  'Attached for your records.',
  'This is the third version and, I think, the last one.',
  'Happy to walk through it whenever suits.',
  'The files are on the board, same folder as last time.',
  'Let me know by the end of the week if anything needs to change.',
  'We are on schedule, nothing to worry about.',
  'Thanks again for the quick turnaround.',
];

function fill(template, r, date) {
  return template
    .replace('{c}', CLIENTS[Math.floor(r() * CLIENTS.length)])
    .replace('{n}', String(2 + Math.floor(r() * 5)))
    .replace('{d}', DAYS[Math.floor(r() * DAYS.length)])
    .replace('{m}', MONTH_NAMES[date.getUTCMonth()])
    .replace('{y}', String(date.getUTCFullYear()))
    .replace('{s}', SEASONS[Math.floor(date.getUTCMonth() / 3)])
    .replace(/\{k\}/g, String(1000 + Math.floor(r() * 8999)));
}

const p2 = (n) => String(n).padStart(2, '0');

/**
 * The history, oldest first, uids 1..N. `newestDaysAgo`: the newest history
 * message is this many days before today (the demo's own INBOX reaches back
 * about 116 days, so history starts just behind it).
 */
export function historyMessages(spec, { newestDaysAgo = 125, seed = 20260929 } = {}) {
  const r = rng(seed);
  const now = Date.now();
  const newest = now - newestDaysAgo * 86400000;
  const totalW = CAST.reduce((a, c) => a + c.w, 0);
  const pickSender = () => {
    let x = r() * totalW;
    for (const c of CAST) { x -= c.w; if (x <= 0) return c; }
    return CAST[0];
  };
  const stamps = [];
  for (const [yearStr, count] of Object.entries(spec)) {
    const year = Number(yearStr);
    const start = Date.UTC(year, 0, 1);
    const end = Math.min(Date.UTC(year + 1, 0, 1) - 1, newest);
    if (end <= start) continue;
    for (let i = 0; i < count; i++) stamps.push(start + Math.floor(r() * (end - start)));
  }
  stamps.sort((a, b) => a - b);
  return stamps.map((ms, i) => {
    const uid = i + 1;
    const d = new Date(ms);
    // Working hours, on the minute.
    d.setUTCHours(7 + Math.floor(r() * 12), Math.floor(r() * 60), 0, 0);
    const c = pickSender();
    const subject = fill(c.subjects[Math.floor(r() * c.subjects.length)], r, d);
    const pool = [...BODIES];
    const lines = [];
    const n = 2 + Math.floor(r() * 4);
    for (let k = 0; k < n; k++) lines.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
    const internalDate = `${p2(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:00 +0000`;
    const header = `${DOW[d.getUTCDay()]}, ${p2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:00 +0000`;
    return {
      uid,
      flags: ['\\Seen'],
      internal_date: internalDate,
      modseq: uid,
      raw: realisticMime({ uid, from: c.from, sign: c.sign, subject, header, lines, date: d, r }),
    };
  });
}

// Real mail is rarely 400 bytes: a vault listing (S7) should show the sizes
// a real one has. So most history messages carry an HTML alternative, some
// quote the message they answer, and invoices and proofs carry a PDF.

const QUOTE = [
  'Can you send the latest files when you get a minute?',
  'We are aiming to sign off by the end of the week.',
  'The client asked for one more round on the colours.',
  'Let me know which slot works for the shoot.',
  'Attaching the notes from yesterday so we are all looking at the same list.',
  'No rush on this one, next week is fine.',
  'I have copied Theo so the print side is in the loop.',
  'Here is the brief as it stands after the call.',
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A small but valid PDF of `pages` text pages, base64 in 76-char lines. */
function pdfAttachment(title, pages) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = [];
  const pageObjs = [];
  for (let p = 0; p < pages; p++) {
    const pageNo = 4 + p * 2;
    kids.push(`${pageNo} 0 R`);
    let stream = 'BT /F1 11 Tf 56 780 Td 14 TL\n';
    stream += `(${title} - page ${p + 1}) Tj T*\n`;
    for (let l = 0; l < 48; l++) stream += `(${QUOTE[(p * 7 + l) % QUOTE.length]}) Tj T*\n`;
    stream += 'ET';
    pageObjs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageNo + 1} 0 R >>`);
    pageObjs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objs.push(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objs.push(...pageObjs);
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf).toString('base64').replace(/(.{76})/g, '$1\n');
}

function realisticMime({ uid, from, sign, subject, header, lines, date, r }) {
  const head = [
    `From: ${from}`,
    `To: ${OWNER}`,
    `Subject: ${subject}`,
    `Date: ${header}`,
    `Message-ID: <hist-${uid}@primecut.studio>`,
    'MIME-Version: 1.0',
  ];
  const quoted = r() < 0.5;
  // Newsletters are long HTML documents: a stack of article blocks.
  const newsletter = /Marinade|Charcuterie|MeatPad/.test(from);
  const articles = newsletter ? Array.from({ length: 6 + Math.floor(r() * 7) }, (_, k) => [
    `<table role="presentation" width="100%" style="margin:0 0 22px;border-collapse:collapse;"><tr><td style="padding:0 0 6px;font-size:18px;font-weight:700;color:#1c1917;">${esc(QUOTE[(uid + k) % QUOTE.length].replace(/[.?]$/, ''))}</td></tr>`,
    ...[0, 1, 2].map((j) => `<tr><td style="padding:0 0 8px;font-size:15px;line-height:1.6;color:#44403c;">${esc(BODIES[(uid + k + j) % BODIES.length])} ${esc(QUOTE[(uid + k * 2 + j) % QUOTE.length])} ${esc(BODIES[(uid * 3 + k + j) % BODIES.length])}</td></tr>`),
    `<tr><td style="padding:4px 0 0;"><a href="https://example.com/read/${uid}-${k}" style="color:#b45309;font-weight:600;text-decoration:none;">Read more</a></td></tr></table>`,
  ].join('\n')) : [];
  const qLines = quoted ? Array.from({ length: 5 + Math.floor(r() * 9) }, (_, k) => QUOTE[(uid + k * 3) % QUOTE.length]) : [];
  const qDate = new Date(date.getTime() - (1 + Math.floor(r() * 6)) * 86400000);
  const qHead = `On ${DOW[qDate.getUTCDay()]}, ${p2(qDate.getUTCDate())} ${MONTHS[qDate.getUTCMonth()]} ${qDate.getUTCFullYear()}, Rowan Marsh <rowan@primecut.studio> wrote:`;
  const text = ['Rowan,', '', ...lines, '', sign, ...(quoted ? ['', qHead, ...qLines.map((l) => `> ${l}`)] : [])].join('\n');
  const html = [
    '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#1c1917;">',
    '<p style="margin:0 0 12px;">Rowan,</p>',
    ...lines.map((l) => `<p style="margin:0 0 12px;">${esc(l)}</p>`),
    ...articles,
    `<table role="presentation" style="margin-top:18px;border-top:1px solid #e7e5e4;padding-top:10px;"><tr><td style="font-size:13px;color:#57534e;">${esc(sign)}</td></tr></table>`,
    ...(quoted ? [
      `<div style="margin-top:18px;color:#78716c;font-size:13px;">${esc(qHead)}</div>`,
      '<blockquote style="margin:6px 0 0;padding-left:12px;border-left:3px solid #d6d3d1;color:#57534e;">',
      ...qLines.map((l) => `<p style="margin:0 0 8px;">${esc(l)}</p>`),
      '</blockquote>',
    ] : []),
    '</div>',
  ].join('\n');
  const alt = `alt-${uid}`;
  const altPart = [
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    text,
    '',
    `--${alt}`,
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
    '',
    `--${alt}--`,
  ];
  // Invoices and proofs carry their PDF.
  const attach = /Invoice|Proofs ready|Specimen PDFs|Final files|statement is ready/.test(subject);
  if (!attach) {
    return (r() < 0.25 ? [...head, 'Content-Type: text/plain; charset=UTF-8', '', text, ''] : [...head, ...altPart, '']).join('\n');
  }
  const ref = (subject.match(/\b(?:CC-|DG-)?\d{4}(?:-\d{4})?\b/) || [String(uid)])[0].toLowerCase();
  const name = /Invoice/.test(subject) ? `invoice-${ref}.pdf`
    : /statement/.test(subject) ? `statement-${MONTH_NAMES[date.getUTCMonth()].toLowerCase()}-${date.getUTCFullYear()}.pdf`
      : `proofs-${uid}.pdf`;
  const mixed = `mix-${uid}`;
  return [
    ...head,
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    ...altPart,
    '',
    `--${mixed}`,
    `Content-Type: application/pdf; name="${name}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${name}"`,
    '',
    pdfAttachment(subject, 2 + Math.floor(r() * 7)),
    `--${mixed}--`,
    '',
  ].join('\n');
}

/** Where the demo INBOX lands when history is present: above every history uid. */
export const DEMO_UID_OFFSET = 10000;

// ── 3. The clock ────────────────────────────────────────────────────────────
//
// The demo stamps "today" at fixed UTC hours (08:12 and 07:48), so a run before
// about 11:15 local shows today's mail as arriving in the future ("Just now" in
// chat, "11:12 AM" at four in the morning). FOOTAGE_ALIGN_NOW (default on)
// moves every demo message back by the same amount, only when needed, so the
// newest one arrived 35 minutes before the run. Relative order, gaps and each
// sender's own UTC offset are kept; history is generated relative to now and is
// left alone.

const ALIGN_ON = process.env.FOOTAGE_ALIGN_NOW !== '0';
const MON_IDX = Object.fromEntries(MONTHS.map((m, i) => [m, i]));

function headerDateMs(raw) {
  const m = /^Date: (.+)$/m.exec(raw);
  return m ? Date.parse(m[1]) : NaN;
}

function shiftHeaderDate(raw, deltaMs) {
  return raw.replace(/^Date: (.+)$/m, (line, value) => {
    const ms = Date.parse(value);
    const zone = /([+-])(\d\d)(\d\d)\s*$/.exec(value);
    if (Number.isNaN(ms) || !zone) return line;
    const offMin = (zone[1] === '-' ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3]));
    const wall = new Date(ms + deltaMs + offMin * 60000);
    return `Date: ${DOW[wall.getUTCDay()]}, ${p2(wall.getUTCDate())} ${MONTHS[wall.getUTCMonth()]} ${wall.getUTCFullYear()} `
      + `${p2(wall.getUTCHours())}:${p2(wall.getUTCMinutes())}:${p2(wall.getUTCSeconds())} ${zone[1]}${zone[2]}${zone[3]}`;
  });
}

function shiftInternalDate(value, deltaMs) {
  const m = /^(\d\d)-(\w{3})-(\d{4}) (\d\d):(\d\d):(\d\d) \+0000$/.exec(value || '');
  if (!m) return value;
  const d = new Date(Date.UTC(Number(m[3]), MON_IDX[m[2]], Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) + deltaMs);
  return `${p2(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000`;
}

/** How far to move the demo back so its newest message is 35 min old (0 when it already is). */
function alignDelta(scenarios) {
  if (!ALIGN_ON) return 0;
  let newest = -Infinity;
  for (const s of scenarios) for (const b of s.state.mailboxes) for (const m of b.messages) {
    const ms = headerDateMs(m.raw);
    if (ms > newest) newest = ms;
  }
  // FOOTAGE_ALIGN_SHIFT_MIN: a fixed shift in whole minutes (0 or less), for a
  // re-take whose clock must match an earlier run's clips (each run logs its
  // "demo clock moved N min"). Refused, falling back to the computed shift,
  // when it would leave the newest message in the future.
  const fixed = process.env.FOOTAGE_ALIGN_SHIFT_MIN;
  if (fixed !== undefined && fixed !== '' && Number.isFinite(newest)) {
    const ms = Math.round(Number(fixed)) * 60000;
    if (Number.isFinite(ms) && ms <= 0 && newest + ms <= Date.now()) return ms;
    console.warn(`[footage] FOOTAGE_ALIGN_SHIFT_MIN=${fixed} refused (newest message would be in the future); aligning to now instead`);
  }
  const target = Date.now() - 35 * 60000;
  // Whole minutes, so every shifted stamp still reads hh:mm:00.
  return Number.isFinite(newest) ? Math.min(0, Math.floor((target - newest) / 60000) * 60000) : 0;
}

// ── 3b. Extra mail (FOOTAGE_EXTRA_MAIL=1) ───────────────────────────────────
//
// Product Hunt batch 2 (scenes/ph-tier1.js c06, c10). Off by default so every
// other run keeps its counts: with it on the work INBOX holds EXTRA_MAIL_COUNT
// more messages (FOOTAGE_EXPECT_TOTAL goes up by the same number).
//  - Notes to Self: mail from the owner to the owner, a #tag in the subject
//    for a column, a link-only note, a file, a photo. Dated 30 to 80 days back
//    so none of it reaches the first screen of the inbox.
//  - A newsletter carrying a hidden open-tracking beacon on an invented host
//    that matches no known vendor, so the app's own detection names it by
//    host. Premium strips it before render; nothing is fetched.

const EXTRA_ON = process.env.FOOTAGE_EXTRA_MAIL === '1';

function extraStamp(daysAgo, hour, minute) {
  const d = new Date(Date.now() - daysAgo * 86400000);
  d.setUTCHours(hour, minute, 0, 0);
  return stampOf(d);
}

function stampOf(d) {
  return {
    internal_date: `${p2(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:00 +0000`,
    header: `${DOW[d.getUTCDay()]}, ${p2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:00 +0000`,
  };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A 480x320 PNG: a bowl of miso butter on a wooden board, drawn per pixel. */
function bowlPng() {
  const W = 480, H = 320;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  const cx = 250, cy = 165;
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const grain = Math.sin(y * 0.09 + Math.sin(x * 0.012) * 3) * 10;
      let r = 150 + grain, g = 102 + grain * 0.7, b = 62 + grain * 0.4;
      const d = Math.hypot(x - cx, (y - cy) * 1.15);
      if (d < 132) { const s = Math.max(0, 1 - d / 132); r = 60 + s * 20; g = 42 + s * 14; b = 30 + s * 10; }
      if (d < 118) { r = 236 - d * 0.25; g = 228 - d * 0.25; b = 214 - d * 0.3; }
      if (d < 88) { const s = d / 88; r = 232 - s * 30; g = 176 - s * 30; b = 88 - s * 20; }
      if (d < 88 && ((x * 7 + y * 13) % 97 === 0 || (x * 11 + y * 5) % 131 === 0)) { r = 74; g = 128; b = 58; }
      const i = y * (W * 3 + 1) + 1 + x * 3;
      raw[i] = Math.max(0, Math.min(255, r)); raw[i + 1] = Math.max(0, Math.min(255, g)); raw[i + 2] = Math.max(0, Math.min(255, b));
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const SMALL_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
  + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n'
  + 'trailer<</Root 1 0 R>>\n%%EOF\n',
);

function extraMime({ id, from, to, subject, header, text, html, attachment, seen = true, extraHeaders = [] }) {
  const head = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Date: ${header}`,
    `Message-ID: <${id}@primecut.studio>`, 'MIME-Version: 1.0', ...extraHeaders];
  const plain = ['Content-Type: text/plain; charset=UTF-8', '', text, ''];
  let body;
  if (attachment) {
    const b64 = attachment.data.toString('base64').replace(/(.{76})/g, '$1\n');
    body = [`Content-Type: multipart/mixed; boundary="mix-${id}"`, '', `--mix-${id}`, ...plain,
      `--mix-${id}`, `Content-Type: ${attachment.mime}; name="${attachment.name}"`, 'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${attachment.name}"`, '', b64, '', `--mix-${id}--`, ''];
  } else if (html) {
    body = [`Content-Type: multipart/alternative; boundary="alt-${id}"`, '', `--alt-${id}`, ...plain,
      `--alt-${id}`, 'Content-Type: text/html; charset=UTF-8', '', html, '', `--alt-${id}--`, ''];
  } else {
    body = plain;
  }
  return { raw: [...head, ...body].join('\n'), seen };
}

const TRACKER_BEACON = 'https://px.letterpour.io/open/214/8c1f2a.gif';

function trackerNewsletterHtml() {
  const p = (s) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#44403c;">${s}</p>`;
  return [
    '<div style="max-width:560px;margin:0 auto;font-family:Georgia,serif;background:#fffaf3;padding:28px 30px;border-top:6px solid #9a3412;">',
    '<div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#9a3412;margin-bottom:6px;">The Marinade, issue 214</div>',
    '<h1 style="margin:0 0 16px;font-size:26px;line-height:1.25;color:#1c1917;">Smoke, salt and slow type</h1>',
    p('This week: why the best studio menus are set in one weight, a brisket rub you can make in two minutes, and the print shop that still hand-mixes its inks.'),
    p('Plus a reader question on pricing a rebrand for a family butcher, answered by three people who have done it.'),
    '<p style="margin:18px 0 0;"><a href="https://themarinade.news/issues/214" style="background:#9a3412;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-family:Helvetica,Arial,sans-serif;font-size:14px;">Read the issue</a></p>',
    '<p style="margin:22px 0 0;font-size:12px;color:#78716c;font-family:Helvetica,Arial,sans-serif;">You get this because you subscribed at themarinade.news. Unsubscribe any time.</p>',
    `<img src="${TRACKER_BEACON}" alt="" style="display:none" border="0">`,
    '</div>',
  ].join('\n');
}

function extraMessages() {
  const me = 'Rowan Marsh <rowan@primecut.studio>';
  const png = { name: 'miso-butter.png', mime: 'image/png', data: bowlPng() };
  const notes = [
    { id: 'note-miso', d: 31, h: 19, m: 42, subject: '#recipes miso butter', text: 'Two spoons of white miso into soft butter, lime zest, a pinch of chilli. Great on grilled corn and on the rib eye.', attachment: png },
    { id: 'note-rub', d: 44, h: 20, m: 5, subject: '#recipes brisket rub', text: 'Equal parts coarse salt and black pepper, one spoon of garlic powder. Rub the night before, rest in the fridge.' },
    { id: 'note-popup', d: 36, h: 8, m: 17, subject: '#ideas pop-up grill night for clients', text: 'Book the Smokehouse cyc wall for one evening, invite Rack & Rind and Grill Theory, print the menu on butcher paper.' },
    { id: 'note-wall', d: 52, h: 7, m: 55, subject: '#ideas moodboard wall in the studio', text: 'Cork strip along the long wall, one column per client, swap it every Monday.' },
    { id: 'note-type', d: 67, h: 22, m: 31, subject: '#ideas a type specimen as a menu', text: 'Ask Priya if Brisket Sans could be shown as a tasting menu. Every weight a course.' },
    { id: 'note-smoke', d: 39, h: 12, m: 48, subject: 'Smoke ring reading', text: 'https://grilltheory.co/journal/the-smoke-ring' },
    { id: 'note-menu', d: 58, h: 13, m: 9, subject: 'Brine & Board autumn menu', text: 'https://brineandboard.com/menu/autumn' },
    { id: 'note-lease', d: 47, h: 9, m: 26, subject: 'Studio lease renewal', text: 'Signed copy for the files.', attachment: { name: 'studio-lease-renewal.pdf', mime: 'application/pdf', data: SMALL_PDF } },
    { id: 'note-shoot', d: 76, h: 17, m: 2, subject: 'Autumn shoot schedule', text: 'Final call times for the three shoot days.', attachment: { name: 'autumn-shoot-schedule.pdf', mime: 'application/pdf', data: SMALL_PDF } },
  ];
  const out = notes.map((n) => {
    const s = extraStamp(n.d, n.h, n.m);
    return { ...extraMime({ id: n.id, from: me, to: me, subject: n.subject, header: s.header, text: n.text, attachment: n.attachment }), internal_date: s.internal_date, date: s };
  });
  // Two and a half hours before the run, so the row sits near the top of the inbox.
  const at = new Date(Math.floor((Date.now() - 150 * 60000) / 60000) * 60000);
  const t = stampOf(at);
  out.push({
    ...extraMime({
      id: 'marinade-214', from: 'The Marinade <weekly@themarinade.news>', to: me, subject: 'The Marinade #214: smoke, salt and slow type',
      header: t.header, html: trackerNewsletterHtml(), seen: false,
      text: 'This week: why the best studio menus are set in one weight, a brisket rub you can make in two minutes, and the print shop that still hand-mixes its inks. Read the issue: https://themarinade.news/issues/214',
    }),
    internal_date: t.internal_date,
  });
  return out.map(({ raw, seen, internal_date }) => ({ raw, flags: seen ? ['\\Seen'] : [], internal_date }));
}

/** How many messages FOOTAGE_EXTRA_MAIL adds to the work INBOX. */
export const EXTRA_MAIL_COUNT = 10;

// ── 3c. Subscription mail (FOOTAGE_UNSUB_MAIL=1) ────────────────────────────
//
// Product Hunt clip 19 (scenes/ph-tier2b.js). Off by default; with it on the
// work INBOX holds UNSUB_MAIL_COUNT more messages, appended after the extra
// mail so its uids never move. Four invented lists carrying real
// List-Unsubscribe headers, one per method the app knows: two one-click
// (https + List-Unsubscribe-Post + a DKIM pass claim; no dmarc=pass, so no
// BIMI lookup of an invented domain), one web page only, one mailto only (the
// one the clip presses: the app opens a prefilled email the mock SMTP takes).
// List-Id on the three newsletters and Precedence: bulk on the shop, as real
// lists send them (the cleanup classifier keys on both). No remote images.

const UNSUB_ON = process.env.FOOTAGE_UNSUB_MAIL === '1';

function listHtml(kicker, title, lines, color) {
  const p = (s) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#3f3f46;">${s}</p>`;
  return [
    `<div style="max-width:560px;margin:0 auto;font-family:Helvetica,Arial,sans-serif;background:#fafaf9;padding:26px 30px;border-top:6px solid ${color};">`,
    `<div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:${color};margin-bottom:6px;">${kicker}</div>`,
    `<h1 style="margin:0 0 16px;font-size:24px;line-height:1.25;color:#18181b;">${title}</h1>`,
    ...lines.map(p),
    '<p style="margin:22px 0 0;font-size:12px;color:#71717a;">You get this because you signed up. Unsubscribe any time.</p>',
    '</div>',
  ].join('\n');
}

function unsubMessages() {
  const me = 'Rowan Marsh <rowan@primecut.studio>';
  const oneClick = (domain, path) => [
    `List-Unsubscribe: <https://${domain}/${path}>, <mailto:leave@${domain}?subject=unsubscribe>`,
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
    `Authentication-Results: mx.primecut.studio; spf=pass smtp.mailfrom=${domain}; dkim=pass header.d=${domain}`,
  ];
  const lists = [
    { from: 'Grill Theory Journal <journal@grilltheory.co>', color: '#b45309', kicker: 'Grill Theory Journal',
      headers: [...oneClick('grilltheory.co', 'u/rm-4471'), 'List-Id: Grill Theory Journal <journal.grilltheory.co>'], issues: [
        { id: 'gt-88', d: 5, h: 7, m: 30, subject: 'Grill Theory #88: reading the bark', lines: ['Why the crust on a long cook tells you more than the probe does, and three rubs that set it early.'] },
        { id: 'gt-87', d: 12, h: 7, m: 30, subject: 'Grill Theory #87: charcoal, sorted', lines: ['Lump, briquette or binchotan: a week of side by side cooks, with the numbers.'] },
        { id: 'gt-86', d: 19, h: 7, m: 30, subject: 'Grill Theory #86: the resting myth', lines: ['How long a brisket really needs to rest, measured over twelve cooks.'] },
      ] },
    { from: 'Smokehouse Supply <deals@smokehousesupply.shop>', color: '#be123c', kicker: 'Smokehouse Supply',
      headers: [...oneClick('smokehousesupply.shop', 'unsub/88213'), 'Precedence: bulk'], issues: [
        { id: 'ss-oct', d: 3, h: 16, m: 5, subject: '20% off hickory chunks this weekend', lines: ['Hickory, oak and cherry chunks at 20% off until Sunday night.'] },
        { id: 'ss-sep', d: 17, h: 16, m: 5, subject: 'New: the butcher paper bundle', lines: ['Three rolls of pink butcher paper and a dispenser, bundled.'] },
      ] },
    { from: 'Kerning Club <hello@kerningclub.news>', color: '#4338ca', kicker: 'Kerning Club',
      headers: ['List-Unsubscribe: <https://kerningclub.news/leave?u=rowan>', 'List-Id: Kerning Club <club.kerningclub.news>'], issues: [
        { id: 'kc-41', d: 8, h: 9, m: 0, subject: 'Kerning Club 41: menus set in one weight', lines: ['Six restaurant menus that use a single weight of one face, and why they read so calmly.'] },
        { id: 'kc-40', d: 22, h: 9, m: 0, subject: 'Kerning Club 40: hand-painted signs', lines: ['A visit to the last sign painter on the high street.'] },
      ] },
    { from: 'Ink & Brine Press <notes@inkandbrine.press>', color: '#0f766e', kicker: 'Ink & Brine Press',
      headers: ['List-Unsubscribe: <mailto:leave@inkandbrine.press?subject=unsubscribe>', 'List-Id: Ink & Brine notes <notes.inkandbrine.press>'], issues: [
        { id: 'ib-15', recentMin: 95, subject: 'Ink & Brine notes: autumn print run', lines: ['The autumn print run opens on Monday: risograph menus, two inks, 300 copies minimum.', 'Reply to this note to hold a slot.'], seen: false },
        { id: 'ib-14', d: 14, h: 11, m: 40, subject: 'Ink & Brine notes: paper samples are in', lines: ['New uncoated stock samples arrived, including a heavy kraft that takes two inks well.'] },
      ] },
  ];
  const out = [];
  for (const list of lists) {
    for (const n of list.issues) {
      const s = n.recentMin ? stampOf(new Date(Math.floor((Date.now() - n.recentMin * 60000) / 60000) * 60000)) : extraStamp(n.d, n.h, n.m);
      const msg = extraMime({
        id: n.id, from: list.from, to: me, subject: n.subject, header: s.header, seen: n.seen !== false,
        html: listHtml(list.kicker, n.subject.replace(/^[^:]*: /, ''), n.lines, list.color), text: n.lines.join('\n\n'),
        extraHeaders: list.headers,
      });
      out.push({ raw: msg.raw, flags: msg.seen ? ['\\Seen'] : [], internal_date: s.internal_date });
    }
  }
  return out;
}

/** How many messages FOOTAGE_UNSUB_MAIL adds to the work INBOX. */
export const UNSUB_MAIL_COUNT = 9;

// ── 4. Assembly ─────────────────────────────────────────────────────────────

function withBodyDelay(faults, value = process.env.FOOTAGE_BODY_DELAY_MS) {
  if (value === undefined || value === '') return faults;
  const ms = Number(value);
  const others = (faults || []).filter((f) => !(f.trigger?.OnCommandWith?.[1] === 'BODY.PEEK[]'));
  if (!(ms > 0)) return others;
  return [...others, {
    trigger: { OnCommandWith: ['FETCH', 'BODY.PEEK[]'] },
    action: { Delay: { secs: Math.floor(ms / 1000), nanos: (ms % 1000) * 1e6 } },
  }];
}

// FOOTAGE_REFUSE_UID=<uid> (unset: off): the server turns away the full-message
// FETCH of that one uid with a tagged NO, every time, so archiving it really
// fails and the run keeps it on the server (scenes/ph-archive-backup.js). The
// needle is the archive fetch's shape; a header page or a body-only read of
// the same uid still answers.
function withRefusedFetch(faults, value = process.env.FOOTAGE_REFUSE_UID) {
  const uid = Number(value);
  if (!(uid > 0)) return faults;
  return [...(faults || []), {
    trigger: { OnCommandWith: ['FETCH', `${uid} (UID FLAGS ENVELOPE INTERNALDATE BODY.PEEK[])`] },
    action: { RefuseWith: ['NO', 'Message temporarily unavailable'] },
  }];
}

function patchScenario(scenario, { history = null, deltaMs = 0, extra = null } = {}) {
  const mailboxes = scenario.state.mailboxes.map((box) => {
    let messages = box.messages.map((m) => ({
      ...m,
      raw: patchText(deltaMs ? shiftHeaderDate(m.raw, deltaMs) : m.raw),
      internal_date: deltaMs ? shiftInternalDate(m.internal_date, deltaMs) : m.internal_date,
    }));
    if (history && box.name === 'INBOX') {
      messages = [
        ...history,
        ...messages.map((m) => ({ ...m, uid: m.uid + DEMO_UID_OFFSET, modseq: m.uid + DEMO_UID_OFFSET })),
      ];
    }
    if (extra && box.name === 'INBOX') {
      const top = messages.reduce((max, m) => Math.max(max, m.uid), 0);
      messages = [...messages, ...extra.map((m, i) => ({ ...m, uid: top + 1 + i, modseq: top + 1 + i }))];
    }
    const maxUid = messages.reduce((max, m) => Math.max(max, m.uid), 0);
    return { ...box, messages, uid_next: maxUid + 1, highest_modseq: maxUid + 1 };
  });
  return { ...scenario, faults: withRefusedFetch(withBodyDelay(scenario.faults)), state: { ...scenario.state, mailboxes } };
}

/**
 * The demo accounts for a footage run: same ids and names, patched addresses,
 * and scenarios that build the patched mailbox. History (if any) goes into the
 * FIRST account's INBOX, the work account every scene opens.
 */
export function footageAccounts() {
  const { DEMO_ACCOUNTS } = demoScenarios('en');
  const spec = historySpec();
  const history = spec ? historyMessages(spec) : null;
  if (history) {
    const byYear = {};
    for (const m of history) { const y = m.internal_date.slice(7, 11); byYear[y] = (byYear[y] || 0) + 1; }
    console.log(`[footage] history: ${history.length} messages ${JSON.stringify(byYear)}, demo INBOX uids +${DEMO_UID_OFFSET}`);
  }
  // Aligned on the work account, the one every scene shows (the personal
  // account's newest message is later in the day and never on screen).
  // FOOTAGE_ALIGN_ALL=1 (off by default): aligned on every account, for a
  // clip that shows the other accounts or All Inboxes (ph-tier2a c13).
  const deltaMs = alignDelta(process.env.FOOTAGE_ALIGN_ALL === '1'
    ? DEMO_ACCOUNTS.map((a) => a.scenario()) : [DEMO_ACCOUNTS[0].scenario()]);
  console.log(`[footage] text patches ${PATCH_ON ? 'on' : 'off'}, body delay ${process.env.FOOTAGE_BODY_DELAY_MS ?? 'demo default (350 ms)'}, `
    + `demo clock moved ${(deltaMs / 60000).toFixed(0)} min, extra mail ${EXTRA_ON ? `on (+${EXTRA_MAIL_COUNT})` : 'off'}`
    + `${UNSUB_ON ? `, subscription mail on (+${UNSUB_MAIL_COUNT})` : ''}`);
  // Subscription mail goes after the extra mail, so the extra mail's uids stay put.
  // FOOTAGE_TIER2C=1 (off by default): ph-tier2c's mail last (lib/tier2cMail.js).
  // FOOTAGE_TIER3B=1 (off by default): ph-tier3b's mail after that (lib/tier3bMail.js).
  const extraFor = () => (EXTRA_ON || UNSUB_ON || TIER2C_ON || TIER3B_ON
    ? [...(EXTRA_ON ? extraMessages() : []), ...(UNSUB_ON ? unsubMessages() : []), ...(TIER2C_ON ? tier2cMessages() : []),
      ...(TIER3B_ON ? tier3bMessages() : [])] : null);
  return DEMO_ACCOUNTS.map((a, i) => ({
    ...a,
    email: patchText(a.email),
    scenario: () => patchScenario(a.scenario(), { history: i === 0 ? history : null, deltaMs, extra: i === 0 ? extraFor() : null }),
  }));
}
