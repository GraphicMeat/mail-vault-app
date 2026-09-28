// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TomSelectField } from '../TomSelectField';

afterEach(cleanup);

const options = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }];

describe('TomSelectField', () => {
  // Tom Select reports one selection twice: through its onChange setting and
  // through the change event it fires on the select underneath.
  it('reports one real selection exactly once', () => {
    const onChange = vi.fn();
    render(<TomSelectField label="Pick" value="a" options={options} placeholder="Choose" onChange={onChange} />);
    const select = document.querySelector('select[aria-label="Pick"]');
    act(() => { select.tomselect.setValue('b'); });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('reports a later change back to an earlier value', () => {
    const onChange = vi.fn();
    const { rerender } = render(<TomSelectField label="Pick" value="a" options={options} onChange={onChange} />);
    const select = document.querySelector('select[aria-label="Pick"]');
    act(() => { select.tomselect.setValue('b'); });
    rerender(<TomSelectField label="Pick" value="b" options={options} onChange={onChange} />);
    act(() => { select.tomselect.setValue('a'); });
    expect(onChange.mock.calls.map(([value]) => value)).toEqual(['b', 'a']);
  });

  // The component's own markup: once mounted, Tom Select rewrites the hidden
  // select itself (it appends its own option for the value it holds).
  it('renders one empty option when the options already hold one', () => {
    const withEmpty = [{ value: '', label: 'Automatic' }, ...options];
    const html = renderToStaticMarkup(<TomSelectField label="Pick" value="" options={withEmpty} placeholder="Choose" onChange={() => {}} />);
    expect(html.match(/<option value=""/g)).toHaveLength(1);
  });
});
