// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Mail } from 'lucide-react';
import { SwipeBackdrop } from '../SwipeBackdrop';

const glyph = Icon => render(<Icon />).container.querySelector('svg').innerHTML;

describe('SwipeBackdrop', () => {
  it('draws the toggle read swipe with the closed envelope, like "Mark as read"', () => {
    const { container } = render(<SwipeBackdrop side="left" action="toggleRead" height={40} />);
    expect(container.querySelector('svg').innerHTML).toBe(glyph(Mail));
  });
});
