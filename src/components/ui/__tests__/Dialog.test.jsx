// @vitest-environment jsdom
import React, { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Dialog } from '../Dialog';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Draft() {
  const [text, setText] = useState('');
  return <label>Draft note<input data-autofocus value={text} onChange={event => setText(event.target.value)} /></label>;
}

it('discards a normal dialog’s local draft when closed and starts a fresh form when reopened', () => {
  const { rerender } = render(<Dialog open aria-label="Editor"><Draft /></Dialog>);
  const input = screen.getByRole('textbox', { name: 'Draft note' });
  fireEvent.change(input, { target: { value: 'Unfinished note' } });
  rerender(<Dialog open={false} aria-label="Editor"><Draft /></Dialog>);
  expect(screen.queryByLabelText('Draft note')).toBeNull();
  rerender(<Dialog open aria-label="Editor"><Draft /></Dialog>);
  expect(screen.getByRole('textbox', { name: 'Draft note' })).not.toBe(input);
  expect(screen.getByRole('textbox', { name: 'Draft note' }).value).toBe('');
});

it('retains an inactive working dialog’s draft while excluding it from the accessible modal tree', () => {
  const { rerender } = render(<Dialog open keepMounted aria-label="Editor"><Draft /></Dialog>);
  const dialog = screen.getByRole('dialog', { name: 'Editor' });
  const input = screen.getByRole('textbox', { name: 'Draft note' });
  fireEvent.change(input, { target: { value: 'Resume this note' } });
  rerender(<Dialog open={false} keepMounted aria-label="Editor"><Draft /></Dialog>);

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Draft note' })).toBeNull();
  expect(document.contains(input)).toBe(true);
  expect(input.closest('[inert]')).not.toBeNull();
  expect(input.closest('[aria-hidden="true"]')).not.toBeNull();

  rerender(<Dialog open keepMounted aria-label="Editor"><Draft /></Dialog>);
  expect(screen.getByRole('dialog', { name: 'Editor' })).toBe(dialog);
  expect(screen.getByRole('textbox', { name: 'Draft note' })).toBe(input);
  expect(input.value).toBe('Resume this note');
  expect(input.closest('[inert], [aria-hidden="true"]')).toBeNull();
});

it('restores focus and modal keyboard handling across repeated cycles and a nested confirmation', () => {
  // jsdom has no layout. The focus trap's visible-control filter needs the
  // layout presence that a browser supplies; inactive surfaces remain absent.
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function () {
    return this.closest('[inert]') ? null : document.body;
  });
  const onClose = vi.fn();
  function Editor({ open }) {
    const [confirmation, setConfirmation] = useState(false);
    return <>
      <button>Mail list</button>
      <Dialog open={open} keepMounted onClose={onClose} aria-label="Editor">
        <Draft />
        <button onClick={() => setConfirmation(true)}>Review changes</button>
        <button>Last editor action</button>
        <Dialog open={confirmation} onClose={() => setConfirmation(false)} aria-label="Confirmation">
          <button data-autofocus onClick={() => setConfirmation(false)}>Back to editing</button>
        </Dialog>
      </Dialog>
    </>;
  }
  const { rerender } = render(<Editor open={false} />);
  const mail = screen.getByRole('button', { name: 'Mail list' });
  act(() => mail.focus());

  for (let cycle = 0; cycle < 2; cycle += 1) {
    rerender(<Editor open />);
    const input = screen.getByRole('textbox', { name: 'Draft note' });
    expect(document.activeElement).toBe(input);
    const last = screen.getByRole('button', { name: 'Last editor action' });
    act(() => last.focus());
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(input);

    rerender(<Editor open={false} />);
    expect(document.activeElement).toBe(mail);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => mail.dispatchEvent(tab));
    expect(tab.defaultPrevented).toBe(false);
    fireEvent.keyDown(mail, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  }

  rerender(<Editor open />);
  const review = screen.getByRole('button', { name: 'Review changes' });
  act(() => review.focus());
  fireEvent.click(review);
  const confirmation = screen.getByRole('dialog', { name: 'Confirmation' });
  expect(document.activeElement).toBe(within(confirmation).getByRole('button', { name: 'Back to editing' }));
  fireEvent.keyDown(document.activeElement, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Confirmation' })).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(review);
  fireEvent.keyDown(review, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
});
