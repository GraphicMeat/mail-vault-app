// Daemon-shaped answers to `body.scan` for component tests. The rules that
// produce them are the daemon's (src-core/src/body_scan, held to the JS it
// replaced by tests/fixtures/body-scan-cases.json); these tests check what a
// renderer does with an answer: which body it frames, what it records, what
// the frame's head carries.

/** An answer: nothing found, the body framed as given, unless `over` says otherwise. */
export function bodyScanAnswer(html, over = {}) {
  return { trackers: [], count: 0, https: 0, summary: null, html: html || '', alerts: [], maxAlertLevel: null, scanned: true, ...over };
}

/**
 * A `vi.mock` factory for services/bodyScan that answers from `answer`
 * (called with the body and the scan options) at once, so a renderer frames
 * on its first render:
 *   vi.mock('.../services/bodyScan', (orig) => stubBodyScan(orig, (html, opts) => bodyScanAnswer(html)))
 */
export async function stubBodyScan(importOriginal, answer = (html) => bodyScanAnswer(html)) {
  const real = await importOriginal();
  const scans = [];
  // One answer object per body and options, as the real cache keeps: a
  // renderer memoizes on it, and a fresh object per render rebuilds its frame.
  const kept = new Map();
  const ask = (html, opts = {}) => {
    const id = `${html}\u0000${JSON.stringify(opts)}`;
    if (!kept.has(id)) {
      scans.push({ html, opts });
      kept.set(id, answer(html, opts));
    }
    return kept.get(id);
  };
  return {
    ...real,
    __scans: scans,
    peekBodyScan: (html, opts) => ask(html, opts),
    useBodyScan: (html, opts) => ask(html, opts),
    scanBody: async (html, opts) => ask(html, opts),
  };
}

/**
 * A `vi.mock` factory for services/bodyScan whose `classifyLinks` answers the
 * way the daemon answers these links: `levels` maps an href to its level, any
 * other link is not flagged.
 *   vi.mock('.../services/bodyScan', (orig) => stubLinkVerdicts(orig, { 'javascript:x()': 'red' }))
 */
export async function stubLinkVerdicts(importOriginal, levels) {
  return {
    ...(await stubBodyScan(importOriginal)),
    classifyLinks: async (links) => links.map(l => ({ level: levels[l.href] ?? null })),
  };
}
