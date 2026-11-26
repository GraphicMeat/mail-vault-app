// @vitest-environment jsdom
// A swipe action is in the DOM only while its side is being dragged open, is open, or is still
// sliding closed. Resting rows carry none: under a fast scroll WKWebView painted the coloured
// fills of every resting row at the list's edge.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, cleanup, fireEvent } from '@testing-library/react';
import SwipeRow from '../SwipeRow.jsx';
import { dragRow } from './fixtures/swipe.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.matchMedia;
});

const LEADING = { label: 'Read', className: 'mv-swipe__act--read' };
const TRAILING = { label: 'Delete', className: 'mv-swipe__act--delete' };

function renderSwipe(props = {}) {
  const onAction = vi.fn();
  const r = render(
    <SwipeRow leading={LEADING} trailing={TRAILING} onAction={onAction} {...props}>
      <button type="button" className="mv-row">row</button>
    </SwipeRow>,
  );
  const row = r.container.querySelector('.mv-row');
  const acts = () => [...r.container.querySelectorAll('[data-mv-swipe-action]')].map((b) => b.dataset.mvSwipeAction);
  return { ...r, row, acts, onAction, swipe: r.container.querySelector('.mv-swipe') };
}

describe('SwipeRow renders an action only for the side being revealed', () => {
  it('at rest neither action is in the DOM, and the row is no layer of its own', () => {
    const { acts, swipe } = renderSwipe();
    expect(acts()).toEqual([]);
    expect(swipe.hasAttribute('data-side')).toBe(false);
  });

  it('initialOpen renders only that side, reachable', () => {
    const { acts, container, swipe } = renderSwipe({ initialOpen: 'leading' });
    expect(acts()).toEqual(['leading']);
    expect(container.querySelector('[data-mv-swipe-action="leading"]').getAttribute('aria-hidden')).toBeNull();
    expect(swipe.getAttribute('data-side')).toBe('leading');
    cleanup();
    expect(renderSwipe({ initialOpen: 'trailing' }).acts()).toEqual(['trailing']);
  });

  it('a horizontal drag past the slop renders the side being dragged open', () => {
    let r = renderSwipe();
    dragRow(r.row, 30, { release: false });
    expect(r.acts()).toEqual(['leading']);
    expect(r.swipe.getAttribute('data-side')).toBe('leading');
    cleanup();
    r = renderSwipe();
    dragRow(r.row, -30, { release: false });
    expect(r.acts()).toEqual(['trailing']);
  });

  it('a drag that comes back to rest drops the action at once (nothing slides)', () => {
    const { row, acts } = renderSwipe();
    dragRow(row, 30, { release: false });
    expect(acts()).toEqual(['leading']);
    fireEvent.pointerMove(row, { pointerId: 1, clientX: 20, clientY: 22, isPrimary: true });
    expect(acts()).toEqual([]);
  });

  it('a row settling closed keeps its action until the slide ends', () => {
    const { row, acts, swipe } = renderSwipe();
    dragRow(row, 60);
    expect(acts()).toEqual(['leading']);
    expect(row.style.transform).toContain('88px');
    // Drag it most of the way back and let go: it slides closed.
    dragRow(row, -60);
    expect(row.style.transform).toBe('');
    expect(acts()).toEqual(['leading']);
    fireEvent.transitionEnd(row);
    expect(acts()).toEqual([]);
    expect(swipe.hasAttribute('data-side')).toBe(false);
  });

  it('a tap that closes an open row also waits for the slide', () => {
    const { row, acts } = renderSwipe({ initialOpen: 'trailing' });
    fireEvent.click(row);
    expect(acts()).toEqual(['trailing']);
    fireEvent.transitionEnd(row);
    expect(acts()).toEqual([]);
  });

  it('under reduced motion a closing row drops its action at once', () => {
    window.matchMedia = vi.fn((q) => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} }));
    const { row, acts } = renderSwipe();
    dragRow(row, 60);
    expect(acts()).toEqual(['leading']);
    dragRow(row, -60);
    expect(acts()).toEqual([]);
  });

  it('a full swipe still runs the action, and the action leaves with the slide', () => {
    const { row, acts, onAction } = renderSwipe();
    dragRow(row, 300);
    expect(onAction).toHaveBeenCalledWith('leading');
    fireEvent.transitionEnd(row);
    expect(acts()).toEqual([]);
    dragRow(row, -300);
    expect(onAction).toHaveBeenLastCalledWith('trailing');
  });

  it('an open action still acts when tapped', () => {
    const { container, onAction } = renderSwipe({ initialOpen: 'trailing' });
    fireEvent.click(container.querySelector('[data-mv-swipe-action="trailing"]'));
    expect(onAction).toHaveBeenCalledWith('trailing');
  });

  it('right to left: a drag to the physical right reveals the trailing side', () => {
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({ direction: 'rtl', getPropertyValue: () => '' }));
    const { row, acts } = renderSwipe();
    dragRow(row, 60);
    expect(acts()).toEqual(['trailing']);
    expect(row.style.transform).toContain('88px');
    dragRow(row, -60);
    fireEvent.transitionEnd(row);
    dragRow(row, -60);
    expect(acts()).toEqual(['leading']);
  });

  it('a side set to none never renders', () => {
    const { row, acts } = renderSwipe({ trailing: null });
    dragRow(row, -60, { release: false });
    expect(acts()).toEqual([]);
  });

  it('the row is its own layer only while a side is revealed', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/mobile/mobile.css'), 'utf8');
    const rowRule = css.match(/\n\.mv-row \{[^}]*\}/)[0];
    expect(rowRule).not.toMatch(/will-change/);
    expect(css).toMatch(/\.mv-swipe\[data-side\] \.mv-row \{[^}]*will-change: transform/);
  });
});
