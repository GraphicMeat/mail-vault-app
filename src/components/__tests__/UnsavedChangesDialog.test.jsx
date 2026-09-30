// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { UnsavedChangesDialog } from '../UnsavedChangesDialog';
import { useUnsavedStore } from '../../stores/unsavedStore';

const ADDRESS = 'Jasinskio && 14A-37 || mindaugo g. 30 || Vaivorykštės g. 63';

const hold = changes => {
  useUnsavedStore.setState({
    guard: { changes, save: vi.fn(async () => true), discard: vi.fn(async () => {}) },
    pending: vi.fn(),
    busy: false,
  });
};
const list = () => within(screen.getByTestId('unsaved-list'));

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
  useUnsavedStore.setState({ guard: null, pending: null, busy: false });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('UnsavedChangesDialog', () => {
  it('shows an added word as inserted text, even at the end of a long phrase', () => {
    hold([{ key: 'query', label: 'Contains', before: ADDRESS, after: `${ADDRESS}, asd` }]);
    render(<UnsavedChangesDialog />);
    const inserted = screen.getByTestId('unsaved-list').querySelectorAll('ins');
    expect([...inserted].map(n => n.textContent)).toEqual([', asd']);
    expect(screen.getByTestId('unsaved-list').querySelectorAll('del')).toHaveLength(0);
    expect(list().getByText(/Contains/)).toBeTruthy();
    expect(screen.getByTestId('unsaved-list').textContent).toContain('Vaivorykštės g. 63');
  });

  it('shows a removed word as deleted text', () => {
    hold([{ key: 'query', label: 'Contains', before: `${ADDRESS}, asd`, after: ADDRESS }]);
    render(<UnsavedChangesDialog />);
    const list = screen.getByTestId('unsaved-list');
    expect([...list.querySelectorAll('del')].map(n => n.textContent)).toEqual([', asd']);
    expect(list.querySelectorAll('ins')).toHaveLength(0);
  });

  it('keeps plain labels for parts with no text, and tells a clipped phrase with an ellipsis', () => {
    const before = `${'lots of shared words '.repeat(12)}end`;
    hold([{ key: 'name', label: 'Name', before, after: `${before} more` }, 'Starred']);
    render(<UnsavedChangesDialog />);
    const items = screen.getByTestId('unsaved-list').querySelectorAll('li');
    expect(items[1].textContent).toBe('Starred');
    expect(items[0].textContent.startsWith('Name')).toBe(true);
    expect(items[0].textContent).toContain('…');
    expect(items[0].querySelector('ins').textContent).toBe(' more');
  });
});
