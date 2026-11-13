// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { Avatar } from '../AccountSwitcher.jsx';

afterEach(cleanup);

describe('Avatar', () => {
  it('wears the color the desktop gave the account', () => {
    const { container } = render(<Avatar account={{ email: 'ann@example.test', color: '#ec4899' }} />);
    expect(container.firstChild.style.backgroundColor).toBe('rgb(236, 72, 153)');
  });

  it('keeps the default look for an account without one', () => {
    const { container } = render(<Avatar account={{ email: 'ann@example.test', color: null }} small />);
    expect(container.firstChild.getAttribute('style')).toBeNull();
  });
});
