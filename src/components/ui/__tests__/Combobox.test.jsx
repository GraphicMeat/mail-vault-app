// @vitest-environment jsdom
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { zoneOptions } from '../../../utils/scheduledTime';

// One stable component: a Proxy minting a new one per access would remount
// the panel on every render and leave a test holding a detached input.
vi.mock('framer-motion', () => {
  const div = React.forwardRef(({ children, initial, animate, exit, ...props }, ref) =>
    React.createElement('div', { ...props, ref }, children));
  return { motion: { div }, AnimatePresence: ({ children }) => children };
});

const { Combobox } = await import('../Combobox');

afterEach(cleanup);

// Mid-July: Berlin and Paris are +02:00, Vilnius +03:00, Auckland +12:00.
const JULY = Date.UTC(2026, 6, 15, 12);
const OPTIONS = zoneOptions(
  ['Europe/Berlin', 'Europe/Paris', 'Europe/Vilnius', 'America/New_York', 'Asia/Kolkata', 'Pacific/Auckland'], JULY);

function Harness({ initial = 'Europe/Vilnius', onChange = () => {} }) {
  const [value, setValue] = useState(initial);
  return (
    <Combobox value={value} options={OPTIONS} ariaLabel="Zone" testId="tz" placeholder="Search"
      onChange={(v) => { setValue(v); onChange(v); }} />
  );
}

const shownValues = () => screen.queryAllByRole('option').map(o => o.dataset.testid.replace('tz-option-', ''));

describe('Combobox', () => {
  it('shows the picked option\'s label while closed, with the value on data-value', () => {
    render(<Harness />);
    const trigger = screen.getByTestId('tz');
    expect(trigger.textContent).toBe('(UTC+03:00) Vilnius');
    expect(trigger.dataset.value).toBe('Europe/Vilnius');
  });

  it('shows an option\'s detail under it in the list only, and on the closed field\'s hover', () => {
    render(<Harness />);
    const trigger = screen.getByTestId('tz');
    expect(trigger.title).toBe('Europe/Vilnius');
    fireEvent.click(trigger);
    expect(screen.getByTestId('tz-option-America/New_York').textContent).toBe('(UTC-04:00) New YorkAmerica/New York');
    expect(trigger.textContent).toBe('(UTC+03:00) Vilnius');
  });

  it('still shows a value that is not among the options', () => {
    render(<Harness initial="Mars/Olympus_Mons" />);
    expect(screen.getByTestId('tz').textContent).toBe('Mars/Olympus_Mons');
  });

  it('opens on a click with the search focused and the whole list', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('tz'));
    expect(document.activeElement).toBe(screen.getByTestId('tz-search'));
    expect(shownValues()).toHaveLength(OPTIONS.length);
    expect(screen.getByTestId('tz').getAttribute('aria-expanded')).toBe('true');
  });

  it('"+2" finds the zones at +02:00, not +03:00 or +12:00', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('tz'));
    fireEvent.change(screen.getByTestId('tz-search'), { target: { value: '+2' } });
    expect(shownValues()).toEqual(['Europe/Berlin', 'Europe/Paris']);
  });

  it('matches a city with a space, case-insensitively', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('tz'));
    fireEvent.change(screen.getByTestId('tz-search'), { target: { value: 'NEW YORK' } });
    expect(shownValues()).toEqual(['America/New_York']);
  });

  it('says so when nothing matches', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('tz'));
    fireEvent.change(screen.getByTestId('tz-search'), { target: { value: 'atlantis' } });
    expect(shownValues()).toEqual([]);
    expect(screen.getByText('No matches')).toBeTruthy();
  });

  it('ArrowDown moves the active option and Enter picks it, closing and refocusing the field', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByTestId('tz'));
    const search = screen.getByTestId('tz-search');
    fireEvent.change(search, { target: { value: 'europe' } });
    expect(shownValues()).toEqual(['Europe/Berlin', 'Europe/Paris', 'Europe/Vilnius']);
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    const paris = screen.getByTestId('tz-option-Europe/Paris');
    expect(search.getAttribute('aria-activedescendant')).toBe(paris.id);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('Europe/Paris');
    expect(screen.queryByTestId('tz-search')).toBeNull();
    expect(screen.getByTestId('tz').dataset.value).toBe('Europe/Paris');
    expect(document.activeElement).toBe(screen.getByTestId('tz'));
  });

  it('a click on an option picks it', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByTestId('tz'));
    fireEvent.click(screen.getByTestId('tz-option-Asia/Kolkata'));
    expect(onChange).toHaveBeenCalledWith('Asia/Kolkata');
  });

  it('typing on the closed field opens it with that letter as the search', () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getByTestId('tz'), { key: 'k' });
    expect(screen.getByTestId('tz-search').value).toBe('k');
    expect(shownValues()).toContain('Asia/Kolkata');
  });

  it('Escape closes without picking and gives focus back to the field', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByTestId('tz'));
    fireEvent.keyDown(screen.getByTestId('tz-search'), { key: 'Escape' });
    expect(screen.queryByTestId('tz-search')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByTestId('tz'));
  });

  it('keeps keys typed into the search from reaching a host form', () => {
    const onHostKey = vi.fn();
    render(<div onKeyDown={onHostKey}><Harness /></div>);
    fireEvent.click(screen.getByTestId('tz'));
    fireEvent.keyDown(screen.getByTestId('tz-search'), { key: 'Enter' });
    expect(onHostKey).not.toHaveBeenCalled();
  });
});
