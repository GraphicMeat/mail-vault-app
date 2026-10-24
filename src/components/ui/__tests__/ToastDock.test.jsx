// @vitest-environment jsdom

// Banners never overlap: every bottom-pinned banner and toast lives in ONE
// stack, so two of them can never be painted at the same spot. jsdom has no
// layout, so the proof is structural: one host, one parent, and no component
// outside the dock pins itself with `fixed … bottom-…`.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('framer-motion', () => ({
  motion: new Proxy({}, {
    get: () => React.forwardRef(({ children, initial, animate, exit, transition, ...props }, ref) =>
      React.createElement('div', { ...props, ref }, children)),
  }),
  AnimatePresence: ({ children }) => children,
}));

import { ToastDockHost, DockSlot } from '../ToastDock';
import { ToastShell } from '../ToastShell';

afterEach(cleanup);

const stackOf = (testId) => screen.getByTestId(testId).closest('[data-toast-dock]');

describe('ToastDock', () => {
  it('stacks every bottom corner in the same host', () => {
    render(
      <>
        <ToastDockHost />
        <ToastShell position="bottom-left" data-testid="left">a</ToastShell>
        <ToastShell position="bottom-center" data-testid="center">b</ToastShell>
        <ToastShell position="bottom-right" data-testid="right">c</ToastShell>
      </>,
    );
    expect(stackOf('left')).not.toBeNull();
    expect(stackOf('center')).toBe(stackOf('left'));
    expect(stackOf('right')).toBe(stackOf('left'));
    expect(stackOf('left').getAttribute('data-toast-dock')).toBe('bottom');
  });

  it('a raw slot joins the same stack as a toast', () => {
    render(
      <>
        <ToastDockHost />
        <DockSlot position="bottom-center" order={0}><div data-testid="bar" /></DockSlot>
        <ToastShell position="bottom-center" data-testid="undo">x</ToastShell>
      </>,
    );
    expect(stackOf('bar')).toBe(stackOf('undo'));
  });

  it('orders slots from the bottom up by `order`', () => {
    render(
      <>
        <ToastDockHost />
        <DockSlot position="bottom-center" order={1}><div data-testid="bubble" /></DockSlot>
        <DockSlot position="bottom-center" order={0}><div data-testid="bar" /></DockSlot>
      </>,
    );
    expect(screen.getByTestId('bar').parentElement.style.order).toBe('0');
    expect(screen.getByTestId('bubble').parentElement.style.order).toBe('1');
  });

  it('puts top-right toasts in their own stack', () => {
    render(
      <>
        <ToastDockHost />
        <ToastShell position="top-right" data-testid="top">t</ToastShell>
        <ToastShell position="bottom-right" data-testid="bottom">b</ToastShell>
      </>,
    );
    expect(stackOf('top').getAttribute('data-toast-dock')).toBe('top');
    expect(stackOf('bottom')).not.toBe(stackOf('top'));
  });

  it('without a host still renders, pinned on its own', () => {
    render(<ToastShell position="bottom-center" data-testid="lone">x</ToastShell>);
    const el = screen.getByTestId('lone');
    expect(el.closest('.fixed')).not.toBeNull();
  });
});

describe('no banner pins itself to the bottom', () => {
  const SRC = path.resolve(__dirname, '../../..');
  const DOCK = path.resolve(__dirname, '..', 'ToastDock.jsx');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : walk(p);
    return /\.jsx$/.test(e.name) ? [p] : [];
  });

  it('only the dock uses `fixed … bottom-…`', () => {
    const offenders = walk(SRC)
      .filter((f) => f !== DOCK)
      .filter((f) => /\bfixed\b[^"'`\n]*\bbottom-/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
