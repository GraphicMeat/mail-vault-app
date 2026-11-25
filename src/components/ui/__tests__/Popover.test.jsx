// @vitest-environment jsdom
// The real framer-motion runs here: the bug lives in its exit animation.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Popover } from '../Popover';

afterEach(cleanup);

// The backdrop is the full-window layer the portal puts straight under body.
const backdrop = () => document.querySelector('body > div.fixed.inset-0');
const panel = () => document.querySelector('[data-testid="pop"]');

describe('Popover', () => {
  it('closes on a click outside the panel', () => {
    const onClose = vi.fn();
    render(<Popover open onClose={onClose} data-testid="pop">menu</Popover>);
    fireEvent.click(backdrop());
    expect(onClose).toHaveBeenCalled();
  });

  // A click right after picking a row must reach the page: the closing
  // panel fades for a moment, but nothing of it may still catch clicks.
  it('stops catching clicks the moment it closes, while the panel still fades out', () => {
    const { rerender } = render(<Popover open onClose={() => {}} data-testid="pop">menu</Popover>);
    expect(backdrop()).not.toBeNull();
    rerender(<Popover open={false} onClose={() => {}} data-testid="pop">menu</Popover>);
    expect(backdrop()).toBeNull();
    if (panel()) expect(panel().style.pointerEvents).toBe('none');
  });

  it('takes clicks again when reopened mid-fade', () => {
    const { rerender } = render(<Popover open onClose={() => {}} data-testid="pop">menu</Popover>);
    rerender(<Popover open={false} onClose={() => {}} data-testid="pop">menu</Popover>);
    rerender(<Popover open onClose={() => {}} data-testid="pop">menu</Popover>);
    expect(backdrop()).not.toBeNull();
    expect(panel().style.pointerEvents).toBe('');
  });
});
