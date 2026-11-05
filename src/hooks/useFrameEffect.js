import { useLayoutEffect, useRef } from 'react';

/**
 * A layout effect re-run when `deps` change OR the frame element does. The
 * element is read as committed, not at render: a remounted <iframe> showing
 * the same srcDoc (a branch that toggles, thread to single on one message)
 * would otherwise load its document with nobody listening. Effects run in call
 * order, so a frame's listeners are added in the order its hooks are called.
 */
export function useFrameEffect(iframeRef, effect, deps) {
  const current = useRef(null); // { frame, deps, cleanup }
  useLayoutEffect(() => {
    const frame = iframeRef?.current || null;
    const was = current.current;
    if (was && was.frame === frame && was.deps.every((d, i) => Object.is(d, deps[i]))) return;
    was?.cleanup?.();
    current.current = { frame, deps, cleanup: frame ? effect(frame) : undefined };
  });
  useLayoutEffect(() => () => { current.current?.cleanup?.(); current.current = null; }, []);
}
