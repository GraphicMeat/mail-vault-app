// @vitest-environment jsdom
// The question after a picture in a signature is resized: scale the file to 3x
// its display size? Both file sizes and the picture as it will look.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, { get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))), has: () => true });
});
vi.mock('framer-motion', () => ({
  motion: new Proxy({}, { get: () => React.forwardRef(({ children, initial, animate, exit, ...props }, ref) => React.createElement('div', { ...props, ref }, children)) }),
  AnimatePresence: ({ children }) => children,
}));

const { ImageScaleDialog } = await import('../ImageScaleDialog');

const OFFER = {
  src: 'data:image/png;base64,AAAA',
  display: { width: 40, height: 40 },
  natural: { width: 1200, height: 1200, bytes: 450 * 1024 },
  target: { width: 120, height: 120, bytes: 20 * 1024, src: 'data:image/png;base64,BBBB' },
};

afterEach(cleanup);

describe('ImageScaleDialog', () => {
  it('asks nothing while there is no offer', () => {
    render(<ImageScaleDialog offer={null} onScale={() => {}} onKeep={() => {}} />);
    expect(screen.queryByTestId('image-scale')).toBeNull();
  });

  it('names the 3x file, both file sizes and shows the scaled picture at its display size', () => {
    render(<ImageScaleDialog offer={OFFER} onScale={() => {}} onKeep={() => {}} />);
    const dialog = screen.getByTestId('image-scale');
    expect(dialog.textContent).toContain('40 × 40');
    expect(screen.getByTestId('image-scale-apply').textContent).toBe('Scale to 120 × 120');
    const sizes = within(dialog).getByTestId('image-scale-sizes').textContent;
    expect(sizes).toContain('1200 × 1200');
    expect(sizes).toContain('450 KB');
    expect(sizes).toContain('120 × 120');
    expect(sizes).toContain('20 KB');
    const preview = screen.getByTestId('image-scale-preview');
    expect(preview.getAttribute('src')).toBe(OFFER.target.src);
    expect(preview.getAttribute('width')).toBe('40');
    expect(preview.getAttribute('height')).toBe('40');
  });

  it('scales on the primary button and keeps the original on the other', () => {
    const onScale = vi.fn();
    const onKeep = vi.fn();
    render(<ImageScaleDialog offer={OFFER} onScale={onScale} onKeep={onKeep} />);
    fireEvent.click(screen.getByTestId('image-scale-apply'));
    expect(onScale).toHaveBeenCalledOnce();
    expect(onKeep).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('image-scale-keep'));
    expect(onKeep).toHaveBeenCalledOnce();
  });
});
