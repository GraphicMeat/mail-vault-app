// @vitest-environment jsdom

// The reading pane's way out. Both readers mount this one component — the
// single-message viewer and the thread view are separate files with separate
// headers, and a close button on only one of them is a door that exists in
// half the rooms.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { create } from 'zustand';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});

const closeEmail = vi.fn();
const useStoreMock = create(() => ({ closeEmail }));
vi.mock('../../stores/mailStore', () => ({
  useMailStore: (selector) => useStoreMock(selector),
}));

const { CloseViewerButton } = await import('../email/CloseViewerButton');

describe('CloseViewerButton', () => {
  beforeEach(() => closeEmail.mockClear());
  afterEach(() => cleanup());

  it('closes the reader on click', () => {
    render(<CloseViewerButton />);
    fireEvent.click(screen.getByTestId('close-viewer'));
    expect(closeEmail).toHaveBeenCalledTimes(1);
  });

  it('is reachable without sight of the glyph', () => {
    render(<CloseViewerButton />);
    expect(screen.getByTestId('close-viewer').getAttribute('aria-label')).toBe('Close');
  });

  it('does not let the click reach the row or header behind it', () => {
    // The thread header is a drag region and the subject row is clickable
    // chrome; a close that also triggers those is a close that reopens.
    const onParentClick = vi.fn();
    render(<div onClick={onParentClick}><CloseViewerButton /></div>);
    fireEvent.click(screen.getByTestId('close-viewer'));
    expect(closeEmail).toHaveBeenCalledTimes(1);
    expect(onParentClick).not.toHaveBeenCalled();
  });
});
