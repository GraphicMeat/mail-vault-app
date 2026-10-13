// Pure comparator for the Blitz parity harness (overview, "Parity"). The
// iframe side arrives as getComputedStyle strings; the Blitz side arrives as
// render.inspect numbers. Both are normalised first, then compared under the
// overview's tolerances. No imports: the e2e runner (node) uses this file too.

export const TOLERANCE = { channel: 1, alpha: 0.01, x: 1, w: 1, y: 2, h: 2, fontSize: 0.01 };
export const COLOR_FIELDS = ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor'];

export function parseCssColor(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(Number);
  const s = String(value).trim().toLowerCase();
  if (s === 'transparent') return [0, 0, 0, 0];
  const m = s.match(/^rgba?\(([^()]*)\)$/);
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
  return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
}

export function parsePx(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const m = String(value).trim().match(/^(-?\d*\.?\d+)px$/);
  return m ? Number(m[1]) : null;
}

export function parseWeight(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const s = String(value).trim().toLowerCase();
  if (s === 'normal') return 400;
  if (s === 'bold') return 700;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function clusterLineCount(spans) {
  const sorted = [...spans].sort((a, b) => a.top - b.top);
  let count = 0;
  let cur = null;
  for (const { top, bottom } of sorted) {
    const mid = (top + bottom) / 2;
    if (cur && mid >= cur.top && mid <= cur.bottom) {
      cur.bottom = Math.max(cur.bottom, bottom);
    } else {
      count += 1;
      cur = { top, bottom };
    }
  }
  return count;
}

export function normalizeElement(raw) {
  const out = {
    mvId: raw.mvId,
    tag: raw.tag,
    rendered: !!raw.rendered,
    rect: raw.rect ? { x: raw.rect.x, y: raw.rect.y, w: raw.rect.w, h: raw.rect.h } : null,
    fontSize: parsePx(raw.fontSize),
    fontWeight: parseWeight(raw.fontWeight),
    fontFamily: raw.fontFamily ?? null,
    lineCount: raw.lineCount ?? null,
  };
  for (const f of COLOR_FIELDS) out[f] = parseCssColor(raw[f]);
  return out;
}

function colorsEqual(a, b) {
  if (!a || !b) return a === b;
  return [0, 1, 2].every((i) => Math.abs(a[i] - b[i]) <= TOLERANCE.channel)
    && Math.abs(a[3] - b[3]) <= TOLERANCE.alpha;
}

const within = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;

export function compareElements(iframeEls, blitzEls) {
  const A = iframeEls.map(normalizeElement);
  const B = new Map(blitzEls.map(normalizeElement).map((e) => [e.mvId, e]));
  const seen = new Set();
  const diffs = [];
  let compared = 0;
  const push = (a, field, iframe, blitz) => diffs.push({ mvId: a.mvId, tag: a.tag, field, iframe, blitz });
  for (const a of A) {
    seen.add(a.mvId);
    const b = B.get(a.mvId);
    if (!b) { push(a, 'presence', 'present', 'missing'); continue; }
    compared += 1;
    if (a.rendered !== b.rendered) { push(a, 'rendered', a.rendered, b.rendered); continue; }
    // display:none on both sides: Stylo leaves the subtree unstyled, so there
    // is nothing to compare.
    if (!a.rendered) continue;
    for (const f of COLOR_FIELDS) if (!colorsEqual(a[f], b[f])) push(a, f, a[f], b[f]);
    if (!within(a.fontSize, b.fontSize, TOLERANCE.fontSize)) push(a, 'fontSize', a.fontSize, b.fontSize);
    if (a.fontWeight !== b.fontWeight) push(a, 'fontWeight', a.fontWeight, b.fontWeight);
    // An inline with no text: WebKit reports a zero-width rect, Blitz none.
    const empty = (r) => !r || r.w === 0;
    if (!(empty(a.rect) && empty(b.rect))) {
      for (const k of ['x', 'y', 'w', 'h']) {
        if (!within(a.rect?.[k], b.rect?.[k], TOLERANCE[k])) push(a, k, a.rect?.[k] ?? null, b.rect?.[k] ?? null);
      }
    }
    if ((a.lineCount != null || b.lineCount != null) && a.lineCount !== b.lineCount) push(a, 'lineCount', a.lineCount, b.lineCount);
  }
  for (const b of B.values()) if (!seen.has(b.mvId)) diffs.push({ mvId: b.mvId, tag: b.tag, field: 'presence', iframe: 'missing', blitz: 'present' });
  return { compared, diffs };
}

export function isApproved(entry) {
  return !!entry
    && typeof entry.reason === 'string' && entry.reason.trim().length > 0
    && entry.approvedBy === 'Rokas'
    && /^\d{4}-\d{2}-\d{2}$/.test(entry.approvedOn || '');
}

const any = (want, got) => want === '*' || want === got;

export function matchKnownDiff(knownDiffs, { fixture, mode, width, mvId, field }) {
  return (knownDiffs?.entries || []).find((e) => isApproved(e)
    && e.fixture === fixture && any(e.mode, mode) && any(e.width, width)
    && any(e.mvId, mvId) && any(e.field, field)) || null;
}

export function compareFixture({ fixture, mode, width, iframe, blitz, knownDiffs }) {
  const { compared, diffs } = compareElements(iframe, blitz);
  const annotated = diffs.map((d) => {
    const k = matchKnownDiff(knownDiffs, { fixture, mode, width, mvId: d.mvId, field: d.field });
    return k ? { ...d, known: k.reason } : d;
  });
  const failing = annotated.filter((d) => !d.known);
  return { fixture, mode, width, compared, passed: failing.length === 0, failing, known: annotated.filter((d) => d.known) };
}
