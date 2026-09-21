/**
 * The 50,000-message vault the "search 50,000 emails" screenshots photograph.
 *
 * Same corpus shape as the ignored Rust bench `search_index_bench_50k_real_parser`
 * (src-daemon/src/search_index.rs): splitmix64, ~3.3 KB multipart/alternative
 * messages, a planted word appearing in a fixed share of BODIES only — invoice
 * 5%, meeting 6%, budget 8%, plus 会議 / 資料 / Réunion. Which message carries
 * a word is decided by its rate alone, so a search's match count is a property
 * of the seed, not of what the fixture happens to look like.
 *
 * What differs from the bench is presentation only: sender names and subjects
 * are believable instead of "Sender 7 / please update 123". Subjects and
 * senders never contain a planted word, so the match set stays the body-only
 * set the article's numbers describe.
 *
 *   node scripts/screenshots/search50kCorpus.mjs <out-dir> <account-id>
 *
 * writes <out-dir>/Maildir/<account-id>/<folder>/cur/<uid>:2,AS.eml. The harness
 * clones that tree into each pass's HOME (`cp -Rc`, near-instant on APFS)
 * instead of writing 165 MB eighteen times.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The demo accounts cache 82 messages of their own into the same vault while the
// run boots, and the index counts every file in it. Seeding the difference makes
// the card read exactly 50,000 / 50,000 — and the spec asserts that, so a demo
// mailbox that grows or shrinks skips the shot instead of shipping a wrong count.
export const DEMO_VAULT_MESSAGES = 82;
export const N = 50_000 - DEMO_VAULT_MESSAGES;
export const NEWEST = 1_789_207_200; // Sat, 12 Sep 2026 10:00:00 +0000; message i is i*10 min older

// Folders no mock server lists: a mailbox load, repair or custody pass then
// never touches the seed, and nothing prunes it as "gone from the server".
export const FOLDERS = ['Projects', 'Correspondence', 'Clients'];

const M = (1n << 64n) - 1n;
function mix(x) {
  x = (BigInt(x) + 0x9E3779B97F4A7C15n) & M;
  x = ((x ^ (x >> 30n)) * 0xBF58476D1CE4E5B9n) & M;
  x = ((x ^ (x >> 27n)) * 0x94D049BB133111EBn) & M;
  return x ^ (x >> 31n);
}
const pick = (arr, seed) => arr[Number(mix(seed) % BigInt(arr.length))];

// No filler word contains a planted word, "update" or a digit.
const FILLER = [
  'please', 'review', 'attached', 'notes', 'thanks', 'regards', 'schedule', 'team', 'project', 'status',
  'follow', 'question', 'morning', 'office', 'travel', 'weekend', 'details', 'summary', 'action', 'items',
  'customer', 'product', 'launch', 'design', 'draft', 'final', 'approve', 'agenda', 'call', 'friday',
  'monday', 'report',
];
// (word, percent of messages whose body carries it)
const DICT = [
  ['invoice', 5], ['meeting', 6], ['budget', 8], ['shipment', 3], ['contract', 4],
  ['会議', 3], ['資料', 2], ['Réunion', 1], ['delivery', 10], ['quarterly', 7],
];

// Fifty distinct senders (i % 50), fictional, none containing a planted word.
const FIRST = ['Ana', 'Theo', 'Maya', 'Jonas', 'Priya', 'Lucas', 'Elena', 'Marcus', 'Sofia', 'Daniel',
  'Nora', 'Felix', 'Iris', 'Omar', 'Clara', 'Viktor', 'Leila', 'Hugo', 'Mina', 'Rafael',
  'Tessa', 'Ivan', 'Alma', 'Noel', 'Greta'];
const LAST = ['Brandt', 'Okafor', 'Lindqvist', 'Moreau', 'Castillo', 'Novak', 'Haddad', 'Sato', 'Keller', 'Duarte'];
const HOUSES = ['sizzlemedia.co', 'skewer.studio', 'rackandrind.com', 'northfold.press', 'harbourprint.co', 'fennelfield.org'];
const sender = (s) => {
  const first = FIRST[s % FIRST.length];
  const last = LAST[(s * 7 + 3) % LAST.length];
  return `${first} ${last} <${first.toLowerCase()}.${last.toLowerCase()}@${HOUSES[s % HOUSES.length]}>`;
};

const SUBJECTS = [
  'Notes from the design review', 'Updated schedule for Thursday', 'Press slot confirmed for Friday',
  'Hero image options', 'Follow-up on the print proof', 'Question about the packaging artwork',
  'Draft copy for the launch page', 'Final files are ready', 'Travel plans for the offsite',
  'Weekend coverage', 'Approval needed on the layout', 'Fonts outlined and packaged',
  'Photo shoot call sheet', 'Feedback on the second round', 'Agenda for Monday morning',
  'Status of the label proofs', 'Smoke levels on the hero shot', 'Moodboard for the spring range',
  'Retouching notes attached', 'Can you confirm the colour profile', 'Storyboard v3',
  'Client comments, all in one place', 'New brand guidelines PDF', 'Thanks for the quick turnaround',
  'Signage sizes for the pop-up', 'Studio access on Saturday', 'Reminder: proofs due tomorrow',
  'Shortlist for the new website', 'Copy edits from the client', 'Rack & Rind packaging refresh',
  'Print-ready files are with the press', 'Where did we land on the tagline',
];

export function buildMessage(i) {
  const seed = BigInt(i) << 20n;
  const words = Array.from({ length: 200 }, (_, k) => pick(FILLER, seed | BigInt(k)));
  DICT.forEach(([w, pct], k) => {
    if (mix(seed | BigInt(1000 + k)) % 100n < BigInt(pct)) {
      words.splice(Number(mix(seed | BigInt(2000 + k)) % BigInt(words.length)), 0, w);
    }
  });
  const lines = [];
  for (let c = 0; c < words.length; c += 20) lines.push(words.slice(c, c + 20));
  const text = lines.map((c) => c.join(' ')).join('\r\n');
  const html = lines.map((c) => `<p>${c.join(' ')}</p>`).join('');
  const subject = pick(SUBJECTS, seed | 3000n);
  const date = new Date((NEWEST - i * 600) * 1000).toUTCString().replace('GMT', '+0000');
  return `From: ${sender(i % 50)}\r\nTo: Rowan Marsh <rowan@primecut.studio>\r\nSubject: ${subject}\r\nMessage-ID: <${i}@primecut.studio>\r\nDate: ${date}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n--b\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body>${html}</body></html>\r\n--b--\r\n`;
}

/** Write the corpus under `<root>/Maildir/<accountId>/`. Returns bytes written. */
export function writeCorpus(root, accountId, n = N) {
  let bytes = 0;
  for (const f of FOLDERS) mkdirSync(join(root, 'Maildir', accountId, f, 'cur'), { recursive: true });
  for (let i = 1; i <= n; i++) {
    const eml = buildMessage(i);
    bytes += eml.length;
    writeFileSync(join(root, 'Maildir', accountId, FOLDERS[i % FOLDERS.length], 'cur', `${i}:2,AS.eml`), eml);
  }
  return bytes;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [out, account] = process.argv.slice(2);
  if (!out || !account) { console.error('usage: search50kCorpus.mjs <out-dir> <account-id>'); process.exit(2); }
  const t = Date.now();
  const bytes = writeCorpus(out, account);
  const invoice = Array.from({ length: N }, (_, k) => buildMessage(k + 1)).filter((m) => m.includes(' invoice ')).length;
  console.log(`corpus n=${N} bytes=${bytes} avg=${Math.round(bytes / N)} invoice_msgs=${invoice} in ${Date.now() - t}ms`);
}
