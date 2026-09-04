import { t } from '../../i18n/index.js';
import { displayName } from './exportDocument';
// Names for exported files. Every segment has to survive macOS, Windows and
// Linux, so the reserved set is the union of all three, not any one of them.

const RESERVED = /[/\\:*?"<>|]/g;

export function safeSegment(text, max = 120) {
  const cleaned = String(text ?? '')
    .replace(RESERVED, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
  return cleaned || 'Untitled';
}

function senderLabel(from) {
  return safeSegment(displayName(from) || 'Unknown sender', 60);
}

const pad = (n) => String(n).padStart(2, '0');
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const time = (d) => `${pad(d.getHours())}${pad(d.getMinutes())}`;

// A thread is named for what it was called before anyone replied.
function rootSubject(subject) {
  return safeSegment(String(subject || '').replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i, ''));
}

export function singleName(message, ext) {
  const d = message.date;
  return `${day(d)} ${time(d)} - ${senderLabel(message.from)} - ${safeSegment(message.subject)}.${ext}`;
}

export function threadName(messages, ext) {
  const sorted = [...messages].sort((a, b) => a.date - b.date);
  const first = day(sorted[0].date);
  const last = day(sorted[sorted.length - 1].date);
  const range = first === last ? first : t('svc.exportNaming.to', { first, last });
  return `${range} - ${rootSubject(sorted[0].subject)}.${ext}`;
}

export function threadMemberName(message, index, ext) {
  const d = message.date;
  return `${pad(index + 1)} - ${day(d)} ${time(d)} - ${senderLabel(message.from)}.${ext}`;
}

export function pageName(baseName, page, total) {
  if (total <= 1) return baseName;
  const dot = baseName.lastIndexOf('.');
  return t('svc.exportNaming.of', { baseName: baseName.slice(0, dot), page, total, baseName2: baseName.slice(dot) });
}

// An attachment keeps the name it had in the mail. safeSegment leaves the dot
// alone, so the extension survives the strip — a .pdf that lost its suffix is a
// file the OS no longer knows how to open.
export function attachmentFileName(att, index) {
  if (att?.filename) return safeSegment(att.filename);
  const subtype = String(att?.contentType || '').split('/')[1]?.split(';')[0].trim() || '';
  const ext = /^[a-z0-9]+$/i.test(subtype) ? subtype.toLowerCase() : 'bin';
  return `attachment-${index + 1}.${ext}`;
}

/** An attachment written beside an exported image, named after it. */
export function sidecarName(stem, name) {
  return `${stem} - ${name}`;
}

// Two attachments called invoice.pdf are ONE file on disk — and on macOS so are
// invoice.pdf and Invoice.PDF, so the collision test is case-insensitive.
export function dedupeNames(names) {
  const taken = new Set();
  return names.map((name) => {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let out = name;
    for (let n = 2; taken.has(out.toLowerCase()); n += 1) out = `${stem} (${n})${ext}`;
    taken.add(out.toLowerCase());
    return out;
  });
}
