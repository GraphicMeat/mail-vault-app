// @vitest-environment jsdom
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { pickEmail, emailRows } from '../../../test/pickEmail';

vi.mock('framer-motion', () => {
  const div = React.forwardRef(({ children, initial, animate, exit, ...props }, ref) =>
    React.createElement('div', { ...props, ref }, children));
  return { motion: { div }, AnimatePresence: ({ children }) => children };
});

const { EmailSelector } = await import('../EmailSelector');
const { accountSections } = await import('../emailSelectorModel');

afterEach(cleanup);

const ALEX = { id: 'a', email: 'alex@example.test', name: 'Alex Morgan' };
const STUDIO = { id: 's', email: 'hello@studio.test', name: '' };
const SHOP = { id: 'p', email: 'shop@outlook.test', name: '' };
const SECTIONS = accountSections([ALEX, STUDIO, SHOP], {
  accountGroups: { s: 'Work', p: 'Side projects' },
  displayNames: { s: 'Studio' },
  accountColors: { a: '#7F77DD' },
  aliasesOf: a => (a.id === 's' ? [{ value: 's2', address: 'press@studio.test', name: 'Press desk' }] : []),
  lockedOf: a => a.id === 'p',
});

function Harness({ initial = 'a', onChange = () => {}, ...props }) {
  const [value, setValue] = useState(initial);
  return <EmailSelector value={value} sections={SECTIONS} ariaLabel="From" testId="from"
    onChange={v => { setValue(v); onChange(v); }} {...props} />;
}

const list = () => document.querySelector('[data-email-selector-list="from"]');

describe('EmailSelector', () => {
  it('shows the picked account closed: avatar in its colour, name over full address, value on data-value', () => {
    render(<Harness />);
    const trigger = screen.getByTestId('from');
    expect(trigger.getAttribute('role')).toBe('combobox');
    expect(trigger.dataset.value).toBe('a');
    expect(trigger.textContent).toContain('Alex Morgan');
    expect(trigger.textContent).toContain('alex@example.test');
    const avatar = trigger.querySelector('[data-email-avatar]');
    expect(avatar.textContent).toBe('AM');
    expect(avatar.style.backgroundColor).toBe('rgb(127, 119, 221)');
  });

  it('shows an alias closed under its own name and address', () => {
    render(<Harness initial="s2" />);
    const trigger = screen.getByTestId('from');
    expect(trigger.textContent).toContain('Press desk');
    expect(trigger.textContent).toContain('press@studio.test');
  });

  it('opens on click into groups, accounts and indented aliases, each with its full address', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('from'));
    expect(screen.getByTestId('from').getAttribute('aria-expanded')).toBe('true');
    const groups = [...list().querySelectorAll('[data-email-group]')].map(n => n.textContent.trim());
    expect(groups).toEqual(['Work', 'Side projects']);
    expect(emailRows('from').map(r => r.value)).toEqual(['a', 's', 's2', 'p']);
    const alias = list().querySelector('[data-value="s2"]');
    expect(alias.dataset.kind).toBe('alias');
    expect(alias.textContent).toContain('press@studio.test');
    expect(list().querySelector('[data-value="a"]').getAttribute('aria-selected')).toBe('true');
  });

  it('picks a row on click and closes', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    pickEmail('from', 's2');
    expect(onChange).toHaveBeenCalledWith('s2');
    expect(screen.getByTestId('from').dataset.value).toBe('s2');
    expect(list()).toBeNull();
  });

  it('filters by typing in the search box: address, name or group', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('from'));
    const search = screen.getByTestId('from-search');
    fireEvent.change(search, { target: { value: 'outlook' } });
    expect(emailRows('from').map(r => r.value)).toEqual(['p']);
    fireEvent.change(search, { target: { value: 'work' } });
    expect(emailRows('from').map(r => r.value)).toEqual(['s', 's2']);
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(emailRows('from')).toEqual([]);
    expect(list().textContent).toContain('No matches');
  });

  it('walks rows with the arrow keys, skipping group headers, and picks with Enter', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByTestId('from'));
    const search = screen.getByTestId('from-search');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('s2');
  });

  it('starts the search with a letter typed on the closed trigger', () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getByTestId('from'), { key: 's' });
    expect(screen.getByTestId('from-search').value).toBe('s');
  });

  it('marks a locked row but still lets it be picked', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} lockedLabel="Premium" />);
    fireEvent.click(screen.getByTestId('from'));
    const row = list().querySelector('[data-value="p"]');
    expect(row.dataset.locked).toBe('true');
    expect(row.getAttribute('aria-label')).toContain('Premium');
    fireEvent.click(row);
    expect(onChange).toHaveBeenCalledWith('p');
  });

  it('offers leading rows such as All accounts, shown closed with their label', () => {
    render(<Harness initial="all" leading={[{ value: 'all', label: 'All accounts' }]} />);
    expect(screen.getByTestId('from').textContent).toContain('All accounts');
    expect(emailRows('from')[0]).toEqual({ value: 'all', text: 'All accounts' });
  });

  it('shows a placeholder closed when nothing is picked', () => {
    render(<Harness initial="" placeholder="Copy from" />);
    expect(screen.getByTestId('from').textContent).toContain('Copy from');
  });

  it('runs a footer action inside the panel and closes', () => {
    const onClick = vi.fn();
    render(<Harness footer={{ label: 'Add address', onClick, testId: 'add-address' }} />);
    fireEvent.click(screen.getByTestId('from'));
    fireEvent.click(within(document.body).getByTestId('add-address'));
    expect(onClick).toHaveBeenCalled();
    expect(list()).toBeNull();
  });

  it('does not open when disabled', () => {
    render(<Harness disabled />);
    fireEvent.click(screen.getByTestId('from'));
    expect(list()).toBeNull();
  });
});
