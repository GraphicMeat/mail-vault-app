import { selectionEndpoints, layerPlainText } from './selection';

const keyOf = (ep) => (ep ? `${ep.start.node}:${ep.start.offset}-${ep.end.node}:${ep.end.offset}` : '');

// How long a promise ClipboardItem may wait for the worker before the plain
// text that already went out stands.
const UPGRADE_MS = 800;

// The iframe's native copy puts CRLF in the plain flavour on Windows (the clipboard's own
// convention); setData writes exactly what it is given, so the Blitz copy adds them there.
// Same detection as the rest of the app (stores/slices/unifiedHelpers.js isWindowsPlatform),
// not imported from it: that module pulls the stores in.
const isWindowsPlatform = () => typeof navigator !== 'undefined'
  && (navigator.platform?.startsWith('Win') || navigator.userAgent?.includes('Windows'));

const note = (what, err) => console.debug(`[blitz] copy: ${what}`, err); // eslint-disable-line no-console

/**
 * Rich + plain copy for the Blitz layer. Serialize ahead, at the END of a
 * selection (pointer up, key up) or on a short pause for selections that have
 * no such event, so the copy event can write both formats synchronously (every
 * engine allows that). A copy that still beats the cache writes plain text
 * now and tries a promise ClipboardItem for the rich text; WKWebView rejects
 * that upgrade (the copy event's own setData changed the pasteboard), so the
 * plain text is the floor and the upgrade is only a bonus. The endpoints
 * decide what is copied, never the spans that happen to be loaded.
 *
 * Serialize runs at most once at a time with one trailing request, and a reply
 * is cached only while its selection is still the current one.
 */
export function createCopyController({ layerEl, serialize, debounceMs = 120, isWindows = isWindowsPlatform() }) {
  // Only what goes to the OS clipboard: cachedText (a reply's quote) stays LF.
  const osPlain = (text) => (isWindows ? text.replace(/\r?\n/g, '\r\n') : text);
  let timer = null;
  let cache = { key: '', result: null };
  let running = null; // { key, promise }
  let trailing = null; // { key, ep, promise, resolve, reject }
  let pointer = false; // a drag that started in the layer is still going
  let copyGen = 0;

  const current = () => {
    const el = layerEl();
    const ep = el ? selectionEndpoints(window.getSelection(), el) : null;
    return { el, ep, key: keyOf(ep) };
  };

  const start = (ep, key) => {
    const promise = serialize(ep.start, ep.end).then((result) => {
      if (current().key === key) cache = { key, result };
      return result;
    });
    running = { key, promise };
    const next = () => {
      if (running?.promise === promise) running = null;
      if (!trailing) return;
      const t = trailing;
      trailing = null;
      try { start(t.ep, t.key).then(t.resolve, t.reject); } catch (err) { t.reject(err); }
    };
    promise.then(next, next);
    return promise;
  };

  const request = (ep, key) => {
    if (cache.key === key && cache.result) return Promise.resolve(cache.result);
    if (running?.key === key) return running.promise;
    if (trailing?.key === key) return trailing.promise;
    if (!running) return start(ep, key);
    trailing?.reject(new Error('superseded'));
    let resolve; let reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    promise.catch(() => {});
    trailing = { key, ep, promise, resolve, reject };
    return promise;
  };

  const refresh = () => {
    clearTimeout(timer);
    try {
      const { ep, key } = current();
      if (ep) request(ep, key).catch((err) => note('serialize failed', err));
    } catch (err) { note('serialize failed', err); }
  };

  return {
    onSelectionChange() {
      clearTimeout(timer);
      // Mid-drag the selection is not final: pointer up asks instead.
      if (pointer) return;
      timer = setTimeout(refresh, debounceMs);
    },
    onPointerDown(target) {
      const el = layerEl();
      pointer = !!(el && target && el.contains(target));
    },
    onPointerUp() {
      if (!pointer) return;
      pointer = false;
      refresh();
    },
    onKeyUp() { refresh(); },
    onCopy(e) {
      const gen = ++copyGen;
      const { el, ep, key } = current();
      if (!ep) return;
      const hit = cache.key === key ? cache.result : null;
      if (hit?.text) {
        e.clipboardData.setData('text/html', hit.html);
        e.clipboardData.setData('text/plain', osPlain(hit.text));
        e.preventDefault();
        return;
      }
      // Nothing cached (or nothing visible in the range): the layer's own text
      // is the floor. With none of that either, the webview keeps the event.
      const plain = layerPlainText(window.getSelection(), el);
      if (!plain) return;
      e.clipboardData.setData('text/plain', osPlain(plain));
      e.preventDefault();
      if (hit) return; // serialize already said the range holds no rich text
      try {
        const p = request(ep, key);
        const blob = (field, type) => {
          const b = new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('upgrade timed out')), UPGRADE_MS);
            p.then((r) => {
              clearTimeout(t);
              // A newer copy owns the clipboard: never write over it.
              if (gen !== copyGen) reject(new Error('superseded by a later copy'));
              else resolve(new Blob([field === 'text' ? osPlain(r.text) : r[field]], { type }));
            }, (err) => { clearTimeout(t); reject(err); });
          });
          b.catch(() => {}); // the item rejects on its own; the plain text stands
          return b;
        };
        // eslint-disable-next-line no-undef
        const item = new ClipboardItem({ 'text/html': blob('html', 'text/html'), 'text/plain': blob('text', 'text/plain') });
        navigator.clipboard?.write?.([item])?.catch?.((err) => note('rich upgrade rejected', err));
      } catch (err) { note('no promise ClipboardItem', err); }
    },
    // The serialized plain text of the current selection, when it is already
    // in: a reply quotes it synchronously. Never asks the worker.
    cachedText() {
      try {
        const { ep, key } = current();
        return ep && cache.key === key && cache.result ? cache.result.text : null;
      } catch { return null; }
    },
    dispose() { clearTimeout(timer); },
  };
}
