// @vitest-environment jsdom
import React, { StrictMode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import BodyContextMenu from '../BodyContextMenu';
import { menuColorsFor } from '../menuColors';
import { getContextMenuColors } from '../../../../utils/emailIframeTemplate';

afterEach(cleanup);

const colors = menuColorsFor({ dark: false });

describe('BodyContextMenu', () => {
  it('light colours are exactly the iframe menu colours', () => {
    expect(colors).toEqual(getContextMenuColors());
  });

  it('same items, labels and order as the iframe menu; Copy Link only over a link', () => {
    const { rerender } = render(<BodyContextMenu at={{ x: 10, y: 20 }} link={null} colors={colors} onCopy={vi.fn()} onSelectAll={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getAllByTestId('blitz-ctx-item').map(i => i.textContent)).toEqual(['Copy', 'Select All']);
    rerender(<BodyContextMenu at={{ x: 10, y: 20 }} link={{ href: 'https://x.test/a' }} colors={colors} onCopy={vi.fn()} onSelectAll={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getAllByTestId('blitz-ctx-item').map(i => i.textContent)).toEqual(['Copy', 'Copy Link', 'Select All']);
  });

  it('Copy Link arriving late keeps the highlight on the same item', () => {
    const props = { at: { x: 0, y: 0 }, colors, onCopy: vi.fn(), onSelectAll: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(<BodyContextMenu {...props} link={null} />);
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'ArrowDown' }); // Select All
    rerender(<BodyContextMenu {...props} link={{ href: 'https://x.test/a' }} />);
    const items = screen.getAllByTestId('blitz-ctx-item');
    expect(items[2].textContent).toBe('Select All');
    expect(items[2].style.background).toContain('rgb(243, 244, 246)');
    expect(items[1].style.background).toBe('none');
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(props.onSelectAll).toHaveBeenCalledTimes(1);
  });

  it('inline styles match the iframe menu', () => {
    render(<BodyContextMenu at={{ x: 10, y: 20 }} link={null} colors={colors} onCopy={vi.fn()} onSelectAll={vi.fn()} onClose={vi.fn()} />);
    const menu = screen.getByTestId('blitz-context-menu');
    expect(menu.style.minWidth).toBe('180px');
    expect(menu.style.borderRadius).toBe('6px');
    expect(menu.style.fontSize).toBe('13px');
    expect(menu.style.background).toContain('rgb(255, 255, 255)');
    const item = screen.getAllByTestId('blitz-ctx-item')[0];
    expect(item.style.padding).toBe('6px 14px');
    fireEvent.mouseOver(item);
    expect(item.style.background).toContain('rgb(243, 244, 246)');
    fireEvent.mouseOut(item);
    expect(item.style.background).toBe('none');
  });

  it('a mousedown on the menu never collapses the body selection', () => {
    render(<BodyContextMenu at={{ x: 0, y: 0 }} link={null} colors={colors} onCopy={vi.fn()} onSelectAll={vi.fn()} onClose={vi.fn()} />);
    const menu = screen.getByTestId('blitz-context-menu');
    expect(fireEvent.mouseDown(screen.getAllByTestId('blitz-ctx-item')[0])).toBe(false); // default prevented
    expect(menu.style.userSelect).toBe('none');
  });

  it('actions run then close; Copy Link writes the href', async () => {
    const onCopy = vi.fn(); const onSelectAll = vi.fn(); const onClose = vi.fn();
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<BodyContextMenu at={{ x: 0, y: 0 }} link={{ href: 'https://x.test/a' }} colors={colors} onCopy={onCopy} onSelectAll={onSelectAll} onClose={onClose} />);
    const [copy, copyLink, all] = screen.getAllByTestId('blitz-ctx-item');
    fireEvent.click(copy); expect(onCopy).toHaveBeenCalled();
    fireEvent.click(copyLink); expect(writeText).toHaveBeenCalledWith('https://x.test/a');
    fireEvent.click(all); expect(onSelectAll).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  describe('dismissal and keys', () => {
    const open = (over = {}, onContextMenu) => {
      const onClose = vi.fn(); const onCopy = vi.fn(); const onSelectAll = vi.fn();
      render(
        <div data-testid="body" onContextMenu={onContextMenu}><BodyContextMenu at={{ x: 0, y: 0 }} link={null} colors={colors} onCopy={onCopy} onSelectAll={onSelectAll} onClose={onClose} {...over} /></div>,
      );
      return { onClose, onCopy, onSelectAll };
    };

    it('Escape closes the menu and goes no further (the body keeps its selection)', () => {
      const { onClose } = open();
      const atBody = vi.fn();
      screen.getByTestId('body').addEventListener('keydown', atBody);
      expect(fireEvent.keyDown(screen.getByTestId('blitz-context-menu'), { key: 'Escape' })).toBe(false);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(atBody).not.toHaveBeenCalled();
    });

    it('arrow keys move the highlight, Enter runs it and closes', () => {
      const { onClose, onSelectAll, onCopy } = open();
      const items = screen.getAllByTestId('blitz-ctx-item');
      fireEvent.keyDown(document, { key: 'ArrowDown' });
      expect(items[0].style.background).toContain('rgb(243, 244, 246)');
      fireEvent.keyDown(document, { key: 'ArrowDown' });
      expect(items[1].style.background).toContain('rgb(243, 244, 246)');
      expect(items[0].style.background).toBe('none');
      fireEvent.keyDown(document, { key: 'ArrowDown' }); // wraps
      expect(items[0].style.background).toContain('rgb(243, 244, 246)');
      fireEvent.keyDown(document, { key: 'ArrowUp' }); // wraps back
      fireEvent.keyDown(document, { key: 'Enter' });
      expect(onSelectAll).toHaveBeenCalledTimes(1);
      expect(onCopy).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes on a press outside the body, a scroll, a window blur and a window resize; not on a press inside the body or on the menu', () => {
      const { onClose } = open({ inBody: t => !!t.closest?.('[data-testid="body"]') });
      fireEvent.mouseDown(screen.getByTestId('blitz-context-menu'));
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.mouseDown(screen.getByTestId('body'));
      expect(onClose).not.toHaveBeenCalled(); // the next click inside is the body's to swallow
      fireEvent.mouseDown(document.body);
      expect(onClose).toHaveBeenCalledTimes(1);
      fireEvent.scroll(document.body);
      expect(onClose).toHaveBeenCalledTimes(2);
      fireEvent.blur(window);
      expect(onClose).toHaveBeenCalledTimes(3);
      fireEvent(window, new Event('resize')); // fixed at a point of the old window
      expect(onClose).toHaveBeenCalledTimes(4);
    });

    it('a second right-click moves the menu: the highlight starts over', () => {
      const props = { link: null, colors, onCopy: vi.fn(), onSelectAll: vi.fn(), onClose: vi.fn() };
      const { rerender } = render(<BodyContextMenu at={{ x: 0, y: 0 }} {...props} />);
      const items = screen.getAllByTestId('blitz-ctx-item');
      fireEvent.mouseOver(items[1]);
      expect(items[1].style.background).toContain('rgb(243, 244, 246)');
      rerender(<BodyContextMenu at={{ x: 30, y: 40 }} {...props} />);
      expect(items[1].style.background).toBe('none');
      fireEvent.keyDown(document, { key: 'Enter' }); // nothing highlighted: nothing runs
      expect(props.onSelectAll).not.toHaveBeenCalled();
    });

    it('a right-click on the menu itself is swallowed, not reopened elsewhere', () => {
      const atBody = vi.fn();
      open({}, atBody);
      expect(fireEvent.contextMenu(screen.getByTestId('blitz-context-menu'))).toBe(false);
      expect(atBody).not.toHaveBeenCalled();
    });

    it('leaves focus and the selection where they are (the body keeps both)', () => {
      const btn = document.createElement('button'); document.body.appendChild(btn); btn.focus();
      const p = document.createElement('p'); p.textContent = 'sel'; document.body.appendChild(p);
      const r = document.createRange(); r.selectNodeContents(p);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
      render(<BodyContextMenu at={{ x: 0, y: 0 }} link={null} colors={colors} onCopy={vi.fn()} onSelectAll={vi.fn()} onClose={vi.fn()} />);
      expect(document.activeElement).toBe(btn);
      expect(window.getSelection().toString()).toBe('sel');
      window.getSelection().removeAllRanges(); btn.remove(); p.remove();
    });

    it('leaves no document or window listener behind, StrictMode included', () => {
      const add = vi.spyOn(document, 'addEventListener'); const rem = vi.spyOn(document, 'removeEventListener');
      const wadd = vi.spyOn(window, 'addEventListener'); const wrem = vi.spyOn(window, 'removeEventListener');
      const { unmount } = render(<StrictMode><BodyContextMenu at={{ x: 0, y: 0 }} link={null} colors={colors} onCopy={vi.fn()} onSelectAll={vi.fn()} onClose={vi.fn()} /></StrictMode>);
      unmount();
      const bal = (a, r) => {
        const net = new Map();
        for (const [t, , c] of a.mock.calls) net.set(`${t}:${!!(c && (c === true || c.capture))}`, (net.get(`${t}:${!!(c && (c === true || c.capture))}`) ?? 0) + 1);
        for (const [t, , c] of r.mock.calls) net.set(`${t}:${!!(c && (c === true || c.capture))}`, (net.get(`${t}:${!!(c && (c === true || c.capture))}`) ?? 0) - 1);
        return [...net.values()].every(n => n === 0);
      };
      expect(bal(add, rem)).toBe(true);
      expect(bal(wadd, wrem)).toBe(true);
      vi.restoreAllMocks();
    });
  });
});
