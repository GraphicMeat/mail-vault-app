/**
 * Demo mail for Product Hunt Tier 3 batch B (scenes/ph-tier3b.js), added to
 * the work INBOX only with FOOTAGE_TIER3B=1 (lib/mailbox.js), so every other
 * run keeps its counts: TIER3B_MAIL_COUNT more messages, FOOTAGE_EXPECT_TOTAL
 * goes up by the same number. All three are invented, dated minutes before the
 * run so they sit on the first screen of the inbox:
 *
 *  - c46 attachment preview: a photo (PNG, drawn per pixel) and a one-page
 *    menu proof (PDF with a coloured band and large type), so the reader shows
 *    a real thumbnail and both previews open.
 *  - c47 reply starters: a person-to-person question proposing a time, which
 *    the app's own heuristic answers with three starters.
 *  - c50 code as code: a plain-text message (no HTML part) with `inline code`
 *    and a fenced block, which the reader shows as code.
 *
 * Self-contained on purpose (own PNG, PDF and MIME writers): mailbox.js
 * imports this file, so this file never imports mailbox.js.
 */
import { deflateSync } from 'node:zlib';

export const TIER3B_ON = process.env.FOOTAGE_TIER3B === '1';
export const TIER3B_MAIL_COUNT = 3;
export const ATTACH_SUBJECT = 'Autumn menu proofs';
export const STARTER_SUBJECT = 'Tasting on Thursday?';
export const CODE_SUBJECT = 'Booking widget snippet';

const ME = 'Rowan Marsh <rowan@primecut.studio>';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const p2 = (n) => String(n).padStart(2, '0');

function stamp(minutesAgo) {
  const d = new Date(Math.floor((Date.now() - minutesAgo * 60000) / 60000) * 60000);
  const hm = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:00 +0000`;
  return {
    internal_date: `${p2(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${hm}`,
    header: `${DOW[d.getUTCDay()]}, ${p2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${hm}`,
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

/** A 600x400 PNG: ribs on a slate board with a lime wedge, drawn per pixel. */
function platePng() {
  const W = 600, H = 400;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const n = Math.sin(x * 0.31 + y * 0.17) * 4 + Math.sin(x * 0.05 - y * 0.08) * 6;
      let r = 46 + n, g = 50 + n, b = 56 + n;                          // slate
      const bx = (x - 300) / 250, by = (y - 205) / 150;                 // board
      if (bx * bx + by * by < 1) { r = 70 + n; g = 74 + n; b = 80 + n; }
      for (let k = 0; k < 4; k++) {                                     // four ribs
        const cx = 200 + k * 62, cy = 200 + (k % 2) * 12;
        const dx = (x - cx) / 26, dy = (y - cy) / 92;
        const d = dx * dx + dy * dy;
        if (d < 1) {
          const s = 1 - d;
          r = 120 + s * 70 + n; g = 52 + s * 26 + n * 0.5; b = 28 + s * 12;
          if (Math.abs(y - cy - Math.sin(x * 0.2) * 6) < 3 && d < 0.8) { r = 60; g = 26; b = 14; }
          if ((dx < -0.2 && dx > -0.5) && d < 0.9) { r += 30; g += 18; b += 6; }
        }
        if (Math.abs(x - cx) < 4 && y > cy + 80 && y < cy + 104) { r = 236; g = 226; b = 206; }
      }
      const lx = x - 455, ly = y - 140;                                 // lime wedge
      if (lx * lx + ly * ly < 34 * 34 && ly > -8 && lx + ly * 0.2 > -30) { r = 150; g = 196; b = 70; if (lx * lx + ly * ly > 29 * 29) { r = 70; g = 120; b = 40; } }
      if (((x * 13 + y * 7) % 211 === 0) && bx * bx + by * by < 0.9) { r = 240; g = 240; b = 236; } // salt
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

/** A one-page A4 menu proof: a rust band, a large title, the dishes in 16 pt. */
function menuPdf() {
  const dishes = [
    ['Smoked short rib, miso butter corn', '24'],
    ['Charred hispi cabbage, anchovy crumb', '12'],
    ['Brisket bun, pickled shallot, burnt ends', '16'],
    ['Hickory beets, whipped feta, dill', '11'],
    ['Pork belly, apple and black pepper glaze', '19'],
    ['Smoked butter, sourdough, sea salt', '6'],
  ];
  let s = '0.604 0.204 0.071 rg 0 690 595 152 re f\n';
  s += 'BT /F2 46 Tf 1 1 1 rg 56 770 Td (Autumn Menu) Tj ET\n';
  s += 'BT /F1 16 Tf 1 0.86 0.78 rg 56 730 Td (Brine & Board, proof 2 for Rowan) Tj ET\n';
  s += '0.11 0.1 0.09 rg\n';
  dishes.forEach(([dish, price], i) => {
    const y = 630 - i * 52;
    s += `BT /F1 18 Tf 56 ${y} Td (${dish}) Tj ET\n`;
    s += `BT /F2 18 Tf 510 ${y} Td (${price}) Tj ET\n`;
    s += `0.85 0.82 0.78 rg 56 ${y - 16} 483 1 re f 0.11 0.1 0.09 rg\n`;
  });
  s += 'BT /F1 12 Tf 0.47 0.44 0.41 rg 56 250 Td (Set in Brisket Sans. Proof only, not for print.) Tj ET\n';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    `<< /Length ${s.length} >>\nstream\n${s}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

function mime({ id, from, subject, minutesAgo, text, attachments = [], seen = false }) {
  const s = stamp(minutesAgo);
  const head = [`From: ${from}`, `To: ${ME}`, `Subject: ${subject}`, `Date: ${s.header}`,
    `Message-ID: <${id}@tier3b.primecut.studio>`, 'MIME-Version: 1.0'];
  const plain = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', text, ''];
  const body = !attachments.length ? plain : [
    `Content-Type: multipart/mixed; boundary="mix-${id}"`, '', `--mix-${id}`, ...plain,
    ...attachments.flatMap((a) => [`--mix-${id}`, `Content-Type: ${a.mime}; name="${a.name}"`, 'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.name}"`, '', a.data.toString('base64').replace(/(.{76})/g, '$1\n'), '']),
    `--mix-${id}--`, '',
  ];
  return { raw: [...head, ...body].join('\n'), flags: seen ? ['\\Seen'] : [], internal_date: s.internal_date };
}

/** Every message FOOTAGE_TIER3B=1 adds to the work INBOX. */
export function tier3bMessages() {
  return [
    mime({
      id: 'c46-proofs', from: 'Lena Holt <lena@brineandboard.com>', subject: ATTACH_SUBJECT, minutesAgo: 95, seen: true,
      text: 'Hi Rowan,\n\nAttached are the cover photo and the second proof of the autumn card. The prices are final, the photo can still change.\n\nLena',
      attachments: [
        { name: 'cover-photo.png', mime: 'image/png', data: platePng() },
        { name: 'autumn-menu-proof.pdf', mime: 'application/pdf', data: menuPdf() },
      ],
    }),
    mime({
      id: 'c50-code', from: 'Theo Lund <theo@grilltheory.co>', subject: CODE_SUBJECT, minutesAgo: 65,
      text: [
        'Hi Rowan,',
        '',
        'Here is the snippet for the booking widget. Paste it right before the closing `</body>` tag on the menu page, and set `data-theme` to `dark` on the black pages.',
        '',
        '```html',
        '<script src="https://grilltheory.co/embed/book.js"',
        '        data-venue="smokehouse"',
        '        data-theme="light" defer></script>',
        '```',
        '',
        'If the button does not show up, run `npm run build` once more and clear the cache.',
        '',
        'Theo',
      ].join('\n'),
    }),
    mime({
      id: 'c47-tasting', from: 'Priya Raines <priya@tenderloin.type>', subject: STARTER_SUBJECT, minutesAgo: 35,
      text: 'Hi Rowan,\n\nDoes Thursday at 3pm work for you? I would like to walk you through the new Brisket Sans weights over coffee, printed specimens included.\n\nPriya',
    }),
  ];
}
