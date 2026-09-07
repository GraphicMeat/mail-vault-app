// The ground a list row paints, in both highlighting modes. One row asks for
// exactly one ground utility — they are equal-specificity, so a row that asked
// for two would be painted by whichever the stylesheet declared last.
import { describe, it, expect } from 'vitest';
import { listRowGround } from '../listRowGround';

const tokens = (s) => s.split(' ').filter(Boolean);

describe('listRowGround — hover mode (the default, today’s behaviour)', () => {
  const hover = (o) => listRowGround({ highlight: 'hover', ...o });

  it('the open row keeps the accent tint, the left border and its padding', () => {
    expect(tokens(hover({ selected: true }))).toEqual(
      ['bg-mail-accent-tint', 'border-l-2', 'border-l-mail-accent', 'pl-[14px]']
    );
  });

  it('an unmarked row reacts to the pointer', () => {
    expect(tokens(hover({}))).toEqual(['hover:bg-mail-surface-hover']);
  });

  it('an unmarked unread row keeps its own surface and still hovers', () => {
    expect(tokens(hover({ unread: true }))).toEqual(
      ['bg-mail-surface', 'hover:bg-mail-surface-hover']
    );
  });

  it('a marked unread row does not also ask for the unread surface', () => {
    expect(tokens(hover({ selected: true, unread: true }))).not.toContain('bg-mail-surface');
  });

  it('a marked row does not also ask for the hover ground', () => {
    // Hover carries a pseudo-class, so it outranks the tint whatever the
    // source order — hovering the row you are in would hide its own mark.
    expect(tokens(hover({ selected: true }))).not.toContain('hover:bg-mail-surface-hover');
  });

  it('ignores `related` entirely — the mode has no sibling ground', () => {
    expect(hover({ related: true })).toBe(hover({}));
    expect(tokens(hover({ related: true }))).not.toContain('bg-mail-row-related');
  });

  it('takes the caller’s padding pair', () => {
    expect(tokens(hover({ selected: true, markedPad: 'pl-[46px]', restPad: 'pl-12' })))
      .toContain('pl-[46px]');
    expect(tokens(hover({ markedPad: 'pl-[46px]', restPad: 'pl-12' }))).toContain('pl-12');
  });
});

describe('listRowGround — selection mode (the reporter’s)', () => {
  const sel = (o) => listRowGround({ highlight: 'selection', ...o });

  it('fills the open row with the marking grey, no border and no padding shift', () => {
    expect(tokens(sel({ selected: true }))).toEqual(['bg-mail-row-selected']);
  });

  it('gives the rest of the open message’s thread the lighter grey', () => {
    expect(tokens(sel({ related: true }))).toEqual(['bg-mail-row-related']);
  });

  it('never lets the row react to the pointer', () => {
    for (const o of [{}, { unread: true }, { selected: true }, { related: true }]) {
      expect(tokens(sel(o))).not.toContain('hover:bg-mail-surface-hover');
    }
  });

  it('a marked unread row does not also ask for the unread surface', () => {
    expect(tokens(sel({ selected: true, unread: true }))).toEqual(['bg-mail-row-selected']);
    expect(tokens(sel({ related: true, unread: true }))).toEqual(['bg-mail-row-related']);
  });

  it('an unmarked unread row still keeps its own surface', () => {
    expect(tokens(sel({ unread: true }))).toEqual(['bg-mail-surface']);
  });

  it('an unmarked read row asks for no ground at all', () => {
    expect(sel({})).toBe('');
  });

  it('keeps the resting padding on both marked kinds', () => {
    expect(tokens(sel({ selected: true, markedPad: 'pl-[46px]', restPad: 'pl-12' })))
      .toEqual(['bg-mail-row-selected', 'pl-12']);
    expect(tokens(sel({ related: true, markedPad: 'pl-[46px]', restPad: 'pl-12' })))
      .toEqual(['bg-mail-row-related', 'pl-12']);
  });
});

describe('listRowGround — the string itself', () => {
  it('never emits a double space or a stray edge space', () => {
    for (const highlight of ['hover', 'selection']) {
      for (const selected of [false, true]) {
        for (const related of [false, true]) {
          for (const unread of [false, true]) {
            for (const restPad of ['', 'pl-12']) {
              const out = listRowGround({ highlight, selected, related, unread, restPad });
              expect(out).toBe(out.trim());
              expect(out).not.toMatch(/ {2}/);
            }
          }
        }
      }
    }
  });
});
