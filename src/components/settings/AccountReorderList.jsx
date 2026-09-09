import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GripVertical } from 'lucide-react';
import { useT } from '../../i18n';

export function AccountReorderList({ accounts, selectedAccountId, onReorder, children }) {
  const t = useT();
  const instructionsId = useId();
  const listRef = useRef(null);
  const pointerRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const [announcement, setAnnouncement] = useState('');

  const cancelDrag = () => {
    pointerRef.current = null;
    setDrag(null);
  };

  // Measure the rows at their current scroll position. Keeping them still until
  // drop gives the insertion marker a stable target, even with a long list.
  const updateTarget = () => {
    const pointer = pointerRef.current;
    const list = listRef.current;
    if (!pointer?.active || !list) return;
    const viewport = list.closest('.account-settings-list').getBoundingClientRect();
    pointer.overList = pointer.x >= viewport.left && pointer.x <= viewport.right
      && pointer.y >= viewport.top && pointer.y <= viewport.bottom;
    pointer.beforeId = [...list.children].find(row => {
      const rect = row.getBoundingClientRect();
      return pointer.y < rect.top + rect.height / 2;
    })?.dataset.accountId ?? null;
    setDrag({ ...pointer });
  };

  useEffect(() => {
    const onKeyDown = event => {
      if (event.key === 'Escape' && pointerRef.current) {
        event.preventDefault();
        event.stopPropagation();
        cancelDrag();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', cancelDrag);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', cancelDrag);
    };
  }, []);

  useEffect(() => {
    if (!drag) return;
    const scroller = listRef.current.closest('.account-settings-list');
    let frame;
    const scroll = () => {
      const pointer = pointerRef.current;
      if (!pointer?.active) return;
      const rect = scroller.getBoundingClientRect();
      if (pointer.overList) {
        const delta = pointer.y < rect.top + 32 ? -8 : pointer.y > rect.bottom - 32 ? 8 : 0;
        if (delta) {
          const previous = scroller.scrollTop;
          scroller.scrollTop += delta;
          if (previous !== scroller.scrollTop) updateTarget();
        }
      }
      frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(frame);
  }, [drag?.id]);

  const commitOrder = (accountId, ids) => {
    if (ids.every((id, index) => id === accounts[index]?.id)) return;
    onReorder(ids);
    setAnnouncement(t('settings.accounts.accountMoved', {
      email: accounts.find(account => account.id === accountId)?.email,
      position: ids.indexOf(accountId) + 1,
      total: ids.length,
    }));
  };

  const startDrag = (event, account) => {
    if (event.button !== 0 || event.isPrimary === false || pointerRef.current) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointerRef.current = {
      id: account.id, email: account.email, pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
    };
  };

  const moveDrag = event => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.active ||= Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY) >= 5;
    updateTarget();
  };

  const finishDrag = event => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    moveDrag(event);
    if (pointer.active && pointer.overList && pointer.beforeId !== pointer.id
      && accounts.some(account => account.id === pointer.id)) {
      const ids = accounts.map(account => account.id).filter(id => id !== pointer.id);
      const index = pointer.beforeId === null ? ids.length : ids.indexOf(pointer.beforeId);
      if (index >= 0) {
        ids.splice(index, 0, pointer.id);
        commitOrder(pointer.id, ids);
      }
    }
    cancelDrag();
  };

  const moveWithKeyboard = (event, accountId) => {
    if (pointerRef.current || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const ids = accounts.map(account => account.id);
    const index = ids.indexOf(accountId);
    const destination = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1
      : index + (event.key === 'ArrowUp' ? -1 : 1);
    if (destination < 0 || destination >= ids.length) return;
    ids.splice(index, 1);
    ids.splice(destination, 0, accountId);
    commitOrder(accountId, ids);
    requestAnimationFrame(() => event.target.scrollIntoView?.({ block: 'nearest' }));
  };

  return <>
    <p id={instructionsId} className="sr-only">{t('settings.accounts.reorderInstructions')}</p>
    <ol ref={listRef} aria-label={t('settings.accounts.accounts')}
      className={`account-settings-reorder-list ${drag ? 'is-reordering' : ''}`}
      data-drop-end={drag?.overList && drag.beforeId === null || undefined}>
      {accounts.map(account => <li key={account.id} data-account-id={account.id}
        data-drop-before={drag?.overList && drag.beforeId === account.id || undefined}
        className={`account-settings-account ${account.id === selectedAccountId ? 'account-settings-account-selected' : ''} ${drag?.id === account.id ? 'is-dragging' : ''}`}>
        {accounts.length > 1 && <button type="button" className="account-settings-drag-handle"
          aria-label={t('settings.accounts.reorderAccount', { email: account.email })}
          aria-describedby={instructionsId} title={t('settings.accounts.reorderInstructions')}
          onPointerDown={event => startDrag(event, account)} onPointerMove={moveDrag}
          onPointerUp={finishDrag} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
          onKeyDown={event => moveWithKeyboard(event, account.id)}>
          <GripVertical size={16} aria-hidden="true" />
        </button>}
        {children(account)}
      </li>)}
    </ol>
    <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
    {drag && createPortal(<div className="account-settings-drag-preview" aria-hidden="true"
      style={{ left: drag.x + 12, top: drag.y + 12 }}>
      <GripVertical size={16} /><span>{drag.email}</span>
    </div>, document.body)}
  </>;
}
