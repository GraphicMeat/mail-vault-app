// jsdom draws nothing, and its Range has no rect methods. ProseMirror asks a
// Range for them when it scrolls the caret into view (after a focus() or an
// inserted picture, often a frame later), and a missing method there is an
// uncaught exception that fails the whole run whichever spec happened to be
// running. Zero rects are what a hidden element reports.
if (typeof Range !== 'undefined') {
  Range.prototype.getClientRects ??= () => Object.assign([], { item: () => null });
  Range.prototype.getBoundingClientRect ??= () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
}

// The body scan is the daemon's (`body.scan`, src-core/src/body_scan) and a
// test has no daemon: every renderer gets the scan answered at once, nothing
// found and the body framed as given (src/test/bodyScan.js), the way the demo
// backend answers. A test about what a renderer does with a finding stubs its
// own answer; the client's own tests (services/__tests__/bodyScan.test.js)
// unmock it.
import { vi } from 'vitest';
vi.mock('./src/services/bodyScan.js', async (orig) => (await import('./src/test/bodyScan.js')).stubBodyScan(orig));
