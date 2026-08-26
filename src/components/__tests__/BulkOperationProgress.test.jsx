// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { BulkOperationProgress } from '../BulkOperationProgress';

// framer-motion is deliberately NOT mocked here. A mock written as a plain
// function drops `ref` and turns initial/animate/exit into DOM attributes, so a
// spec asserting a completed state under it asserts the attribute and believes
// it is the component. This panel needs neither, and the real library renders a
// plain div in jsdom.

const op = (over = {}) => ({
  status: 'archiving', currentPhase: 'archive', total: 100, completed: 40,
  errors: 0, type: 'archive', ...over,
});

function paint(over) {
  return render(
    <BulkOperationProgress operation={op(over)} onCancel={vi.fn()} onDismiss={vi.fn()} />
  );
}

// The panel is the only surface that reports a bulk run, and its terminal
// frames are reachable only through a store field EmailList owns privately —
// so nothing mounted this branch before: the spec that names this component
// mocks it to `() => null`, and no e2e ever drives a run to completion.
describe('BulkOperationProgress — the completion beat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('beats the mark in Vault Emerald when the run moved mail into the vault', () => {
    const { container } = paint({ status: 'complete', completed: 100 });
    const mark = container.querySelector('.op-landed');
    expect(mark).not.toBeNull();
    expect(mark.className).toContain('bg-mail-local-tint');
    expect(mark.querySelector('svg')?.getAttribute('class')).toContain('text-mail-local');
  });

  it('turns the panel edge emerald so the outcome reads from across the room', () => {
    const { container } = paint({ status: 'complete', completed: 100 });
    const panel = container.querySelector('.rounded-xl');
    expect(panel.className).toContain('border-mail-local');
  });

  // Custody colour is a closed vocabulary: a delete is not "server becoming
  // vault", so it must not borrow the emerald.
  it('does NOT spend custody emerald on a run that only deleted', () => {
    const { container } = paint({ status: 'complete', type: 'delete', completed: 100 });
    const mark = container.querySelector('.op-landed');
    expect(mark).not.toBeNull();
    expect(mark.className).toContain('bg-mail-success-tint');
    expect(mark.className).not.toContain('bg-mail-local-tint');
    const panel = container.querySelector('.rounded-xl');
    expect(panel.className).not.toContain('border-mail-local');
  });

  it('drops out of the custody story entirely on failure', () => {
    const { container } = paint({ status: 'error', errors: 3 });
    const mark = container.querySelector('.op-landed');
    expect(mark.className).toContain('bg-mail-danger-tint');
    expect(container.querySelector('.rounded-xl').className).toContain('border-mail-danger');
  });

  it('does not beat while the run is still going', () => {
    const { container } = paint();
    expect(container.querySelector('.op-landed')).toBeNull();
    expect(container.querySelector('.rounded-xl').className).toContain('border-mail-border');
  });

  it('still reports the counts it is there to report', () => {
    paint({ completed: 40, total: 100 });
    expect(screen.getByText('40 of 100 emails')).toBeTruthy();
    expect(screen.getByText('40%')).toBeTruthy();
  });
});
