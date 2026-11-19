// @vitest-environment jsdom
// The template being edited is the one saved, even when the list changes under the open form
// (a template above it removed): the edit is tracked by the template, not by its list index.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { useState } from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { TemplatesView } from '../TemplatesView';

afterEach(cleanup);

function Harness({ initial, onUpdate }) {
  const [list, setList] = useState(initial);
  return (
    <TemplatesView templates={list}
      onAdd={() => {}}
      onUpdate={(index, tpl, patch) => {
        onUpdate(index, tpl, patch);
        setList((l) => l.map((x, i) => (i === index ? { ...x, ...patch } : x)));
      }}
      onRemove={(index) => setList((l) => l.filter((_, i) => i !== index))} />
  );
}

const editButtons = () => screen.getAllByRole('button', { name: /^Edit template:/ });
const deleteButtons = () => screen.getAllByRole('button', { name: /^Delete template:/ });

async function editSecondThenRemoveFirst(initial) {
  const onUpdate = vi.fn();
  render(<Harness initial={initial} onUpdate={onUpdate} />);
  fireEvent.click(editButtons()[1]);
  fireEvent.click(deleteButtons()[0]);
  fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'B2' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update' })); });
  return onUpdate;
}

describe('TemplatesView edit', () => {
  it('saves onto the edited template by id after one above it is removed', async () => {
    const onUpdate = await editSecondThenRemoveFirst([
      { id: 'a', name: 'A', body: 'a' }, { id: 'b', name: 'B', body: 'b' },
    ]);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    const [index, tpl, patch] = onUpdate.mock.calls[0];
    expect(index).toBe(0);
    expect(tpl.id).toBe('b');
    expect(patch).toEqual({ name: 'B2', body: 'b' });
  });

  it('saves onto the edited template without an id after one above it is removed', async () => {
    const onUpdate = await editSecondThenRemoveFirst([{ name: 'A', body: 'a' }, { name: 'B', body: 'b' }]);
    const [index, tpl] = onUpdate.mock.calls[0];
    expect(index).toBe(0);
    expect(tpl.name).toBe('B');
  });

  it('saves nothing when the edited template itself was removed', async () => {
    const onUpdate = vi.fn();
    render(<Harness initial={[{ id: 'a', name: 'A', body: 'a' }, { id: 'b', name: 'B', body: 'b' }]} onUpdate={onUpdate} />);
    fireEvent.click(editButtons()[0]);
    fireEvent.click(deleteButtons()[0]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update' })); });
    expect(onUpdate).not.toHaveBeenCalled();
    // The form closed: Add template is offered again.
    expect(screen.getByRole('button', { name: 'Add Template' })).toBeTruthy();
  });
});
