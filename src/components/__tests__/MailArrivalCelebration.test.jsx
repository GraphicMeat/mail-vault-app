// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MailArrivalCelebration } from '../MailArrivalCelebration';

afterEach(cleanup);

describe('MailArrivalCelebration', () => {
  it('presents the full-screen arrival with a way to continue', () => {
    const onClose = vi.fn();
    render(<MailArrivalCelebration onClose={onClose} />);

    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('heading', { name: /place to land/i })).toBeTruthy();
    expect(screen.getAllByTestId('flying-email').length).toBeGreaterThan(6);
    fireEvent.click(screen.getByRole('button', { name: /continue to mailvault/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('lets the user skip the animation with Escape', () => {
    const onClose = vi.fn();
    render(<MailArrivalCelebration onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('uses the secure vault for a connected account and leaves some emails outside', () => {
    render(<MailArrivalCelebration kind="account" onClose={() => {}} />);
    expect(screen.getByTestId('mail-arrival-hero').getAttribute('src')).toContain('account-safe-mailbox');
    const envelopes = screen.getAllByTestId('flying-email');
    expect(envelopes.every((envelope) => envelope.querySelector('img')?.getAttribute('src').includes('voxel-envelope'))).toBe(true);
    expect(envelopes.filter((envelope) => envelope.classList.contains('mail-arrival-envelope-outside'))).toHaveLength(3);
  });
});
