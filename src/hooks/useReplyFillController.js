import { useLayoutEffect, useRef } from 'react';
import { createReplyFillController } from '../services/replyFill';
import { sameReply } from '../utils/sameReply';
import { composeSessionData, isTerminalCompose } from '../services/composeSession';

// Receipt is an opaque value on one outer UI window field. JSON omits the
// Symbol, so it never becomes session/draft/wire state or an attempt history.
export function applyReplyFillReceipt(windows, apply, targetId, receipt) {
  const next = apply(windows);
  if (next === windows) return windows;
  return next.map(window => window.id === targetId ? { ...window, _replyFillReceipt: receipt } : window);
}

export function useReplyFillController({ windows, setWindows, getContext, onError }) {
  const committed = useRef(windows);
  const pending = useRef(new Map());
  const mounted = useRef(false);
  const context = useRef(getContext);
  const error = useRef(onError);
  context.current = getContext;
  error.current = onError;
  const controller = useRef(null);
  if (!controller.current) controller.current = createReplyFillController({
    getWindows: () => committed.current,
    getContext: () => context.current(),
    onError: cause => error.current?.(cause),
    commitWindows: (apply, target) => new Promise(resolve => {
      if (!mounted.current) { resolve([]); return; }
      const receipt = Symbol('reply-fill');
      pending.current.set(receipt, { resolve, target });
      // This updater has no settlement effects or mutable controller reads.
      // Evaluating, discarding and replaying it produces the same full fill.
      setWindows(previous => applyReplyFillReceipt(previous, apply, target.id, receipt));
    }),
  });
  useLayoutEffect(() => {
    mounted.current = true;
    committed.current = windows;
    for (const [receipt, item] of pending.current) {
      const window = windows.find(candidate => candidate.id === item.target.id);
      const gone = !window || window.detached || isTerminalCompose(composeSessionData(window))
        || !sameReply(window, { mode: item.target.mode, replyTo: item.target.original });
      if (window?._replyFillReceipt === receipt || gone) {
        pending.current.delete(receipt);
        item.resolve(windows);
      }
    }
  }, [windows]);
  useLayoutEffect(() => () => {
    mounted.current = false;
    committed.current = [];
    for (const item of pending.current.values()) item.resolve([]);
    pending.current.clear();
  }, []);
  return controller.current;
}
