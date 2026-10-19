// @vitest-environment jsdom
//
// To / Cc / Bcc as chips, the way the search box shows its terms: Enter (or a
// comma, a semicolon, a pasted list) turns the typed text into a chip with an
// x; a pasted `mailto:` link loses its scheme. The field's value stays the
// comma-joined string the rest of compose reads.

import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { useState, useEffect } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

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
vi.mock('../ContactsPicker', async () => {
  const React = await import('react');
  return {
    ContactsPickerButton: () => null,
    ContactsAutocomplete: ({ value, onChange, inputRef }) => {
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
    expect(chips()).toEqual(['a@b.de', 'Ann <c@d.de>']);
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
    expect(latest).toBe('a@b.de, ');
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
    expect(chips()).toEqual(['a@b.de', '"Doe, John" <j@d.com>', 'e@f.de', 'g@h.de']);
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
