import { useEffect, useState } from 'react';
import { clampComposeSize } from '../../utils/composeSize';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

// The embedded modal and the detached window both clamp a restored/resized
// size to whatever space is actually available right now, so a size saved on
// a bigger monitor never reopens off-screen. `window.innerWidth/Height` is
// the Tauri webview's own viewport either way — the detached window's is the
// OS window's client area.
const viewportBounds = () => ({ width: window.innerWidth - 32, height: window.innerHeight - 32 });

export function useComposeSize({ initialData, detached, composeSizeSetting, shellRef, setComposeSizeSetting }) {
  // A restored/minimized draft keeps the size it was at; a fresh embedded
  // compose opens at the last size chosen (mirrors contextSplit above). The
  // detached window's own size is set natively at creation (App.jsx passes
  // the remembered size to open_compose_window), so it needs no seed here.
  const [composeSize, setComposeSize] = useState(() => {
    const seed = initialData?._composeSize || (!detached && composeSizeSetting) || null;
    return seed ? clampComposeSize(seed, viewportBounds()) : null;
  });

  useEffect(() => {
    if (detached || !shellRef.current || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => {
      // The CSS resize handle reports a content box. Persisting that value as
      // the next border-box style width subtracts the border on every pass.
      // Use the rendered border box so observing then restoring is stable.
      const borderBox = Array.isArray(entry.borderBoxSize) ? entry.borderBoxSize[0] : entry.borderBoxSize;
      const width = borderBox?.inlineSize || shellRef.current?.offsetWidth;
      const height = borderBox?.blockSize || shellRef.current?.offsetHeight;
      if (!width || !height) return;
      setComposeSize(previous => (
        previous && Math.abs(previous.width - width) < 1 && Math.abs(previous.height - height) < 1
          ? previous
          : { width: Math.round(width), height: Math.round(height) }
      ));
    });
    observer.observe(shellRef.current);
    return () => observer.disconnect();
  }, [detached]);

  // Every new compose opens at the last size chosen — same write-through as
  // chooseContextSplit, debounced so a drag writes once it settles rather
  // than on every frame. `setComposeSizeSetting` is the relayed setter in a
  // detached window (ComposeWindow.jsx), so this is correct there too, should
  // this component ever observe its own resize; today only the embedded
  // ResizeObserver above feeds it (the effect below covers the detached case).
  useEffect(() => {
    if (detached || !composeSize) return undefined;
    const timer = setTimeout(() => {
      Promise.resolve(setComposeSizeSetting?.(composeSize)).catch(() => {});
    }, 300);
    return () => clearTimeout(timer);
  }, [detached, composeSize, setComposeSizeSetting]);

  // The detached window is a real OS window: its resize never touches
  // shellRef, so it gets its own listener straight from Tauri instead of the
  // ResizeObserver above. Debounced the same way.
  useEffect(() => {
    if (!detached || typeof window === 'undefined' || !window.__TAURI__) return undefined;
    const win = getCurrentWebviewWindow();
    // Every other spec's WebviewWindow stub is shaped for what it tests (most
    // only ever read `.label`) — a real one always has this, so skip quietly
    // rather than widen every mock in the suite for a method it never uses.
    if (typeof win?.onResized !== 'function') return undefined;
    let disposed = false;
    let timer;
    let stop;
    win.onResized(({ payload }) => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const scale = await win.scaleFactor();
          if (disposed || !payload?.width || !payload?.height) return;
          Promise.resolve(setComposeSizeSetting?.({ width: payload.width / scale, height: payload.height / scale })).catch(() => {});
        } catch { /* window gone mid-resize */ }
      }, 300);
    }).then(fn => { if (disposed) fn(); else stop = fn; }).catch(() => {});
    return () => { disposed = true; clearTimeout(timer); stop?.(); };
  }, [detached, setComposeSizeSetting]);

  const resizeComposeWindow = (event) => {
    const { key, shiftKey } = event;
    const widthDelta = key === 'ArrowLeft' ? -24 : key === 'ArrowRight' ? 24 : 0;
    const heightDelta = shiftKey && key === 'ArrowUp' ? -24 : shiftKey && key === 'ArrowDown' ? 24 : 0;
    if (!widthDelta && !heightDelta) return;
    event.preventDefault();
    setComposeSize(previous => {
      const current = previous || {
        width: shellRef.current?.clientWidth || 640,
        height: shellRef.current?.clientHeight || 520,
      };
      return clampComposeSize(
        { width: current.width + widthDelta, height: current.height + heightDelta },
        viewportBounds(),
      );
    });
  };

  return { composeSize, resizeComposeWindow };
}
