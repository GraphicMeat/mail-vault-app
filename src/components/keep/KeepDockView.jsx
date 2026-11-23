// The dock of kept emails ("Keep in bubble"), as a view both apps render: props in, callbacks out, no
// store, no service, no Tauri (keep/__tests__/keepViewPurity.test.js). Desktop's container is
// components/KeepDock.jsx; the phone's is mobile/KeepDock.jsx. The rules are shared/keep.js.
//
// - `stacks`: `keptStacks(...)`, one round bubble per sender: the count for a group, the initial for one.
// - `expandedKey`: the stack whose panel the app holds open (a tap); `onExpand(key | null)` asks to change it.
//   Mouse hover and keyboard focus peek the same panel without asking the app.
// - `onOpen(item)`, `onRemove(id)` (one email), `onCloseStack(key)` (the whole bubble), `onMove(dock)`.
// Nothing here removes by clicking a bubble: only the panel's X buttons remove.
import React, { useEffect, useRef, useState } from 'react';
import { useT, useViewEnv } from '../settings/views/viewContext';
import { bubbleLabel, keepId, nudgeDock, snapDock } from '../../shared/keep';
import '../../styles/keep.css';

const isTouch = pointerType => pointerType === 'touch';

/** Escape and a press outside the dock fold the open panel; nothing is removed. */
function useCollapseOnDismiss(rootRef, expandedKey, onExpand) {
  useEffect(() => {
    if (!expandedKey) return undefined;
    const onKey = event => { if (event.key === 'Escape') onExpand(null); };
    const onPress = event => { if (!rootRef.current?.contains(event.target)) onExpand(null); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPress);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPress);
    };
  }, [expandedKey, onExpand, rootRef]);
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
        event.currentTarget.setPointerCapture?.(event.pointerId);
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
        const next = nudgeDock(dock, event.key);
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
  return (
    <div className="keep-panel" data-testid="keep-panel">
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

function Stack({ stack, expanded, onExpand, onOpen, onRemove, onCloseStack }) {
  const t = useT();
  const [peeking, setPeeking] = useState(false);
  const pointerType = useRef('mouse');
  // A press focuses the bubble too; only keyboard focus peeks, or a tap that folds the panel would reopen it.
  const pressed = useRef(false);
  const count = stack.items.length;
  const showPanel = expanded || peeking;
  const name = stack.sender.name || stack.sender.address || '';
  const open = item => { setPeeking(false); onExpand(null); onOpen(item); };
  const close = () => { setPeeking(false); onCloseStack(stack.key); onExpand(null); };
  return (
    <div
      className="keep-stack"
      data-testid="keep-stack"
      onPointerEnter={event => { if (!isTouch(event.pointerType)) setPeeking(true); }}
      onPointerLeave={() => setPeeking(false)}
      onFocus={() => { if (!pressed.current) setPeeking(true); }}
      onBlur={event => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        pressed.current = false;
        setPeeking(false);
      }}
    >
      <button
        type="button"
        className="keep-bubble"
        data-testid="keep-bubble"
        data-group={count > 1 ? '' : undefined}
        aria-expanded={expanded}
        aria-label={t('keep.stack', { name, count })}
        onPointerDown={event => { pointerType.current = event.pointerType; pressed.current = true; }}
        onClick={() => {
          if (count > 1 || isTouch(pointerType.current)) onExpand(expanded ? null : stack.key);
          else open(stack.items[0]);
        }}
      >
        <span className="keep-count" data-testid="keep-count" aria-hidden="true">{bubbleLabel(stack)}</span>
      </button>
      {showPanel && <Panel stack={stack} onOpen={open} onRemove={onRemove} onClose={close} />}
    </div>
  );
}

export function KeepDockView({ stacks, dock, expandedKey, onExpand, onOpen, onRemove, onCloseStack, onMove }) {
  const t = useT();
  const rootRef = useRef(null);
  useCollapseOnDismiss(rootRef, expandedKey, onExpand);
  if (!stacks.length) return null;
  return (
    <div
      ref={rootRef}
      className="keep-dock"
      data-testid="keep-dock"
      data-side={dock.side}
      role="region"
      aria-label={t('keep.dock')}
      style={{ top: `${dock.top * 100}vh` }}
    >
      <Grip dock={dock} rootRef={rootRef} onMove={onMove} />
      {stacks.map(stack => (
        <Stack key={stack.key} stack={stack} expanded={stack.key === expandedKey}
          onExpand={onExpand} onOpen={onOpen} onRemove={onRemove} onCloseStack={onCloseStack} />
      ))}
    </div>
  );
}
