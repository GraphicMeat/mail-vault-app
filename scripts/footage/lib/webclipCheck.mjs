/**
 * Spec conformance of every encoded web clip of one locale, read from the
 * files themselves (not only from what the encoder reported):
 *
 *   node scripts/footage/lib/webclipCheck.mjs <locale dir> [clip ...]   # writes <locale dir>/check.json
 *
 * <locale dir> holds web/<clip>.mp4 + .jpg + .report.json, takes/<clip>.textscan.json
 * and record/verify.json (the take's own assertions, from the record run).
 * Per clip: 960x660 (hero-montage 1440x900), H.264, no audio track, moov
 * before mdat, duration inside its window, at most 250 KB (hero 1.6 MB), the
 * poster a JPEG of the same size at most 80 KB (hero 150 KB), no text-scan hit
 * (em dash, version label, relative or current date inside the crop), and
 * every take assertion passed. Exit 1 when any clip fails.
 */
import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ...only] = process.argv.slice(2);
if (!dir) { console.error('usage: webclipCheck.mjs <locale dir> [clip ...]'); process.exit(64); }
const WEB = join(dir, 'web');

const RULES = {
  card: { size: [960, 660], maxBytes: 250000, posterMax: 80000, dur: [3.5, 9.0] },
  hero: { size: [1440, 900], maxBytes: 1600000, posterMax: 150000, dur: [12, 30] },
};

/** Top-level and nested MP4 boxes we need: order, track handlers, sample entry, mvhd duration. */
function mp4(buf) {
  const out = { top: [], handlers: [], entries: [], durationSeconds: null };
  const walk = (start, end, depth) => {
    let p = start;
    while (p + 8 <= end) {
      let size = buf.readUInt32BE(p);
      const type = buf.toString('latin1', p + 4, p + 8);
      let hdr = 8;
      if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; }
      if (size === 0) size = end - p;
      if (size < hdr || p + size > end) break;
      if (depth === 0) out.top.push(type);
      const body = p + hdr;
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) walk(body, p + size, depth + 1);
      else if (type === 'mvhd') {
        const v = buf[body];
        const ts = v === 1 ? buf.readUInt32BE(body + 20) : buf.readUInt32BE(body + 12);
        const du = v === 1 ? Number(buf.readBigUInt64BE(body + 24)) : buf.readUInt32BE(body + 16);
        out.durationSeconds = du / ts;
      } else if (type === 'hdlr') out.handlers.push(buf.toString('latin1', body + 8, body + 12));
      else if (type === 'stsd') {
        const e = body + 8;
        const et = buf.toString('latin1', e + 4, e + 8);
        const entry = { type: et };
        if (['avc1', 'avc3', 'hvc1', 'hev1'].includes(et)) { entry.width = buf.readUInt16BE(e + 32); entry.height = buf.readUInt16BE(e + 34); }
        out.entries.push(entry);
      }
      p += size;
    }
  };
  walk(0, buf.length, 0);
  return out;
}

/** JPEG pixel size from its SOF marker. */
function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let p = 2;
  while (p + 9 < buf.length) {
    if (buf[p] !== 0xff) { p += 1; continue; }
    const m = buf[p + 1];
    const len = buf.readUInt16BE(p + 2);
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return [buf.readUInt16BE(p + 7), buf.readUInt16BE(p + 5)];
    p += 2 + len;
  }
  return null;
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const verify = readJson(join(dir, 'record', 'verify.json'));
const verdictOf = (clip) => verify?.clips?.find((c) => c.clip === clip) || null;

const clips = only.length ? only
  : readdirSync(WEB).filter((f) => f.endsWith('.mp4') && !f.endsWith('-wide.mp4')).map((f) => f.replace(/\.mp4$/, '')).sort();
const results = [];
for (const clip of clips) {
  const r = clip === 'hero-montage' ? RULES.hero : RULES.card;
  const fail = [];
  const mp4Path = join(WEB, `${clip}.mp4`), jpgPath = join(WEB, `${clip}.jpg`);
  const row = { clip, ok: false, bytes: null, seconds: null, posterBytes: null, reasons: fail };
  if (!existsSync(mp4Path)) { fail.push('no mp4'); results.push(row); continue; }
  const buf = readFileSync(mp4Path);
  row.bytes = buf.length;
  const m = mp4(buf);
  row.seconds = m.durationSeconds != null ? Number(m.durationSeconds.toFixed(2)) : null;
  const video = m.entries.find((e) => e.width);
  if (!video || video.type !== 'avc1') fail.push(`codec ${video?.type || m.entries.map((e) => e.type).join('/') || 'none'}, not avc1 (H.264)`);
  if (video && (video.width !== r.size[0] || video.height !== r.size[1])) fail.push(`size ${video.width}x${video.height}, not ${r.size.join('x')}`);
  if (m.handlers.includes('soun')) fail.push('has an audio track');
  const im = m.top.indexOf('moov'), id = m.top.indexOf('mdat');
  if (im < 0 || id < 0 || im > id) fail.push(`moov not before mdat (${m.top.join(',')})`);
  if (buf.length > r.maxBytes) fail.push(`${buf.length} B > ${r.maxBytes} B`);
  if (row.seconds == null || row.seconds < r.dur[0] || row.seconds > r.dur[1]) fail.push(`duration ${row.seconds} s outside ${r.dur.join('-')} s`);
  if (!existsSync(jpgPath)) fail.push('no poster');
  else {
    const j = readFileSync(jpgPath);
    row.posterBytes = j.length;
    const js = jpegSize(j);
    if (!js || js[0] !== r.size[0] || js[1] !== r.size[1]) fail.push(`poster ${js ? js.join('x') : 'not a JPEG'}, not ${r.size.join('x')}`);
    if (j.length > r.posterMax) fail.push(`poster ${j.length} B > ${r.posterMax} B`);
  }
  // The encoder's own report must agree (it verified its own output too).
  const rep = readJson(join(WEB, `${clip}.report.json`));
  if (!rep) fail.push('no encoder report');
  else if (rep.bytes !== buf.length) fail.push(`report says ${rep.bytes} B, file is ${buf.length} B`);
  if (clip !== 'hero-montage') {
    const scan = readJson(join(dir, 'takes', `${clip}.textscan.json`));
    if (!scan) fail.push('no text scan');
    else if (scan.hits > 0) {
      const hits = (scan.samples || []).flatMap((s) => s.hits.map((h) => `${s.label}: "${h.text}"`));
      fail.push(`text scan: ${[...new Set(hits)].slice(0, 4).join('; ')}`);
    }
    const v = verdictOf(clip);
    if (!v) fail.push('no take assertions (record verify.json)');
    else if (!v.pass) fail.push(`take assertions: ${v.error || v.checks.filter((c) => !c.ok).map((c) => c.name).join('; ')}`);
    row.attempts = v?.attempts ?? undefined;
  }
  row.ok = fail.length === 0;
  row.mtime = statSync(mp4Path).mtime.toISOString();
  results.push(row);
}
writeFileSync(join(dir, 'check.json'), JSON.stringify({ at: new Date().toISOString(), clips: results }, null, 2));
for (const x of results) {
  console.log(`${x.ok ? 'OK  ' : 'FAIL'} ${x.clip.padEnd(20)} ${String(x.bytes ?? '-').padStart(8)} B ${String(x.seconds ?? '-').padStart(6)} s poster ${String(x.posterBytes ?? '-').padStart(6)} B${x.ok ? '' : `  ${x.reasons.join(' | ')}`}`);
}
process.exit(results.every((x) => x.ok) ? 0 : 1);
