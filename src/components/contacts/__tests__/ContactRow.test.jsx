// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../../../i18n', () => ({ useT: () => (k) => k }));
vi.mock('lucide-react', () => new Proxy({}, {
  get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : () => null),
  has: () => true,
}));
import { ContactRow } from '../ContactRow';

afterEach(cleanup);

describe('ContactRow', () => {
  it('draws name, address and count and reports clicks', () => {
    const onClick = vi.fn();
    render(<ContactRow testId="r" name="Amy" address="amy@x.io" count={4} selected onClick={onClick} />);
    const row = screen.getByTestId('r');
    expect(row.textContent).toContain('Amy');
    expect(row.textContent).toContain('amy@x.io');
    expect(row.textContent).toContain('4');
    expect(row.getAttribute('aria-current')).toBe('true');
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalled();
  });

  it('falls back to the address as the name and omits an unknown count', () => {
    render(<ContactRow testId="r" address="bo@x.io" />);
    const row = screen.getByTestId('r');
    expect(row.querySelectorAll('.truncate')[0].textContent).toBe('bo@x.io');
    expect(row.querySelector('.tabular-nums')).toBeNull();
  });
});
