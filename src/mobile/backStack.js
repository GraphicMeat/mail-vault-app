// System Back (Android's button and gesture) for the mobile app's layers: the viewer, the sheets and
// drawers, the move picker. The Android shell (wry's WryActivity) goes back in the WebView's
// history while it can, and only then leaves the app; so every open layer pushes one same-document
// history entry, and a `popstate` closes the top layer. A layer closed by the UI takes its entry
// back off with `history.go(-n)`, and the `popstate` that causes is ignored.
import { useEffect, useRef } from 'react';

const layers = [];
let ignore = 0;
let backs = 0;
let installed = false;

function onPop() {
  if (ignore > 0) {
    ignore--;
    return;
  }
  const top = layers.pop();
  if (top) top.close();
}

function install() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('popstate', onPop);
}

// Several layers closing in one turn (the viewer with its picker open) leave in one traversal.
function goBack() {
  if (backs++ > 0) return;
  queueMicrotask(() => {
    const n = backs;
    backs = 0;
    ignore++;
    try {
      window.history.go(-n);
    } catch {
      ignore--;
    }
  });
}

/** Opens a layer that Back closes with `close`. Returns the function the UI calls when it closes it. */
export function pushLayer(close) {
  install();
  const layer = { close };
  layers.push(layer);
  try {
    window.history.pushState({ mvLayer: layers.length }, '');
  } catch {
    // No history (a locked-down WebView): Back then leaves the app, as before.
  }
  return () => {
    const at = layers.indexOf(layer);
    if (at < 0) return; // Back closed it, and took its entry with it
    layers.splice(at, 1);
    goBack();
  };
}

/** While `active`, Back calls `onClose` instead of leaving the app. */
export function useBackLayer(active, onClose) {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => (active ? pushLayer(() => latest.current?.()) : undefined), [active]);
}
