// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
