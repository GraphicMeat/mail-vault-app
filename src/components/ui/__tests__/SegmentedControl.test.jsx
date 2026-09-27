// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SegmentedControl } from '../SettingsForm';
import { SegmentedChoice } from '../SegmentedChoice';

afterEach(cleanup);

const options = [{ value: 'keep', label: 'Keep' }, { value: 'hide', label: 'Hide' }];

describe('SegmentedControl', () => {
  // Every settings choice group wears the tab row's look through one shared
  // class (index.css), rather than a look of its own.
  it('renders with the same tab-style class as SegmentedChoice', () => {
    render(<>
      <SegmentedControl label="Inbox" value="keep" options={options} onChange={() => {}} />
      <SegmentedChoice label="Layout" value="keep" options={options} onChange={() => {}} />
    </>);
    const control = screen.getByRole('group', { name: 'Inbox' });
    const choice = screen.getByRole('radiogroup', { name: 'Layout' });
    expect(control.classList.contains('segmented-choice')).toBe(true);
    expect(choice.classList.contains('segmented-choice')).toBe(true);
  });

  it('keeps its pressed-button semantics', () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="Inbox" value="keep" options={options} onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Keep' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Hide' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(onChange).toHaveBeenCalledWith('hide');
  });
});
