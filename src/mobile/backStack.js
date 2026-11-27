// System Back (Android's button and gesture) for the mobile app's layers: the viewer, the sheets and
// drawers, the move picker. The Android shell (wry's WryActivity) goes back in the WebView's
// history while it can, and only then leaves the app; so every open layer pushes one same-document
// history entry, and a `popstate` closes the top layer. A layer closed by the UI takes its entry
// back off with `history.go(-n)`, and the `popstate` that causes is ignored.
// A full-screen layer also names its element (`find`: a CSS selector, or a function that returns
// it), so the edge swipe moves the layer that Back would close (`topLayerElement`), whatever the
// order of the elements in the document.
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

/** Opens a layer that Back closes with `close`. Returns the function the UI calls when it closes it.
 *  `find`: the layer's element, a selector or a function (none for a sheet, a picker or a mode). */
export function pushLayer(close, find = null) {
  install();
  const layer = { close, find };
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

/** While `active`, Back calls `onClose` instead of leaving the app. `find`: see `pushLayer`. */
export function useBackLayer(active, onClose, find = null) {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => (active ? pushLayer(() => latest.current?.(), find) : undefined), [active]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * The element of the topmost layer that has one (a viewer, a search, settings), or null when none
 * does (nothing open, or only sheets, pickers and modes). A layer without an element on top of it
 * (an inline editor, an expanded dock) is what Back closes first; the swipe still moves the
 * full-screen layer under it, which comes back when it stays.
 */
export function topLayerElement() {
  for (let i = layers.length - 1; i >= 0; i--) {
    const { find } = layers[i];
    if (!find) continue;
    if (typeof find === 'function') {
      const el = find();
      if (el) return el;
      continue;
    }
    const all = [...document.querySelectorAll(find)].filter((n) => !n.closest('.mv-overlay'));
    if (all.length) return all[all.length - 1];
  }
  return null;
}

/** Closes the top layer the way System Back does (the edge swipe's commit). False with none open. */
export function popTopLayer() {
  if (layers.length === 0) return false;
  try {
    window.history.back();
  } catch {
    // No history: close it directly.
    const top = layers.pop();
    top?.close();
  }
  return true;
}

/** The settings screen's element for `useBackLayer` (the paywall shares its class, not its place). */
export const SETTINGS_LAYER = '.mv-settings:not(.mv-premium)';
