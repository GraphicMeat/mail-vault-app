import { useEffect, useMemo, useRef, useState } from 'react';
import { docKey, getDocRegistry } from './docRegistry';

const DISCARDED = 'render_discarded';

/**
 * The doc to show for `params` (null = not yet: width unknown, far away).
 *
 * Keeps plan C's rule: on a key change the previous key's doc stays on screen
 * until the new doc lands, then the old key is released ({ now: true } closes
 * it unless another body holds it). A reply for a key that was superseded
 * before it landed is released at once and never painted. Unmount releases
 * with deferral when `deferOnUnmount` (the lazy surfaces: churn reuse), at
 * once otherwise.
 * `busy` is true while what is on screen is not the current key's doc.
 * A holder whose open is discarded by another holder's retry opens again.
 * `retry()` discards the current key's doc and opens it again; the discarded
 * doc is off screen in the same render, so none of its tiles can fail the retry.
 */
export function useSurfaceDoc(params, { deferOnUnmount = false, registry = getDocRegistry() } = {}) {
  // The key hashes up to 4 MiB of html: only when what it is made of changes (hover re-renders run constantly).
  const themeKey = JSON.stringify(params?.theme ?? null);
  const key = useMemo(
    () => (params ? docKey(params) : null),
    [params?.html, params?.cssWidth, params?.scale, params?.allowRemote, themeKey], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [state, setState] = useState({ key: null, doc: null, error: null, sentWidth: null });
  const [attempt, setAttempt] = useState(0);
  const held = useRef(null); // the key whose doc is on screen (one registry ref held)
  const unmounted = useRef(false);
  const deferRef = useRef(deferOnUnmount);
  deferRef.current = deferOnUnmount;
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    const sentWidth = paramsRef.current.cssWidth;
    registry.acquire(key, paramsRef.current).then(
      (doc) => {
        if (!live) {
          // Superseded (or unmounted) before it landed: never painted. Superseded closes at once; an
          // unmounted lazy body keeps it for the churn that follows.
          registry.release(key, { now: !(unmounted.current && deferRef.current) });
          return;
        }
        const prev = held.current;
        held.current = key;
        setState({ key, doc, error: null, sentWidth });
        if (prev && prev !== key) registry.release(prev, { now: true });
      },
      (err) => {
        if (!live) return;
        // render_discarded while this body still wants the doc: another holder of the same key retried and threw
        // the entry away. Not a failure: open again (the next acquirer joins whichever new entry is already pending).
        if (err?.message === DISCARDED) { setAttempt(n => n + 1); return; }
        const prev = held.current;
        held.current = null;
        setState({ key, doc: null, error: err?.message || err?.code || String(err), sentWidth });
        if (prev && prev !== key) registry.release(prev, { now: true });
      },
    );
    return () => { live = false; };
  }, [key, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // render-updated for the doc on screen (rev and meta change as images land).
  useEffect(() => {
    if (!state.key || !state.doc) return undefined;
    const k = state.key;
    return registry.subscribe(k, (doc) => setState(s => (s.key === k ? { ...s, doc } : s)));
  }, [state.key, state.doc?.docId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      if (held.current) registry.release(held.current, { now: !deferRef.current });
      held.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const current = !!key && state.key === key;
  return {
    key,
    doc: state.doc, // may still be the previous key's doc while the new one opens
    sentWidth: state.sentWidth,
    error: current ? state.error : null,
    busy: !!key && !(current && (state.doc || state.error)),
    retry: () => {
      if (!key) return;
      if (held.current === key) held.current = null;
      registry.discard(key);
      setState({ key, doc: null, error: null, sentWidth: state.sentWidth });
      setAttempt(n => n + 1);
    },
  };
}
