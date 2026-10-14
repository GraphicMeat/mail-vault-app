import { useEffect, useRef } from 'react';
import { selectionInLayer } from './selection';

const isMacPlatform = () => typeof navigator !== 'undefined'
  && (navigator.platform?.startsWith('Mac') || navigator.userAgent?.includes('Mac'));

/**
 * Keys inside the focused Blitz body behave as inside the iframe: select-all
 * and copy are the body's, Escape clears its selection, and nothing else
 * reaches the app's window-level shortcuts (an iframe's keydown never does).
 * Cmd/Ctrl+C is not handled here: it is left alone so the webview fires the
 * `copy` event and the copy controller writes both formats from its cache.
 */
export function useBodyKeyboard(rootRef, { selectAll, layerEl, isMac = isMacPlatform() }) {
  // Callers pass fresh functions every render; the listener reads the latest.
  const latest = useRef({ selectAll, layerEl, isMac });
  latest.current = { selectAll, layerEl, isMac };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const onKeyDown = (e) => {
      const { selectAll: all, layerEl: layer, isMac: mac } = latest.current;
      // Plain Cmd/Ctrl only: Cmd+Shift+A, Alt variants (and Ctrl on a Mac) are other shortcuts.
      const plain = (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey) && !e.shiftKey && !e.altKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      // The physical key stands in on a layout whose letters are not Latin (Cyrillic and the
      // like); a Latin letter is trusted as typed (on AZERTY the A position types q).
      const is = (letter) => key === letter || (e.code === `Key${letter.toUpperCase()}` && !/^[a-z]$/i.test(e.key));
      if (plain && is('a')) {
        e.preventDefault();
        e.stopPropagation();
        void all();
        return;
      }
      if (plain && is('c')) { e.stopPropagation(); return; } // native copy -> copy event
      if (key === 'Escape') {
        const sel = window.getSelection();
        if (selectionInLayer(sel, layer())) { sel.removeAllRanges(); e.preventDefault(); }
        e.stopPropagation();
        return;
      }
      if (key === 'Tab') return;
      // Iframe parity, Rokas's decision (2026-10-11): app shortcuts do not
      // fire while the body has focus.
      e.stopPropagation();
    };
    root.addEventListener('keydown', onKeyDown);
    return () => root.removeEventListener('keydown', onKeyDown);
  }, [rootRef]);
}
