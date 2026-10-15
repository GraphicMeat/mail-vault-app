import { useEffect, useState } from 'react';

// Lazy open: a body far below the fold (thread overscan 8, chat overscan 5)
// is mounted but costs the worker nothing until it is within `margin` of the
// viewport. IntersectionObserver applies every ancestor's clip, so the root is
// the nearest scroll container (a viewport root would only see the body once it
// scrolls into that container's visible box); none above means the viewport.
// Once near, stays near: the virtualizer unmounts what scrolls far away.
export function useNearViewport(ref, { enabled = true, margin = '100% 0px' } = {}) {
  const [near, setNear] = useState(!enabled);
  useEffect(() => {
    if (!enabled) { setNear(true); return undefined; }
    const el = ref.current;
    const IO = globalThis.IntersectionObserver;
    if (!el || !IO) { setNear(true); return undefined; }
    const root = el.closest('.overflow-y-auto, [data-blitz-scroll-root]') ?? null;
    const io = new IO((entries) => {
      if (entries.some(e => e.isIntersecting)) { setNear(true); io.disconnect(); }
    }, { root, rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [enabled, ref, margin]);
  return near;
}
