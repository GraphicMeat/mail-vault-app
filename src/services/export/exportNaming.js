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
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from || '');
  return safeSegment(match ? (match[1] || match[2]) : (from || 'Unknown sender'), 60);
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
  const range = first === last ? first : `${first} to ${last}`;
  return `${range} - ${rootSubject(sorted[0].subject)}.${ext}`;
}

export function threadMemberName(message, index, ext) {
  const d = message.date;
  return `${pad(index + 1)} - ${day(d)} ${time(d)} - ${senderLabel(message.from)}.${ext}`;
}

export function pageName(baseName, page, total) {
  if (total <= 1) return baseName;
  const dot = baseName.lastIndexOf('.');
  return `${baseName.slice(0, dot)} (${page} of ${total})${baseName.slice(dot)}`;
}
