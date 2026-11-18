// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TypeaheadChips } from '../TypeaheadChips';

afterEach(cleanup);

const props = { id: 'tags', label: 'Tags', value: '', onChange: () => {}, options: [], onPick: () => {} };

it('adds the host input class', () => {
  render(<TypeaheadChips {...props} inputClassName="host-input" />);
  expect(screen.getByRole('combobox').classList.contains('host-input')).toBe(true);
});

it('leaves the input class unset by default', () => {
  render(<TypeaheadChips {...props} />);
  expect(screen.getByRole('combobox').hasAttribute('class')).toBe(false);
});

it('closes the list when a chip is removed and reopens it on an input click', () => {
  render(<TypeaheadChips {...props} options={[{ value: 'x', label: 'X' }]} chips={[{ key: 'c', label: 'C' }]} onRemove={() => {}} />);
  const input = screen.getByRole('combobox');
  fireEvent.focus(input);
  expect(screen.getByRole('listbox')).toBeTruthy();
  const remove = screen.getByRole('button', { name: 'Remove C' });
  fireEvent.mouseDown(remove);
  fireEvent.click(remove);
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.click(input);
  expect(screen.getByRole('listbox')).toBeTruthy();
});
