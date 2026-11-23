// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ReaderHeaderTools } from '../ReaderHeaderTools';
import { useSelectionStore } from '../../../stores/selectionStore';

afterEach(cleanup);

describe('ReaderHeaderTools', () => {
  it('shows open in window only when the reader offers it', () => {
    const open = vi.fn();
    const { rerender } = render(<ReaderHeaderTools />);
    expect(screen.queryByTestId('open-in-window')).toBeNull();
    rerender(<ReaderHeaderTools onOpenInWindow={open} />);
    fireEvent.click(screen.getByTestId('open-in-window'));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('close calls onClose, else closes the selection', () => {
    const onClose = vi.fn();
    const closeEmail = vi.fn();
    useSelectionStore.setState({ closeEmail });
    const { rerender } = render(<ReaderHeaderTools onClose={onClose} />);
    fireEvent.click(screen.getByTestId('close-viewer'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(closeEmail).not.toHaveBeenCalled();
    rerender(<ReaderHeaderTools />);
    fireEvent.click(screen.getByTestId('close-viewer'));
    expect(closeEmail).toHaveBeenCalledTimes(1);
  });

  it("shows the keep toggle for the reader's email", () => {
    const keepEmail = { uid: 7, subject: 'Plan', from: { name: 'Sam', address: 'sam@x' }, _accountId: 'a1', _mailbox: 'INBOX' };
    const { rerender } = render(<ReaderHeaderTools />);
    expect(screen.queryByTestId('keep-toggle')).toBeNull();
    rerender(<ReaderHeaderTools keepEmail={keepEmail} />);
    const order = [...screen.getByTestId('keep-toggle').parentElement.children].map(el => el.getAttribute('data-testid'));
    expect(order).toEqual(['keep-toggle', 'close-viewer']);
  });
});
