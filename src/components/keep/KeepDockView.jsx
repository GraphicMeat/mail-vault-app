// The dock of kept emails ("Keep in bubble"), as a view both apps render: props in, callbacks out, no
// store, no service, no Tauri (keep/__tests__/keepViewPurity.test.js). Desktop's container is
// components/KeepDock.jsx; the phone's is mobile/KeepDock.jsx. The rules are shared/keep.js.
//
// - `stacks`: `keptStacks(...)`, one round bubble per sender: the count for a group, the initial for one.
// - `expandedKey`: the stack whose panel the app holds open (a tap); `onExpand(key | null)` asks to change it.
//   Mouse hover and keyboard focus peek the same panel without asking the app.
// - `onOpen(item)`, `onRemove(id)` (one email), `onCloseStack(key)` (the whole bubble), `onMove(dock)`.
// Nothing here removes by clicking a bubble: only the panel's X buttons remove.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT, useViewEnv } from '../settings/views/viewContext';
import { BOTTOM_CLEARANCE, bubbleLabel, keepId, nudgeDock, snapDock } from '../../shared/keep';
import '../../styles/keep.css';

const isTouch = pointerType => pointerType === 'touch';

/** Escape and a press outside the dock fold the open panel and any peek; nothing is removed. */
function useDismissPanels(rootRef, active, dismiss) {
  useEffect(() => {
    if (!active) return undefined;
    const onKey = event => {
      if (event.key !== 'Escape') return;
      // Another layer holding focus (a field, a dialog) keeps its own Escape; the dock's is for the page and the dock.
      const { target } = event;
      const ours = target === document || target === document.body || rootRef.current?.contains(target);
      if (!ours) return;
      // The fold is this Escape's whole job: the app's own Escape (close a reader, leave a page) must not also run.
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    };
    const onPress = event => { if (!rootRef.current?.contains(event.target)) dismiss(); };
    // Capture phase: the app's own Escape and press handlers may stop the event before it bubbles here.
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPress, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPress, true);
    };
  }, [active, dismiss, rootRef]);
}

/** The handle that moves the dock: a drag drops it on the nearer side, arrow keys nudge it. */
function Grip({ dock, rootRef, onMove }) {
  const t = useT();
  const start = useRef(null);
  const shift = (dx, dy) => { rootRef.current.style.transform = `translate(${dx}px, ${dy}px)`; };
  const drop = () => {
    const root = rootRef.current;
    const rect = root.getBoundingClientRect();
    root.style.transform = '';
    onMove(snapDock(rect, { width: window.innerWidth, height: window.innerHeight }));
  };
  return (
    <button
      type="button"
      className="keep-grip"
      data-testid="keep-dock-grip"
      aria-label={t('keep.move')}
      title={t('keep.move')}
      onPointerDown={event => {
        // Capture keeps the drag on the grip past its edge; a pointer that already ended has none to give.
        try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* the drag still follows the grip */ }
        start.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerMove={event => {
        if (start.current) shift(event.clientX - start.current.x, event.clientY - start.current.y);
      }}
      onPointerUp={() => {
        if (!start.current) return;
        start.current = null;
        drop();
      }}
      onPointerCancel={() => { start.current = null; rootRef.current.style.transform = ''; }}
      onKeyDown={event => {
        const fit = { height: rootRef.current.getBoundingClientRect().height, viewportHeight: window.innerHeight };
        const next = nudgeDock(dock, event.key, fit);
        if (next === dock) return;
        event.preventDefault();
        onMove(next);
      }}
    ><span aria-hidden="true" className="keep-grip-dots" /></button>
  );
}

function Row({ item, onOpen, onRemove }) {
  const t = useT();
  const { Private } = useViewEnv();
  return (
    <li className="keep-row-wrap">
      <button type="button" className="keep-row" data-testid="keep-row" onClick={() => onOpen(item)}>
        <span className="keep-row-subject"><Private kind="text">{item.subject || t('common.noSubject')}</Private></span>
      </button>
      <button type="button" className="keep-x" data-testid="keep-row-remove" aria-label={t('keep.remove')}
        title={t('keep.remove')} onClick={() => onRemove(keepId(item))}>×</button>
    </li>
  );
}

function Panel({ stack, onOpen, onRemove, onClose }) {
  const t = useT();
  const { Private } = useViewEnv();
  const panelRef = useRef(null);
  const [flip, setFlip] = useState(false);
  // A panel that would run under the foot opens upward instead, when there is room above the bubble.
  useLayoutEffect(() => {
    // The panel's parent is its stack (a child's layout effect runs before the stack's ref is set).
    const bubble = panelRef.current.parentElement.getBoundingClientRect();
    const { height } = panelRef.current.getBoundingClientRect();
    setFlip(bubble.top + height > window.innerHeight - BOTTOM_CLEARANCE && bubble.bottom - height >= 0);
  }); // every render: a moved dock or a changed list changes the room, and an unchanged flip bails out
  return (
    <div ref={panelRef} className="keep-panel" data-testid="keep-panel" data-flip={flip ? '' : undefined}>
      <div className="keep-panel-head">
        <span className="keep-panel-name"><Private kind="name">{stack.sender.name || stack.sender.address}</Private></span>
        <span className="keep-panel-count">{stack.items.length}</span>
        <button type="button" className="keep-x" data-testid="keep-panel-close" aria-label={t('keep.closeStack')}
          title={t('keep.closeStack')} onClick={onClose}>×</button>
      </div>
      <ul className="keep-rows">
        {stack.items.map(item => <Row key={keepId(item)} item={item} onOpen={onOpen} onRemove={onRemove} />)}
      </ul>
    </div>
  );
}

function Stack({ stack, expanded, peeking, hushed, onExpand, onPeek, onOpen, onRemove, onCloseStack }) {
  const t = useT();
  const { Private } = useViewEnv();
  const pointerType = useRef('mouse');
  // A press focuses the bubble too; only keyboard focus peeks, or a tap that folds the panel would reopen it.
  const pressed = useRef(false);
  const count = stack.items.length;
  // Another group held open keeps its panel alone: a hover over a neighbour does not stack a second one on it.
  const showPanel = expanded || (peeking && !hushed);
  const name = stack.sender.name || stack.sender.address || '';
  const open = item => { onPeek(false); onExpand(null); onOpen(item); };
  const close = () => { onPeek(false); onCloseStack(stack.key); onExpand(null); };
  return (
    <div
      className="keep-stack"
      data-testid="keep-stack"
      onPointerEnter={event => { if (!isTouch(event.pointerType)) onPeek(true); }}
      onPointerLeave={() => onPeek(false)}
      onFocus={() => { if (!pressed.current) onPeek(true); }}
      onBlur={event => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        pressed.current = false;
        onPeek(false);
      }}
    >
      <button
        type="button"
        className="keep-bubble"
        data-testid="keep-bubble"
        data-group={count > 1 ? '' : undefined}
        aria-expanded={count > 1 || expanded ? expanded : undefined}
        aria-label={t('keep.stack', { name, count })}
        onPointerDown={event => { pointerType.current = event.pointerType; pressed.current = true; }}
        onClick={() => {
          if (count > 1 || isTouch(pointerType.current)) onExpand(expanded ? null : stack.key);
          else open(stack.items[0]);
        }}
      >
        <span className="keep-count" data-testid="keep-count" aria-hidden="true">
          {count > 1 ? bubbleLabel(stack) : <Private kind="name">{bubbleLabel(stack)}</Private>}
        </span>
      </button>
      {showPanel && <Panel stack={stack} onOpen={open} onRemove={onRemove} onClose={close} />}
    </div>
  );
}

export function KeepDockView({ stacks, dock, expandedKey, onExpand, onOpen, onRemove, onCloseStack, onMove }) {
  const t = useT();
  const rootRef = useRef(null);
  // The one stack a mouse hover or keyboard focus shows a panel for; a tap's panel is `expandedKey`.
  const [peekKey, setPeekKey] = useState(null);
  const dismiss = useCallback(() => { setPeekKey(null); onExpand(null); }, [onExpand]);
  useDismissPanels(rootRef, Boolean(expandedKey || peekKey), dismiss);
  if (!stacks.length) return null;
  return (
    <div
      ref={rootRef}
      className="keep-dock"
      data-testid="keep-dock"
      data-side={dock.side}
      role="region"
      aria-label={t('keep.dock')}
      // The dock never runs below the screen: past this height its bubbles wrap into another column.
      // --keep-top is the dock's height; keep.css lifts it clear of a phone's status bar.
      style={{ '--keep-top': `${dock.top * 100}vh`, maxHeight: `calc(${(1 - dock.top) * 100}vh - ${BOTTOM_CLEARANCE}px)` }}
    >
      <Grip dock={dock} rootRef={rootRef} onMove={onMove} />
      {stacks.map(stack => (
        <Stack key={stack.key} stack={stack} expanded={stack.key === expandedKey} peeking={stack.key === peekKey}
          onPeek={on => setPeekKey(key => (on ? stack.key : (key === stack.key ? null : key)))}
          hushed={Boolean(expandedKey) && stack.key !== expandedKey}
          onExpand={onExpand} onOpen={onOpen} onRemove={onRemove} onCloseStack={onCloseStack} />
      ))}
    </div>
  );
}
