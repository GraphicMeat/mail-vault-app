// @vitest-environment jsdom
//
// To / Cc / Bcc as chips, the way the search box shows its terms: Enter (or a
// comma, a semicolon, a pasted list) turns the typed text into a chip with an
// x; a pasted `mailto:` link loses its scheme. The field's value stays the
// comma-joined string the rest of compose reads.

import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { useState, useEffect } from 'react';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});
// Stand-in for the contacts list. The real autocomplete listens for keydown on
// the input itself and claims Enter with preventDefault; this one does the
// same with one fixed suggestion, so a chip must not be added twice.
const seen = vi.hoisted(() => ({ exclude: null }));
vi.mock('../ContactsPicker', async () => {
  const React = await import('react');
  return {
    ContactsPickerButton: () => null,
    ContactsAutocomplete: ({ value, onChange, inputRef, exclude }) => {
      seen.exclude = exclude;
      React.useEffect(() => {
        const el = inputRef.current;
        const onKey = (e) => {
          if (e.key === 'Enter' && value.trim().toLowerCase().endsWith('sugg')) {
            e.preventDefault();
            onChange('suggested@example.com, ');
          }
        };
        el.addEventListener('keydown', onKey);
        return () => el.removeEventListener('keydown', onKey);
      }, [value, onChange, inputRef]);
      return null;
    },
  };
});

import { RecipientField } from '../RecipientField';
import { addRecipients, removeRecipientToken } from '../../utils/recipientTokens';

let latest = '';
function Harness({ initial = '' }) {
  const [value, setValue] = useState(initial);
  useEffect(() => { latest = value; }, [value]);
  return (
    <RecipientField
      name="to" label="To:" placeholder="name@example.com" testid="compose-to"
      value={value} setValue={setValue}
    />
  );
}

const input = () => screen.getByTestId('compose-to');
const chips = () => screen.queryAllByTestId('recipient-chip').map(c => c.textContent);
const type = (text) => fireEvent.change(input(), { target: { value: text } });
const paste = (text) => fireEvent.paste(input(), { clipboardData: { getData: () => text } });

afterEach(() => { cleanup(); latest = ''; });

describe('RecipientField chips', () => {
  it('shows a prefilled value as chips with an empty input', () => {
    render(<Harness initial="a@b.de, Ann <c@d.de>" />);
    expect(chips()).toEqual(['a@b.de', 'Ann']);
    expect(input().value).toBe('');
  });

  it('turns the typed address into a chip on Enter', () => {
    render(<Harness />);
    type('a@b.de');
    expect(chips()).toEqual([]);
    expect(latest).toBe('a@b.de'); // uncommitted text still reaches Send
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(chips()).toEqual(['a@b.de']);
    expect(input().value).toBe('');
    expect(latest).toBe('a@b.de, ');
  });

  it('commits on a typed comma or semicolon', () => {
    render(<Harness />);
    type('a@b.de,');
    expect(chips()).toEqual(['a@b.de']);
    type('c@d.de;');
    expect(chips()).toEqual(['a@b.de', 'c@d.de']);
  });

  it('commits a typed address when the user types a space after it', () => {
    render(<Harness />);
    type('a@b.de ');
    expect(chips()).toEqual(['a@b.de']);
  });

  it('commits the draft on blur', () => {
    render(<Harness />);
    type('a@b.de');
    fireEvent.blur(input());
    expect(chips()).toEqual(['a@b.de']);
    // Left the field: the value reads as a plain list, no trailing comma.
    expect(latest).toBe('a@b.de');
  });

  it('leaves Enter alone when there is nothing to commit', () => {
    render(<Harness />);
    const notPrevented = fireEvent.keyDown(input(), { key: 'Enter' });
    expect(notPrevented).toBe(true);
    expect(chips()).toEqual([]);
  });

  it('ignores the Enter that confirms an input-method candidate', () => {
    render(<Harness />);
    type('a@b.de');
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 229 });
    expect(chips()).toEqual([]);
  });

  it('adds one chip, not two, when the autocomplete claims Enter', () => {
    render(<Harness />);
    type('sugg');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(chips()).toEqual(['suggested@example.com']);
  });

  it('removes a chip with its x', () => {
    render(<Harness initial="a@b.de, c@d.de, " />);
    fireEvent.click(screen.getAllByTestId('recipient-chip-remove')[0]);
    expect(chips()).toEqual(['c@d.de']);
    expect(latest).toBe('c@d.de, ');
  });

  it('removes a chip of a prefilled value, keeping what is being typed', () => {
    render(<Harness initial="a@b.de, c@d.de, " />);
    type('x');
    fireEvent.click(screen.getAllByTestId('recipient-chip-remove')[0]);
    expect(chips()).toEqual(['c@d.de']);
    expect(input().value).toBe('x');
  });

  it('Backspace in an empty input selects the last chip, a second one removes it', () => {
    render(<Harness initial="a@b.de, c@d.de, " />);
    fireEvent.keyDown(input(), { key: 'Backspace' });
    const last = screen.getAllByTestId('recipient-chip-text')[1];
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'Backspace' });
    expect(chips()).toEqual(['a@b.de']);
  });
});

describe('RecipientField paste', () => {
  it('drops mailto: from a pasted link', () => {
    render(<Harness />);
    paste('mailto:impressum@amazon.de');
    expect(chips()).toEqual(['impressum@amazon.de']);
    expect(latest).toBe('impressum@amazon.de, ');
  });

  it('separates a pasted list into chips and a comma-joined value', () => {
    render(<Harness />);
    paste('a@b.de; "Doe, John" <j@d.com>\nmailto:e@f.de?subject=Hi\ng@h.de');
    expect(chips()).toEqual(['a@b.de', 'Doe, John', 'e@f.de', 'g@h.de']);
    expect(latest).toBe('a@b.de, "Doe, John" <j@d.com>, e@f.de, g@h.de, ');
  });

  it('adds to the chips already there and skips repeats', () => {
    render(<Harness initial="a@b.de, " />);
    paste('A@B.de, c@d.de');
    expect(chips()).toEqual(['a@b.de', 'c@d.de']);
  });

  it('lets an ordinary word paste into the draft', () => {
    render(<Harness />);
    const notPrevented = fireEvent.paste(input(), { clipboardData: { getData: () => 'john' } });
    expect(notPrevented).toBe(true);
    expect(chips()).toEqual([]);
  });

  it('cleans a mailto: typed in and committed with Enter', () => {
    render(<Harness />);
    type('mailto:a@b.de');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(chips()).toEqual(['a@b.de']);
  });
});

describe('RecipientField chips are checked', () => {
  it('flags a chip that is not an address', () => {
    render(<Harness initial="a@b.de, John Doe, " />);
    const [ok, bad] = screen.getAllByTestId('recipient-chip');
    expect(ok.dataset.invalid).toBeUndefined();
    expect(bad.dataset.invalid).toBe('true');
  });
});

// ── Trio: To / Cc / Bcc wired the way ComposeModal wires them ────────────────

let all = {};
function Trio({ initial = {} }) {
  const [v, setV] = useState({ to: '', cc: '', bcc: '', ...initial });
  useEffect(() => { all = v; }, [v]);
  const set = f => val => setV(p => ({ ...p, [f]: val }));
  const route = (f, text) => setV(p => ({ ...p, [f]: addRecipients(p[f], text) }));
  const move = (from, to, token) => setV(p => ({
    ...p, [from]: removeRecipientToken(p[from], token), [to]: addRecipients(p[to], token),
  }));
  return ['to', 'cc', 'bcc'].map(f => (
    <RecipientField key={f} name={f} label={`${f}:`} testid={`compose-${f}`}
      value={v[f]} setValue={set(f)} onRoute={route} onMove={move} />
  ));
}
const row = f => document.querySelector(`[data-recipient-field="${f}"]`);
const rowChips = f => within(row(f)).queryAllByTestId('recipient-chip').map(c => c.textContent);
const rowInput = f => within(row(f)).getByTestId(`compose-${f}`);

describe('mailto paste with cc and bcc', () => {
  it('sends ?cc= and ?bcc= to their own fields', () => {
    render(<Trio />);
    fireEvent.paste(rowInput('to'), { clipboardData: { getData: () => 'mailto:a@b.de?cc=c@d.de&bcc=e@f.de&subject=Hi' } });
    expect(rowChips('to')).toEqual(['a@b.de']);
    expect(rowChips('cc')).toEqual(['c@d.de']);
    expect(rowChips('bcc')).toEqual(['e@f.de']);
  });

  it('pasting into Cc keeps the To address and ?cc= in Cc', () => {
    render(<Trio />);
    fireEvent.paste(rowInput('cc'), { clipboardData: { getData: () => 'mailto:a@b.de?cc=c@d.de' } });
    expect(rowChips('cc')).toEqual(['a@b.de', 'c@d.de']);
    expect(rowChips('to')).toEqual([]);
  });
});

describe('chip display', () => {
  it('shows the name and keeps the address in the tooltip', () => {
    render(<Harness initial="Ann <ann@b.de>" />);
    const text = screen.getByTestId('recipient-chip-text');
    expect(text.textContent).toBe('Ann');
    expect(text.getAttribute('title')).toBe('ann@b.de');
  });
});

describe('editing a chip', () => {
  const edit = () => screen.getByTestId('recipient-chip-edit');

  it('opens the chip in an input on click, Enter replaces it', () => {
    render(<Harness initial="a@b.de, c@d.de, " />);
    fireEvent.click(screen.getAllByTestId('recipient-chip-text')[0]);
    expect(edit().value).toBe('a@b.de');
    fireEvent.change(edit(), { target: { value: 'x@y.de' } });
    fireEvent.keyDown(edit(), { key: 'Enter' });
    expect(chips()).toEqual(['x@y.de', 'c@d.de']);
    expect(latest).toBe('x@y.de, c@d.de, ');
  });

  it('edits the full address of a named chip', () => {
    render(<Harness initial="Ann <ann@b.de>, " />);
    fireEvent.click(screen.getByTestId('recipient-chip-text'));
    expect(edit().value).toBe('Ann <ann@b.de>');
  });

  it('commits on blur, cancels on Escape, removes on an empty edit', () => {
    render(<Harness initial="a@b.de, c@d.de, " />);
    fireEvent.click(screen.getAllByTestId('recipient-chip-text')[0]);
    fireEvent.change(edit(), { target: { value: 'x@y.de' } });
    fireEvent.blur(edit());
    expect(chips()).toEqual(['x@y.de', 'c@d.de']);

    fireEvent.click(screen.getAllByTestId('recipient-chip-text')[1]);
    fireEvent.change(edit(), { target: { value: 'zzz@y.de' } });
    fireEvent.keyDown(edit(), { key: 'Escape' });
    expect(chips()).toEqual(['x@y.de', 'c@d.de']);

    fireEvent.click(screen.getAllByTestId('recipient-chip-text')[0]);
    fireEvent.change(edit(), { target: { value: '' } });
    fireEvent.keyDown(edit(), { key: 'Enter' });
    expect(chips()).toEqual(['c@d.de']);
  });

  it('keeps the draft being typed', () => {
    render(<Harness initial="a@b.de, " />);
    type('dra');
    fireEvent.click(screen.getByTestId('recipient-chip-text'));
    fireEvent.change(edit(), { target: { value: 'x@y.de' } });
    fireEvent.keyDown(edit(), { key: 'Enter' });
    expect(chips()).toEqual(['x@y.de']);
    expect(input().value).toBe('dra');
  });
});

describe('dragging a chip to another field', () => {
  const drag = (chip, toRow, dx = 40) => {
    document.elementFromPoint = () => toRow;
    fireEvent.mouseDown(chip, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.mouseMove(document, { clientX: dx, clientY: 0 });
    fireEvent.mouseUp(document, { clientX: dx, clientY: 0 });
  };

  it('moves it, leaving the other chips', () => {
    render(<Trio initial={{ to: 'a@b.de, c@d.de, ' }} />);
    drag(within(row('to')).getAllByTestId('recipient-chip-text')[0], row('cc'));
    expect(rowChips('to')).toEqual(['c@d.de']);
    expect(rowChips('cc')).toEqual(['a@b.de']);
    expect(all.to).toBe('c@d.de, ');
  });

  it('does nothing when dropped on its own field or on nothing', () => {
    render(<Trio initial={{ to: 'a@b.de, ' }} />);
    drag(within(row('to')).getByTestId('recipient-chip-text'), row('to'));
    drag(within(row('to')).getByTestId('recipient-chip-text'), null);
    expect(rowChips('to')).toEqual(['a@b.de']);
  });

  it('a click that barely moves still edits the chip', () => {
    render(<Trio initial={{ to: 'a@b.de, ' }} />);
    const chip = within(row('to')).getByTestId('recipient-chip-text');
    document.elementFromPoint = () => row('cc');
    fireEvent.mouseDown(chip, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.mouseMove(document, { clientX: 2, clientY: 0 });
    fireEvent.mouseUp(document, { clientX: 2, clientY: 0 });
    fireEvent.click(chip);
    expect(screen.getByTestId('recipient-chip-edit')).toBeTruthy();
  });

  it('a drag does not open the editor afterwards', () => {
    render(<Trio initial={{ to: 'a@b.de, c@d.de, ' }} />);
    const chip = within(row('to')).getAllByTestId('recipient-chip-text')[0];
    drag(chip, row('to'));
    fireEvent.click(chip);
    expect(screen.queryByTestId('recipient-chip-edit')).toBeNull();
  });
});

describe('copying and cutting chips', () => {
  const clip = () => ({ setData: vi.fn() });

  it('copies the selected chips as a comma string, quoted names intact', () => {
    render(<Harness initial={'"Doe, John" <j@d.com>, c@d.de, e@f.de, '} />);
    const [one, two] = screen.getAllByTestId('recipient-chip-text');
    fireEvent.click(one, { shiftKey: true });
    fireEvent.click(two, { shiftKey: true });
    const clipboardData = clip();
    fireEvent.copy(one, { clipboardData });
    expect(clipboardData.setData).toHaveBeenCalledWith('text/plain', '"Doe, John" <j@d.com>, c@d.de');
    expect(chips()).toHaveLength(3);
  });

  it('copies the focused chip when none is selected', () => {
    render(<Harness initial="a@b.de, c@d.de, " />);
    const two = screen.getAllByTestId('recipient-chip-text')[1];
    two.focus();
    const clipboardData = clip();
    fireEvent.copy(two, { clipboardData });
    expect(clipboardData.setData).toHaveBeenCalledWith('text/plain', 'c@d.de');
  });

  it('Ctrl/Cmd+A in the empty input selects every chip; cut copies and removes them', () => {
    render(<Harness initial="a@b.de, c@d.de, " />);
    fireEvent.keyDown(input(), { key: 'a', metaKey: true });
    const clipboardData = clip();
    fireEvent.cut(screen.getAllByTestId('recipient-chip-text')[0], { clipboardData });
    expect(clipboardData.setData).toHaveBeenCalledWith('text/plain', 'a@b.de, c@d.de');
    expect(chips()).toEqual([]);
    expect(latest).toBe('');
  });

  it('Backspace on a selected chip removes the whole selection', () => {
    render(<Harness initial="a@b.de, c@d.de, e@f.de, " />);
    const [one, two] = screen.getAllByTestId('recipient-chip-text');
    fireEvent.click(one, { shiftKey: true });
    fireEvent.click(two, { shiftKey: true });
    fireEvent.keyDown(two, { key: 'Backspace' });
    expect(chips()).toEqual(['e@f.de']);
  });

  it('typing clears the selection', () => {
    render(<Harness initial="a@b.de, c@d.de, " />);
    fireEvent.click(screen.getAllByTestId('recipient-chip-text')[0], { shiftKey: true });
    type('x');
    const clipboardData = clip();
    fireEvent.copy(input(), { clipboardData });
    expect(clipboardData.setData).not.toHaveBeenCalled();
  });
});

describe('contacts list leaves out chips', () => {
  it('hands the autocomplete the addresses already in the field', () => {
    render(<Harness initial="a@b.de, Ann <c@d.de>, " />);
    expect(seen.exclude).toEqual(['a@b.de', 'Ann <c@d.de>']);
  });
});
