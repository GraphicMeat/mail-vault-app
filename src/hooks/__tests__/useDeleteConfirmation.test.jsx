// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { useDeleteConfirmation, READER_CONFIRMING_ACTIONS } from '../useDeleteConfirmation';
import { useRowMenuState, confirmationReturnTarget } from '../emailList/useRowMenuState';

const nextFrame = () => act(async () => { await new Promise(r => requestAnimationFrame(() => r())); });
const pending = { executor: vi.fn(), copy: { title: 'Delete?', description: '', confirmLabel: 'Delete' } };

afterEach(() => cleanup());

function Buttons() {
  return <div className="group"><button data-testid="first">first</button><button data-testid="trigger">trigger</button></div>;
}

describe('useDeleteConfirmation', () => {
  it('raises a pending delete, and closing it hands focus back to the noted trigger', async () => {
    const { getByTestId } = render(<Buttons />);
    const trigger = getByTestId('trigger');
    const { result } = renderHook(() => useDeleteConfirmation());
    act(() => result.current.onActionStart({}, trigger, { action: 'delete' }));
    act(() => result.current.request(pending));
    expect(result.current.modalProps.pending).toBe(pending);
    act(() => result.current.modalProps.onClose());
    expect(result.current.pending).toBeNull();
    await nextFrame();
    expect(document.activeElement).toBe(trigger);
  });

  it('notes the trigger only for the actions that confirm', async () => {
    const { getByTestId } = render(<Buttons />);
    const { result } = renderHook(() => useDeleteConfirmation());
    act(() => result.current.onActionStart({}, getByTestId('trigger'), { action: 'archive' }));
    act(() => result.current.modalProps.onClose());
    await nextFrame();
    expect(document.activeElement).toBe(document.body);
    const reader = renderHook(() => useDeleteConfirmation({ actions: READER_CONFIRMING_ACTIONS }));
    act(() => reader.result.current.onActionStart({}, getByTestId('trigger'), { action: 'archive' }));
    act(() => reader.result.current.modalProps.onClose());
    await nextFrame();
    expect(document.activeElement).toBe(getByTestId('trigger'));
  });

  it('dismiss drops the pending delete without moving focus, and tells onOpenChange', async () => {
    const { getByTestId } = render(<Buttons />);
    const onOpenChange = vi.fn();
    const { result } = renderHook(() => useDeleteConfirmation({ onOpenChange }));
    act(() => result.current.onActionStart({}, getByTestId('trigger'), { action: 'delete' }));
    act(() => result.current.request(pending));
    act(() => result.current.dismiss());
    await nextFrame();
    expect(result.current.pending).toBeNull();
    expect(document.activeElement).toBe(document.body);
    expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
  });

  // request(null) closes it, so onOpenChange must hear a close, not an open
  // (a chat bubble would keep its hover bar up over nothing).
  it('request(null) tells onOpenChange the confirm is closed', () => {
    const onOpenChange = vi.fn();
    const { result } = renderHook(() => useDeleteConfirmation({ onOpenChange }));
    act(() => result.current.request(pending));
    act(() => result.current.request(null));
    expect(result.current.pending).toBeNull();
    expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
  });
});

describe('the list row confirmation', () => {
  it('closes the open row menu, and falls back to the row\'s first control once the trigger is gone', async () => {
    const { getByTestId } = render(<Buttons />);
    const trigger = getByTestId('trigger');
    const { result } = renderHook(() => useRowMenuState());
    act(() => result.current.openRowMenu('row-1'));
    act(() => result.current.handleRowActionStart({}, trigger, { action: 'deleteServer' }));
    act(() => result.current.requestRowDelete(pending.executor, pending.copy, { confirmOptional: true }));
    expect(result.current.activeMenuRowId).toBeNull();
    expect(result.current.deleteConfirmation.modalProps.pending).toEqual({ executor: pending.executor, copy: pending.copy, confirmOptional: true });
    trigger.remove();
    act(() => result.current.deleteConfirmation.modalProps.onClose());
    await nextFrame();
    expect(document.activeElement).toBe(getByTestId('first'));
    expect(confirmationReturnTarget(null)).toBeNull();
  });
});
