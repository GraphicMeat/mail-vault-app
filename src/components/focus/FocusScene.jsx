import React, { useEffect, useRef, useState } from 'react';
import { SCENE_LOADERS, loadWorld } from './scenes/index.js';
import { nextInk } from './ink.js';
import '../../styles/focus-scene.css';

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

/**
 * The animated backdrop of a focus lock: a pixel-art diorama whose day runs
 * from dawn at `startedAt` to night at `endsAt`. Fills its positioned parent.
 *
 * `textRef` is the countdown block on top. It is measured so the diorama is
 * framed in the free space below it, at any window size.
 *
 * Fails soft. No WebGL (some Linux VMs and remote desktops), a chunk that will
 * not load, or a GPU that drops the context calls `onUnavailable`, and the
 * lock goes back to its plain look. A lock must never fail to lock.
 *
 * Reduced motion keeps the scene still; only the light follows the session.
 *
 * The countdown's ink follows the sky (ink.js): dark on the day sky, light
 * once it darkens, set as `data-ink` on the text block.
 */
export function FocusScene({ scene, startedAt, endsAt, textRef, onUnavailable }) {
  const hostRef = useRef(null);
  const canvasRef = useRef(null);
  const [ready, setReady] = useState(false);
  const failRef = useRef(onUnavailable);
  failRef.current = onUnavailable;

  useEffect(() => {
    const load = SCENE_LOADERS[scene];
    if (!load) { failRef.current?.(); return undefined; }
    let world = null;
    let cancelled = false;
    let ro = null;
    let timer = 0;
    const canvas = canvasRef.current;
    const span = Math.max(1, endsAt - startedAt);
    const progress = () => Math.min(1, Math.max(0, (Date.now() - startedAt) / span));
    const onLost = () => { if (!cancelled) failRef.current?.(); };
    let ink = null;
    const syncInk = () => {
      const next = nextInk(ink, world.skyLuminance());
      if (next === ink) return;
      ink = next;
      if (textRef?.current) textRef.current.dataset.ink = next;
    };
    const still = reducedMotion();

    (async () => {
      try {
        const [{ createWorld }, mod] = await Promise.all([loadWorld(), load()]);
        if (cancelled) return;
        world = createWorld(canvas, { still });
        world.onError = (err) => { if (!cancelled) failRef.current?.(err); };
        canvas.addEventListener('webglcontextlost', onLost);
        world.mount(mod.createScene);
        world.setProgress(progress());
        syncInk();
        // Layout offsets, not rects: the lock's opening scale animation would
        // skew a rect. Text and host share the lock panel as offset parent.
        const syncInset = () => {
          const host = hostRef.current, text = textRef?.current;
          if (host && text) world.setInsetTop(text.offsetTop + text.offsetHeight - host.offsetTop + 12);
        };
        syncInset();
        ro = new ResizeObserver(syncInset);
        if (textRef?.current) ro.observe(textRef.current);
        const tick = () => { world.setProgress(progress()); syncInk(); };
        if (still) timer = window.setInterval(() => { if (!document.hidden) tick(); }, 5000);
        else world.onFrame = tick;
        world.start();
        setReady(true);
      } catch (err) {
        if (!cancelled) failRef.current?.(err);
      }
    })();

    return () => {
      cancelled = true;
      ro?.disconnect();
      window.clearInterval(timer);
      canvas?.removeEventListener('webglcontextlost', onLost);
      world?.dispose();
    };
  }, [scene, startedAt, endsAt, textRef]);

  return (
    <div ref={hostRef} className="focus-scene" aria-hidden="true" data-testid="focus-scene" data-scene={scene}>
      {/* Keyed to the session: dispose() hands the GPU context back, so a
          later scene must never be drawn on the old, context-lost canvas. */}
      <canvas key={`${scene}:${startedAt}:${endsAt}`} ref={canvasRef} className={ready ? 'is-ready' : undefined} />
    </div>
  );
}
