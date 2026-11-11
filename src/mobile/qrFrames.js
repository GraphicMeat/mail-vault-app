// The desktop's set-up code is too big for one QR code, so it cycles through frames
// `MVQR1:<id>:<i>/<n>:<chunk>` (core `transfer::phone::frames`). The page reads only the header,
// to show "Part 2 of 3", keep each part once and start over when the computer shows a new code;
// the engine assembles and decrypts (`mobile.transfer.import`). Accepts exactly the frames core's
// `parse_frame` accepts: lower-case hex id, 1 <= i <= n <= 99, a non-empty base64url chunk.

const MAX_FRAME_CHARS = 800;
const FRAME = /^MVQR1:([0-9a-f]{8}):(\d{1,2})\/(\d{1,2}):([A-Za-z0-9_-]+)$/;

/** `{ id, index, total }` of a frame text, or null for anything else. */
export function parseFrameHeader(text) {
  if (typeof text !== 'string' || text.length > MAX_FRAME_CHARS) return null;
  const m = FRAME.exec(text);
  if (!m) return null;
  const index = Number(m[2]);
  const total = Number(m[3]);
  if (index < 1 || index > total || total > 99) return null;
  return { id: m[1], index, total };
}

/**
 * The parts of one code. `push(text)` answers `{ result, have, total, done }`: `added`, `repeat`
 * (that part is already in), `reset` (a frame of another code: the earlier parts are dropped) or
 * `ignored` (not a frame, or a total its own code disagrees with).
 */
export function createCollector() {
  let id = null;
  let parts = [];
  const progress = (result) => {
    const have = parts.filter(Boolean).length;
    return { result, have, total: parts.length, done: parts.length > 0 && have === parts.length };
  };
  return {
    push(text) {
      const h = parseFrameHeader(text);
      if (!h) return progress('ignored');
      let result = 'added';
      if (id !== null && h.id !== id) {
        result = 'reset';
        id = null;
      }
      if (id === null) {
        id = h.id;
        parts = new Array(h.total).fill(null);
      } else if (h.total !== parts.length) {
        return progress('ignored');
      }
      if (parts[h.index - 1] !== null) return progress('repeat');
      parts[h.index - 1] = text;
      return progress(result);
    },
    /** The frame texts held, in part order. */
    frames() {
      return parts.filter(Boolean);
    },
  };
}

/**
 * Scans until every part of one code is in and answers the frames, or null once `stopped()` says
 * so. `onProgress` gets `{ have, total, foreign }` after each read (`foreign`: that read was a QR
 * code that is not a MailVault frame). A failing `scan` rejects with its error.
 */
export async function scanUntilComplete({ scan, onProgress, stopped = () => false }) {
  const collector = createCollector();
  while (!stopped()) {
    const text = await scan();
    if (stopped()) return null;
    const p = collector.push(text);
    onProgress?.({ have: p.have, total: p.total, foreign: p.result === 'ignored' && parseFrameHeader(text) === null });
    if (p.done) return collector.frames();
  }
  return null;
}
