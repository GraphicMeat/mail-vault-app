// src/components/onboarding/__tests__/accountStep.test.jsx
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';

vi.mock('../../AccountModal', () => ({
  AccountModal: ({ onSuccess }) => (
    <button data-testid="fake-add" onClick={onSuccess}>add</button>
  ),
}));

import { AccountStep } from '../AccountStep';

afterEach(cleanup);

describe('onboarding account step', () => {
  it('states the four mechanisms before a password is typed', () => {
    render(<AccountStep onAdded={() => {}} />);
    const strip = screen.getByTestId('onboarding-mechanisms');
    expect(strip.children).toHaveLength(4);
  });

  it('warns about the keychain prompt', () => {
    render(<AccountStep onAdded={() => {}} />);
    expect(screen.getByTestId('onboarding-keychain-notice').textContent).toMatch(/Always Allow/i);
  });

  // AccountModal is a portalled Dialog with its own backdrop
  // (AccountModal.jsx:516-524) — mounting it up front would bury the cards
  // and the keychain notice under it. It must not exist in the tree until
  // the user actually asks to add a mailbox.
  it('does not mount the modal until Add Mailbox is clicked', () => {
    render(<AccountStep onAdded={() => {}} />);
    expect(screen.queryByTestId('fake-add')).toBeNull();
    fireEvent.click(screen.getByTestId('onboarding-add-mailbox'));
    expect(screen.queryByTestId('fake-add')).not.toBeNull();
  });

  it('advances when the account is actually added', () => {
    const onAdded = vi.fn();
    render(<AccountStep onAdded={onAdded} />);
    fireEvent.click(screen.getByTestId('onboarding-add-mailbox'));
    screen.getByTestId('fake-add').click();
    expect(onAdded).toHaveBeenCalled();
  });

  // Regression: someone with no working credentials to hand was trapped on
  // this step — Add Mailbox was the only control, and it only advances on a
  // successful IMAP login. This is the escape hatch, so prove it exists.
  it('advances when the account step is skipped', () => {
    const onSkip = vi.fn();
    render(<AccountStep onAdded={() => {}} onSkip={onSkip} />);
    fireEvent.click(screen.getByTestId('onboarding-skip-account'));
    expect(onSkip).toHaveBeenCalled();
  });

  // The hook has to fire on success, not on close — a cancelled modal must not
  // walk the tour forward past a mailbox that was never added.
  it('wires onSuccess, not onClose, into the modal', () => {
    const src = readFileSync('src/components/onboarding/AccountStep.jsx', 'utf8');
    expect(src).toMatch(/onSuccess=\{/);
  });
});
