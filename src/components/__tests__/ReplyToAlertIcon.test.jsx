// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return {
    AlertTriangle: icon('AlertTriangle'),
    CornerUpLeft: icon('CornerUpLeft'),
    X: icon('X'),
  };
});

import { ReplyToAlertIcon, getThreadReplyToMismatch } from '../ReplyToAlertIcon';

describe('ReplyToAlertIcon', () => {
  afterEach(() => cleanup());

  it('renders nothing when mismatch is falsy', () => {
    const { container } = render(<ReplyToAlertIcon mismatch={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders an AlertTriangle button when mismatch is provided', () => {
    render(
      <ReplyToAlertIcon
        mismatch={{ fromDomain: 'bank.com', replyToAddress: 'x@evil.ru', replyToDomain: 'evil.ru' }}
      />
    );
    const button = screen.getByRole('button');
    expect(button).toBeTruthy();
    expect(button.querySelector('[data-icon="AlertTriangle"]')).toBeTruthy();
  });

  it('opens modal with domain details on click', () => {
    render(
      <ReplyToAlertIcon
        mismatch={{ fromDomain: 'bank.com', replyToAddress: 'x@evil.ru', replyToDomain: 'evil.ru' }}
      />
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Reply-To domain mismatch')).toBeTruthy();
    expect(screen.getByText('bank.com')).toBeTruthy();
    expect(screen.getByText('x@evil.ru')).toBeTruthy();
    expect(screen.getAllByText('evil.ru').length).toBeGreaterThan(0);
  });

  it('closes the modal on Escape', () => {
    render(
      <ReplyToAlertIcon
        mismatch={{ fromDomain: 'bank.com', replyToAddress: 'x@evil.ru', replyToDomain: 'evil.ru' }}
      />
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Reply-To domain mismatch')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Reply-To domain mismatch')).toBeNull();
  });

  it('stops click propagation so clicking the icon does not select the row', () => {
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <ReplyToAlertIcon
          mismatch={{ fromDomain: 'bank.com', replyToAddress: 'x@evil.ru', replyToDomain: 'evil.ru' }}
        />
      </div>
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

describe('getThreadReplyToMismatch', () => {
  it('returns null for empty or undefined input', () => {
    expect(getThreadReplyToMismatch([])).toBeNull();
    expect(getThreadReplyToMismatch(null)).toBeNull();
    expect(getThreadReplyToMismatch(undefined)).toBeNull();
  });

  it('returns null when no email in the thread has a mismatch', () => {
    const emails = [{ uid: 1 }, { uid: 2, _replyToMismatch: null }];
    expect(getThreadReplyToMismatch(emails)).toBeNull();
  });

  it('returns the first mismatch found in the thread', () => {
    const first = { fromDomain: 'a.com', replyToAddress: 'x@b.com', replyToDomain: 'b.com' };
    const second = { fromDomain: 'c.com', replyToAddress: 'y@d.com', replyToDomain: 'd.com' };
    const emails = [
      { uid: 1 },
      { uid: 2, _replyToMismatch: first },
      { uid: 3, _replyToMismatch: second },
    ];
    expect(getThreadReplyToMismatch(emails)).toBe(first);
  });
});
