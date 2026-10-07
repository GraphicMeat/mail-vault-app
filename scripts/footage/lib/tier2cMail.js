/**
 * Demo mail for Product Hunt Tier 2 batch C (scenes/ph-tier2c.js), added to
 * the work INBOX only with FOOTAGE_TIER2C=1 (lib/mailbox.js), so every other
 * run keeps its counts: TIER2C_MAIL_COUNT more messages, FOOTAGE_EXPECT_TOTAL
 * goes up by the same number.
 *
 *  - c23 attachment search: four messages carrying a real PDF, Word, Excel and
 *    PowerPoint file. One word, SEARCH_WORD, is written only INSIDE the files
 *    (never in a subject, body or file name), so a hit on it can only come
 *    from the app's own attachment text extraction.
 *  - c26 OpenPGP: a throwaway RSA key pair for the invented owner identity,
 *    generated at record time with node:crypto (no GnuPG, no library), and a
 *    PGP/MIME message really encrypted to it (PKESK v3 + SEIPD v1, RFC 4880).
 *    Nothing is faked: the app decrypts the ciphertext with the key the take
 *    imports. As a fallback the GnuPG-made TEST-ONLY fixture message from
 *    src-core/tests/fixtures rides along, dated months back.
 *
 * The key is generated ONCE per run: wdio loads its config (and so this file)
 * in the launcher and again in each worker, so the first generation is parked
 * in process.env.FOOTAGE_PGP_FIXTURE, which the workers inherit, and the spec
 * reads the armored secret key from there.
 */
import { createHash, createCipheriv, generateKeyPairSync, randomBytes, sign as rsaSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

export const TIER2C_ON = process.env.FOOTAGE_TIER2C === '1';
export const TIER2C_MAIL_COUNT = 6;
export const SEARCH_WORD = 'tamarind';
export const ATTACHMENT_SUBJECTS = [
  'Tasting notes from Thursday',
  'Supplier order for October',
  'Costings for the new glazes',
  'Launch deck, final cut',
];
export const PGP_SUBJECT = 'Rind Display licence figures';
export const PGP_SECRET_LINE = 'Five seats, two years, studio and client work';
export const PGP_FIXTURE_SUBJECT = 'Encrypted test message (fixture)';
export const PGP_IDENTITY = 'Rowan Marsh <rowan@primecut.studio>';

const OWNER = 'Rowan Marsh <rowan@primecut.studio>';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const p2 = (n) => String(n).padStart(2, '0');

function stamp(msAgo) {
  const d = new Date(Math.floor((Date.now() - msAgo) / 60000) * 60000);
  return {
    internal_date: `${p2(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:00 +0000`,
    header: `${DOW[d.getUTCDay()]}, ${p2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:00 +0000`,
  };
}
const HOUR = 3600000;
const DAY = 24 * HOUR;

// ── Zip (Office files) ───────────────────────────────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip of `files` ({ name: string|Buffer }), deflated, as a Buffer. */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const packed = deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  const count = Object.keys(files).length;
  end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const xesc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

function docx(paragraphs) {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  return zip({
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': `${XML}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `${XML}<w:document xmlns:w="${W}"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${xesc(p)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`,
  });
}

function xlsx(rows) {
  const strings = [];
  const idx = (s) => { let i = strings.indexOf(s); if (i < 0) { strings.push(s); i = strings.length - 1; } return i; };
  const col = (c) => String.fromCharCode(65 + c);
  const sheetRows = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => (typeof v === 'number'
    ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>`
    : `<c r="${col(ci)}${ri + 1}" t="s"><v>${idx(v)}</v></c>`)).join('')}</row>`).join('');
  const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  return zip({
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
    '_rels/.rels': `${XML}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `${XML}<workbook xmlns="${S}" xmlns:r="${REL}"><sheets><sheet name="Costings" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${XML}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `${XML}<worksheet xmlns="${S}"><sheetData>${sheetRows}</sheetData></worksheet>`,
    'xl/sharedStrings.xml': `${XML}<sst xmlns="${S}" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t>${xesc(s)}</t></si>`).join('')}</sst>`,
  });
}

function pptx(slides) {
  const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const files = {
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>`,
    '_rels/.rels': `${XML}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    'ppt/presentation.xml': `${XML}<p:presentation xmlns:p="${P}" xmlns:r="${REL}"><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `${XML}<Relationships xmlns="${PKG_REL}">${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`,
  };
  slides.forEach((lines, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = `${XML}<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/>${lines.map((l) => `<a:p><a:r><a:t>${xesc(l)}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  });
  return zip(files);
}

/** A one-page PDF with a real text layer (Helvetica), `lines` top to bottom. */
function pdf(lines) {
  const pesc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  let stream = 'BT /F1 12 Tf 60 780 Td 18 TL\n';
  for (const l of lines) stream += `(${pesc(l)}) Tj T*\n`;
  stream += 'ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function attachmentMail({ id, from, subject, text, file, msAgo }) {
  const s = stamp(msAgo);
  const b64 = file.data.toString('base64').replace(/(.{76})/g, '$1\n');
  const raw = [
    `From: ${from}`, `To: ${OWNER}`, `Subject: ${subject}`, `Date: ${s.header}`,
    `Message-ID: <${id}@primecut.studio>`, 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="mix-${id}"`, '',
    `--mix-${id}`, 'Content-Type: text/plain; charset=UTF-8', '', text, '',
    `--mix-${id}`, `Content-Type: ${file.mime}; name="${file.name}"`, 'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${file.name}"`, '', b64, '', `--mix-${id}--`, '',
  ].join('\n');
  return { raw, flags: ['\\Seen'], internal_date: s.internal_date };
}

function attachmentMessages() {
  const W = SEARCH_WORD;
  const Wc = W[0].toUpperCase() + W.slice(1);
  return [
    attachmentMail({
      id: 'c23-pdf', from: 'Nell Okafor <nell@smokehouse.design>', subject: ATTACHMENT_SUBJECTS[0], msAgo: 3 * DAY + 5 * HOUR,
      text: 'Rowan,\n\nNotes from the tasting are in the PDF. Two of the five made the cut.\n\nNell',
      file: { name: 'tasting-notes.pdf', mime: 'application/pdf', data: pdf([
        'Smokehouse tasting, Thursday', '',
        'Sauce 1: smoked chilli and honey. Too sweet for the rib eye, keep for wings.',
        `Sauce 2: ${Wc} and black garlic glaze. The table favourite, goes on the menu.`,
        'Sauce 3: burnt orange and fennel. Good, needs more salt.',
        'Sauce 4: coffee rub butter. Pair with the Marbled Coffee beans.',
        'Sauce 5: green peppercorn. Back to the kitchen.', '',
        `Next step: price the ${W} glaze per litre and send it to Rack & Rind.`,
      ]) },
    }),
    attachmentMail({
      id: 'c23-docx', from: 'Dario Vella <dario@rackandrind.com>', subject: ATTACHMENT_SUBJECTS[1], msAgo: 4 * DAY + 2 * HOUR,
      text: 'Rowan,\n\nThe October order is attached as a Word file, please check the quantities before Friday.\n\nDario',
      file: { name: 'supplier-order-october.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: docx([
        'Rack & Rind supplier order, October',
        'Brisket, 120 kg, delivery Monday',
        `${Wc} glaze, 40 litres, delivery Thursday`,
        'Butcher paper, 6 rolls',
        'Signed off by Dario Vella',
      ]) },
    }),
    attachmentMail({
      id: 'c23-xlsx', from: 'Theo Lomas <theo@skewer.systems>', subject: ATTACHMENT_SUBJECTS[2], msAgo: 5 * DAY + 7 * HOUR,
      text: 'Rowan,\n\nCostings sheet for the glaze labels, print and stock per run.\n\nTheo',
      file: { name: 'glaze-costings.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: xlsx([
        ['Label', 'Run', 'Cost per label'],
        ['Smoked chilli', 2000, 0.18],
        [`${Wc} and black garlic`, 3000, 0.16],
        ['Burnt orange', 1500, 0.21],
      ]) },
    }),
    attachmentMail({
      id: 'c23-pptx', from: 'Ana Brandt <ana@sizzlemedia.co>', subject: ATTACHMENT_SUBJECTS[3], msAgo: 6 * DAY + 3 * HOUR,
      text: 'Rowan,\n\nFinal cut of the launch deck. Slide two is new.\n\nAna',
      file: { name: 'launch-deck-final.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', data: pptx([
        ['Rack & Rind autumn launch', 'Sizzle Media for Primecut Studio'],
        [`Hero product: the ${W} glaze`, 'Shoot at the Smokehouse cyc wall', 'Posters, menus and labels'],
        ['Timeline', 'Print with Skewer Systems in week two'],
      ]) },
    }),
  ];
}

// ── OpenPGP (RFC 4880), RSA, node:crypto only ───────────────────────────────

const b64u = (s) => BigInt(`0x${Buffer.from(s, 'base64url').toString('hex') || '0'}`);
const bigBytes = (n) => { let h = n.toString(16); if (h.length % 2) h = `0${h}`; return Buffer.from(h, 'hex'); };
function mpi(n) {
  const b = bigBytes(n);
  let first = b[0], bits = 0;
  while (first) { bits++; first >>= 1; }
  const len = Buffer.alloc(2); len.writeUInt16BE((b.length - 1) * 8 + bits);
  return Buffer.concat([len, b]);
}
function modPow(base, exp, mod) {
  let r = 1n; base %= mod;
  while (exp > 0n) { if (exp & 1n) r = (r * base) % mod; base = (base * base) % mod; exp >>= 1n; }
  return r;
}
function modInv(a, m) {
  let [r0, r1, s0, s1] = [a % m, m, 1n, 0n];
  while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
  return ((s0 % m) + m) % m;
}
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
function packet(tag, body) {
  const n = body.length;
  let len;
  if (n < 192) len = Buffer.from([n]);
  else if (n < 8384) len = Buffer.from([((n - 192) >> 8) + 192, (n - 192) & 0xff]);
  else len = Buffer.concat([Buffer.from([0xff]), u32(n)]);
  return Buffer.concat([Buffer.from([0xc0 | tag]), len, body]);
}
const sub = (type, data) => Buffer.concat([Buffer.from([data.length + 1, type]), data]);

function rsaKey(created) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
  const j = privateKey.export({ format: 'jwk' });
  let p = b64u(j.p), q = b64u(j.q);
  if (p > q) [p, q] = [q, p];
  const k = { n: b64u(j.n), e: b64u(j.e), d: b64u(j.d), p, q, u: modInv(p, q), keyObject: privateKey };
  k.pub = Buffer.concat([Buffer.from([4]), u32(created), Buffer.from([1]), mpi(k.n), mpi(k.e)]);
  k.fpr = createHash('sha1').update(Buffer.concat([Buffer.from([0x99]), u16(k.pub.length), k.pub])).digest();
  k.keyId = k.fpr.subarray(12);
  const secret = Buffer.concat([mpi(k.d), mpi(k.p), mpi(k.q), mpi(k.u)]);
  let sum = 0; for (const b of secret) sum = (sum + b) & 0xffff;
  k.sec = Buffer.concat([k.pub, Buffer.from([0]), secret, u16(sum)]);
  return k;
}

/** A v4 RSA/SHA-256 signature by `signer` over `prefix` (the key/uid material). */
function signature(signer, type, prefix, flags, created) {
  const hashed = Buffer.concat([
    sub(2, u32(created)),
    sub(27, Buffer.from([flags])),
    sub(33, Buffer.concat([Buffer.from([4]), signer.fpr])),
    ...(type === 0x13 ? [sub(11, Buffer.from([9, 8, 7])), sub(21, Buffer.from([8, 2])), sub(22, Buffer.from([0]))] : []),
  ]);
  const head = Buffer.concat([Buffer.from([4, type, 1, 8]), u16(hashed.length), hashed]);
  const data = Buffer.concat([prefix, head, Buffer.from([4, 0xff]), u32(head.length)]);
  const digest = createHash('sha256').update(data).digest();
  const sig = rsaSign('sha256', data, signer.keyObject);
  const unhashed = sub(16, signer.keyId);
  return packet(2, Buffer.concat([head, u16(unhashed.length), unhashed, digest.subarray(0, 2), mpi(BigInt(`0x${sig.toString('hex')}`))]));
}

function crc24(buf) {
  let crc = 0xb704ce;
  for (const b of buf) {
    crc ^= b << 16;
    for (let i = 0; i < 8; i++) { crc <<= 1; if (crc & 0x1000000) crc ^= 0x1864cfb; }
  }
  return crc & 0xffffff;
}
function armor(kind, data) {
  const c = crc24(data);
  const body = data.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN PGP ${kind}-----\n\n${body}\n=${Buffer.from([c >> 16, (c >> 8) & 0xff, c & 0xff]).toString('base64')}\n-----END PGP ${kind}-----\n`;
}

function generateKey(identity) {
  const created = Math.floor(Date.now() / 1000) - 3 * 86400;
  const primary = rsaKey(created);
  const subkey = rsaKey(created);
  const uid = Buffer.from(identity, 'utf8');
  const pubFrame = (k) => Buffer.concat([Buffer.from([0x99]), u16(k.pub.length), k.pub]);
  const certSig = signature(primary, 0x13, Buffer.concat([pubFrame(primary), Buffer.from([0xb4]), u32(uid.length), uid]), 0x03, created);
  const bindSig = signature(primary, 0x18, Buffer.concat([pubFrame(primary), pubFrame(subkey)]), 0x0c, created);
  const key = Buffer.concat([packet(5, primary.sec), packet(13, uid), certSig, packet(7, subkey.sec), bindSig]);
  return { armored: armor('PRIVATE KEY BLOCK', key), subkey, fingerprint: primary.fpr.toString('hex').toUpperCase() };
}

function encryptTo(subkey, plaintext) {
  const sessionKey = randomBytes(32);
  let sum = 0; for (const b of sessionKey) sum = (sum + b) & 0xffff;
  const m = Buffer.concat([Buffer.from([9]), sessionKey, u16(sum)]);
  const k = bigBytes(subkey.n).length;
  const ps = Buffer.alloc(k - m.length - 3);
  for (let i = 0; i < ps.length; i++) { let r = 0; while (!r) r = randomBytes(1)[0]; ps[i] = r; }
  const em = Buffer.concat([Buffer.from([0, 2]), ps, Buffer.from([0]), m]);
  const c = modPow(BigInt(`0x${em.toString('hex')}`), subkey.e, subkey.n);
  const pkesk = packet(1, Buffer.concat([Buffer.from([3]), subkey.keyId, Buffer.from([1]), mpi(c)]));
  const literal = packet(11, Buffer.concat([Buffer.from(['b'.charCodeAt(0), 0]), u32(Math.floor(Date.now() / 1000)), plaintext]));
  const iv = randomBytes(16);
  const prefix = Buffer.concat([iv, iv.subarray(14)]);
  const mdcHead = Buffer.from([0xd3, 0x14]);
  const mdc = createHash('sha1').update(Buffer.concat([prefix, literal, mdcHead])).digest();
  const cipher = createCipheriv('aes-256-cfb', sessionKey, Buffer.alloc(16));
  const enc = Buffer.concat([cipher.update(Buffer.concat([prefix, literal, mdcHead, mdc])), cipher.final()]);
  const seipd = packet(18, Buffer.concat([Buffer.from([1]), enc]));
  return armor('MESSAGE', Buffer.concat([pkesk, seipd]));
}

function pgpMime({ id, from, subject, armored, msAgo, seen }) {
  const s = stamp(msAgo);
  const raw = [
    `From: ${from}`, `To: ${OWNER}`, `Subject: ${subject}`, `Date: ${s.header}`,
    `Message-ID: <${id}@primecut.studio>`, 'MIME-Version: 1.0',
    `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="enc-${id}"`, '',
    'This is an OpenPGP/MIME encrypted message (RFC 4880 and 3156)', '',
    `--enc-${id}`, 'Content-Type: application/pgp-encrypted', 'Content-Description: PGP/MIME version identification', '', 'Version: 1', '',
    `--enc-${id}`, 'Content-Type: application/octet-stream; name="encrypted.asc"', 'Content-Description: OpenPGP encrypted message',
    'Content-Disposition: inline; filename="encrypted.asc"', '', armored.trimEnd(), '', `--enc-${id}--`, '',
  ].join('\r\n');
  return { raw, flags: seen ? ['\\Seen'] : [], internal_date: s.internal_date };
}

/** The run's key and ciphertext, made once and shared with the workers through the env. */
export function pgpFixture() {
  if (process.env.FOOTAGE_PGP_FIXTURE) return JSON.parse(process.env.FOOTAGE_PGP_FIXTURE);
  const t0 = Date.now();
  const key = generateKey(PGP_IDENTITY);
  const inner = [
    'Content-Type: text/plain; charset=utf-8', '',
    'Rowan,', '',
    `Here are the Rind Display licence figures before the contract goes out. ${PGP_SECRET_LINE} included, renewal at the same rate.`, '',
    'I sent this one encrypted, it carries the numbers we have not shared with anyone yet.', '',
    'Priya', '',
  ].join('\r\n');
  const fixture = { armoredKey: key.armored, fingerprint: key.fingerprint, message: encryptTo(key.subkey, Buffer.from(inner, 'utf8')) };
  process.env.FOOTAGE_PGP_FIXTURE = JSON.stringify(fixture);
  console.log(`[footage] tier2c: OpenPGP test key ${key.fingerprint} (${PGP_IDENTITY}) generated in ${Date.now() - t0} ms`);
  return fixture;
}

const FIXTURE_DIR = join(import.meta.dirname, '../../../src-core/tests/fixtures');
export const fixtureKey = () => readFileSync(join(FIXTURE_DIR, 'pgp-TEST-ONLY-key.asc'), 'utf8');

/** Every message FOOTAGE_TIER2C=1 adds to the work INBOX. */
export function tier2cMessages() {
  const f = pgpFixture();
  return [
    ...attachmentMessages(),
    pgpMime({ id: 'c26-pgp', from: 'Priya Raines <priya@tenderloin.type>', subject: PGP_SUBJECT, armored: f.message, msAgo: 5 * HOUR + 20 * 60000, seen: false }),
    pgpMime({ id: 'c26-fixture', from: 'MailVault Test <pgp-test@mock.test>', subject: PGP_FIXTURE_SUBJECT,
      armored: readFileSync(join(FIXTURE_DIR, 'pgp-TEST-ONLY-message.asc'), 'utf8'), msAgo: 140 * DAY, seen: true }),
  ];
}
