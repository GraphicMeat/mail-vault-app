import { useCallback, useRef, useState } from 'react';

export function useRowMenuState() {
  // Lifted row menu state — only one menu can be active at a time. A row
  // mounts its quick actions only while hovered or focused; the row whose
  // menu (or the folder/snooze picker it opened) is up stays mounted through
  // this, after the pointer has left it.
  const [activeMenuRowId, setActiveMenuRowId] = useState(null);
  // Pending delete confirmation lifted out of rows so the modal escapes the
  // virtualizer's transform stacking context.
  // { executor, copy: { title, description, confirmLabel } } | null
  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmationReturnRef = useRef(null);
  // Lifted saving state — tracks which rows have active save operations
  const [savingRowIds, setSavingRowIds] = useState(() => new Set());
  const startSaving = useCallback((id) => setSavingRowIds(prev => { const next = new Set(prev); next.add(id); return next; }), []);
  const stopSaving = useCallback((id) => setSavingRowIds(prev => { const next = new Set(prev); next.delete(id); return next; }), []);

  // Rows are React.memo'd, so every prop has to be referentially stable or the
  // whole render window re-renders on any list state change. These four are the
  // ones each row used to receive as a freshly-minted closure or object.
  const openRowMenu = useCallback((id) => setActiveMenuRowId(id), []);
  // A row closing its own menu must not release another row's.
  const closeRowMenu = useCallback((id) => setActiveMenuRowId(current => (id === undefined || current === id ? null : current)), []);
  const handleRowActionStart = useCallback((_event, trigger, entry) => {
    if (['delete', 'deleteServer', 'deleteEverywhere', 'unarchive'].includes(entry?.action)) {
      confirmationReturnRef.current = { trigger, row: trigger?.closest?.('.group') };
    }
  }, []);
  // `options` carries `confirmOptional`, which is what lets the
  // skip-confirmation setting reach this delete — see DeleteConfirmModal.
  const requestRowDelete = useCallback((executor, copy, options) => {
    setActiveMenuRowId(null);
    setPendingDelete({ executor, copy, ...options });
  }, []);

  return { activeMenuRowId, setActiveMenuRowId, pendingDelete, setPendingDelete, confirmationReturnRef, savingRowIds, setSavingRowIds, startSaving, stopSaving, openRowMenu, closeRowMenu, handleRowActionStart, requestRowDelete };
}
