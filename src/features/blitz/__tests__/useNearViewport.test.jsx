// @vitest-environment jsdom
import React, { useRef } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { useNearViewport } from '../surfaces/useNearViewport';

let fire;
let opts;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); fire = undefined; opts = undefined; });

function Probe({ enabled }) {
  const ref = useRef(null);
  const near = useNearViewport(ref, { enabled });
  return <div ref={ref} data-testid="probe" data-near={String(near)} />;
}
const stubIO = () => vi.stubGlobal('IntersectionObserver', class { constructor(cb, o) { fire = cb; opts = o; } observe() {} disconnect() {} });

describe('useNearViewport', () => {
  it('is false until the element comes within a screen, then stays true', () => {
    stubIO();
    const { container } = render(<Probe enabled />);
    expect(container.firstChild.dataset.near).toBe('false');
    act(() => fire([{ isIntersecting: false }]));
    expect(container.firstChild.dataset.near).toBe('false');
    act(() => fire([{ isIntersecting: true }]));
    expect(container.firstChild.dataset.near).toBe('true');
  });
  it('disabled means near at once', () => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
    const { container } = render(<Probe enabled={false} />);
    expect(container.firstChild.dataset.near).toBe('true');
  });
  it('no IntersectionObserver means near at once', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { container } = render(<Probe enabled />);
    expect(container.firstChild.dataset.near).toBe('true');
  });

  describe('observer root (F17)', () => {
    it('is the nearest .overflow-y-auto ancestor, with the same margin', () => {
      stubIO();
      const { container } = render(<div className="overflow-y-auto" data-testid="scroller"><div><Probe enabled /></div></div>);
      expect(opts.root).toBe(container.querySelector('[data-testid="scroller"]'));
      expect(opts.rootMargin).toBe('100% 0px');
    });
    it('is a [data-blitz-scroll-root] ancestor too', () => {
      stubIO();
      const { container } = render(<div data-blitz-scroll-root="" data-testid="scroller"><Probe enabled /></div>);
      expect(opts.root).toBe(container.querySelector('[data-testid="scroller"]'));
    });
    it('is the nearest of several scrollers', () => {
      stubIO();
      const { container } = render(<div className="overflow-y-auto"><div className="overflow-y-auto" data-testid="inner"><Probe enabled /></div></div>);
      expect(opts.root).toBe(container.querySelector('[data-testid="inner"]'));
    });
    it('is null (the viewport) with no scroller above', () => {
      stubIO();
      render(<Probe enabled />);
      expect(opts.root).toBeNull();
      expect(opts.rootMargin).toBe('100% 0px');
    });
  });
});
