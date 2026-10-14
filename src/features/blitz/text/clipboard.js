import { selectionEndpoints, layerPlainText } from './selection';

const keyOf = (ep) => (ep ? `${ep.start.node}:${ep.start.offset}-${ep.end.node}:${ep.end.offset}` : '');

/**
 * Rich + plain copy for the Blitz layer. Serialize ahead on selectionchange so
 * the copy event can write both formats synchronously (every engine allows
 * that); inside the debounce window, plain now + rich via a promise
 * ClipboardItem when the engine has one. The endpoints decide what is copied,
 * never the spans that happen to be loaded.
 */
export function createCopyController({ layerEl, serialize, debounceMs = 120 }) {
  let timer = null;
  let cache = { key: '', result: null };
  let inflight = null; // { key, promise }

  const current = () => {
    const el = layerEl();
    const ep = el ? selectionEndpoints(window.getSelection(), el) : null;
    return { el, ep, key: keyOf(ep) };
  };

  const request = (ep, key) => {
    if (inflight?.key === key) return inflight.promise;
    const promise = serialize(ep.start, ep.end).then((result) => {
      if (cache.key !== key) cache = { key, result };
      return result;
    });
    inflight = { key, promise };
    promise.catch(() => {}).finally(() => { if (inflight?.key === key) inflight = null; });
    return promise;
  };

  return {
    onSelectionChange() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const { ep, key } = current();
        if (ep) request(ep, key).catch(() => {});
      }, debounceMs);
    },
    onCopy(e) {
      const { el, ep, key } = current();
      if (!ep) return;
      if (cache.key === key && cache.result) {
        e.clipboardData.setData('text/html', cache.result.html);
        e.clipboardData.setData('text/plain', cache.result.text);
        e.preventDefault();
        return;
      }
      e.clipboardData.setData('text/plain', layerPlainText(window.getSelection(), el));
      e.preventDefault();
      try {
        const p = request(ep, key);
        const blob = (field, type) => {
          const b = p.then(r => new Blob([r[field]], { type }));
          b.catch(() => {}); // a rejected serialize leaves the plain text; the item rejects on its own
          return b;
        };
        // eslint-disable-next-line no-undef
        const item = new ClipboardItem({ 'text/html': blob('html', 'text/html'), 'text/plain': blob('text', 'text/plain') });
        navigator.clipboard?.write?.([item])?.catch?.(() => {});
      } catch { /* no promise ClipboardItem: the plain text already went out */ }
    },
    dispose() { clearTimeout(timer); },
  };
}
