// jsdom draws nothing, and its Range has no rect methods. ProseMirror asks a
// Range for them when it scrolls the caret into view (after a focus() or an
// inserted picture, often a frame later), and a missing method there is an
// uncaught exception that fails the whole run whichever spec happened to be
// running. Zero rects are what a hidden element reports.
if (typeof Range !== 'undefined') {
  Range.prototype.getClientRects ??= () => Object.assign([], { item: () => null });
  Range.prototype.getBoundingClientRect ??= () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
}
