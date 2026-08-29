// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { T } from '../T.jsx';
import en from '../locales/en.json';

/**
 * The slot fixtures live here, not in the shipped catalog. They existed only to
 * exercise <T>, and shipping them meant every user carried them and eight
 * translators were asked to translate them. `t()` reads the catalog object by
 * reference, so seeding it here is enough.
 */
en['test.inline'] = 'Read the <0>privacy policy</0> first';
en['test.inlineVar'] = 'Hi {{name}}, see the <0>docs</0> now';

afterEach(cleanup);

describe('T', () => {
  it('renders slot 0 through the matching part', () => {
    render(<T k="test.inline" parts={[s => <a href="/p">{s}</a>]} />);
    const link = screen.getByRole('link', { name: 'privacy policy' });
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/p');
  });

  it('keeps the text either side of the slot', () => {
    const { container } = render(<T k="test.inline" parts={[s => <a href="/p">{s}</a>]} />);
    expect(container.textContent).toBe('Read the privacy policy first');
  });

  it('interpolates vars alongside slots', () => {
    const { container } = render(
      <T k="test.inlineVar" vars={{ name: 'Rokas' }} parts={[s => <b>{s}</b>]} />
    );
    expect(container.textContent).toBe('Hi Rokas, see the docs now');
  });

  it('renders plain text unchanged when the string has no slots', () => {
    const { container } = render(<T k="sidebar.allInboxes" parts={[]} />);
    expect(container.textContent).toBe('All Inboxes');
  });
});
