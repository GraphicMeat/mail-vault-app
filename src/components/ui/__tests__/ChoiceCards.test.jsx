// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ChoiceCards } from '../ChoiceCards';

afterEach(cleanup);

const OPTIONS = ['Inline', 'Menu', 'Radial'].map(label => ({
  value: label.toLowerCase(),
  label,
  // A picture with controls of its own, as a real sample row has.
  preview: <div data-testid={`picture-${label}`} aria-hidden="true"><button type="button">Archive</button></div>,
}));

describe('ChoiceCards', () => {
  it('is a radio group whose radios are named by their label alone, the picture beside each, never in it', () => {
    render(<ChoiceCards label="Layout" options={OPTIONS} value="menu" onChange={() => {}} />);
    const group = screen.getByRole('radiogroup', { name: 'Layout' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map(radio => radio.textContent.trim())).toEqual(['Inline', 'Menu', 'Radial']);
    for (const [index, radio] of radios.entries()) {
      expect(radio.tagName).toBe('BUTTON');
      expect(screen.getByRole('radio', { name: OPTIONS[index].label })).toBe(radio);
      expect(radio.querySelector('button')).toBeNull();
      expect(radio.contains(screen.getByTestId(`picture-${OPTIONS[index].label}`))).toBe(false);
      expect(radio.closest('.choice-card').contains(screen.getByTestId(`picture-${OPTIONS[index].label}`))).toBe(true);
    }
  });

  it('marks the chosen card and keeps it the one tab stop', () => {
    render(<ChoiceCards label="Layout" options={OPTIONS} value="menu" onChange={() => {}} />);
    const radios = screen.getAllByRole('radio');
    expect(radios.map(radio => radio.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(radios.map(radio => radio.closest('.choice-card').hasAttribute('data-selected'))).toEqual([false, true, false]);
    expect(radios.map(radio => radio.tabIndex)).toEqual([-1, 0, -1]);
  });

  it('moves the choice with the arrow keys, Home and End, and picks on click', () => {
    const onChange = vi.fn();
    render(<ChoiceCards label="Layout" options={OPTIONS} value="menu" onChange={onChange} />);
    const [inline, menu, radial] = screen.getAllByRole('radio');
    fireEvent.keyDown(menu, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('radial');
    expect(document.activeElement).toBe(radial);
    fireEvent.keyDown(menu, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('inline');
    fireEvent.keyDown(menu, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('radial');
    fireEvent.click(inline);
    expect(onChange).toHaveBeenLastCalledWith('inline');
  });

  it('with nothing chosen, still lets Tab reach the first card', () => {
    render(<ChoiceCards label="Layout" options={OPTIONS} value={null} onChange={() => {}} />);
    expect(screen.getAllByRole('radio').map(radio => radio.tabIndex)).toEqual([0, -1, -1]);
  });

  it('as pressed toggles: a group of buttons, none needed, arrows pick nothing', () => {
    const onChange = vi.fn();
    const { rerender } = render(<ChoiceCards pressed label="Action sets" options={OPTIONS} value={null} onChange={onChange} />);
    const group = screen.getByRole('group', { name: 'Action sets' });
    expect(within(group).queryAllByRole('radio')).toHaveLength(0);
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map(button => button.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false']);
    fireEvent.keyDown(buttons[0], { key: 'ArrowRight' });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(buttons[2]);
    expect(onChange).toHaveBeenCalledWith('radial');
    rerender(<ChoiceCards pressed label="Action sets" options={OPTIONS} value="radial" onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Radial' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Radial' }).closest('.choice-card').hasAttribute('data-selected')).toBe(true);
  });
});
