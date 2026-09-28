// @vitest-environment jsdom
//
// The right-click menu on a Notes to Self account chip. Each item says which
// accounts end up off; the board applies that to the accounts in its bar.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react';
import AccountChipMenu from '../AccountChipMenu';
import { t } from '../../../i18n/index.js';

const IDS = ['a', 'b', 'c'];

const draw = (menu, props = {}) => render(
  <AccountChipMenu menu={menu} onClose={() => {}} onApply={() => {}} {...props} />,
);
const items = () => [...document.querySelectorAll('[data-testid="notes-account-menu"] button')];
/// The accounts an item turns off, of the three in the bar.
const offAfter = (testId, onApply) => {
  fireEvent.click(document.querySelector(`[data-testid="${testId}"]`));
  const isOff = onApply.mock.calls.at(-1)[0];
  return IDS.filter(isOff);
};

afterEach(cleanup);

describe('AccountChipMenu', () => {
  it('draws nothing without a menu', () => {
    draw(null);
    expect(document.querySelector('[data-testid="notes-account-menu"]')).toBeNull();
  });

  it('opens where the pointer was, as a menu', () => {
    draw({ id: 'b', x: 40, y: 90 });
    const menu = document.querySelector('[data-testid="notes-account-menu"]');
    expect(menu.style.top).toBe('90px');
    expect(menu.style.left).toBe('40px');
    expect(menu.getAttribute('role')).toBe('menu');
  });

  it('offers select and deselect, for all and for all but this one', () => {
    draw({ id: 'b', x: 0, y: 0 });
    expect(items().map(b => b.textContent)).toEqual([
      t('notes.selectAllExcept'), t('notes.deselectAllExcept'), t('notes.selectAll'), t('notes.deselectAll'),
    ]);
  });

  it('turns every account on but this one, or off but this one', () => {
    const onApply = vi.fn();
    draw({ id: 'b', x: 0, y: 0 }, { onApply });
    expect(offAfter('notes-menu-select-all-except', onApply)).toEqual(['b']);
    expect(offAfter('notes-menu-deselect-all-except', onApply)).toEqual(['a', 'c']);
  });

  it('turns every account on, or every one off', () => {
    const onApply = vi.fn();
    draw({ id: 'b', x: 0, y: 0 }, { onApply });
    expect(offAfter('notes-menu-select-all', onApply)).toEqual([]);
    expect(offAfter('notes-menu-deselect-all', onApply)).toEqual(IDS);
  });

  it('closes itself on a choice', () => {
    const onClose = vi.fn();
    draw({ id: 'b', x: 0, y: 0 }, { onClose });
    fireEvent.click(document.querySelector('[data-testid="notes-menu-select-all"]'));
    expect(onClose).toHaveBeenCalled();
  });
});
