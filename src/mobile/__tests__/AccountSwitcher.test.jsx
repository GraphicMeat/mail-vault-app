// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { Avatar } from '../AccountSwitcher.jsx';
import MessageRow from '../MessageRow.jsx';
import { accountColor } from '../accountColor.js';

afterEach(cleanup);

/** jsdom reports an inline colour as rgb(); this is the same form for a #rrggbb. */
const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

describe('Avatar', () => {
  it('wears the color the desktop gave the account', () => {
    const { container } = render(<Avatar account={{ email: 'ann@example.test', color: '#ec4899' }} />);
    expect(container.firstChild.style.backgroundColor).toBe('rgb(236, 72, 153)');
  });

  it('an account without one wears its hashed colour, not the accent', () => {
    const account = { email: 'ann@example.test', color: null };
    const { container } = render(<Avatar account={account} small />);
    expect(container.firstChild.style.backgroundColor).toBe(rgb(accountColor(account)));
  });

  it('matches the account\'s All Inboxes row dot, for phone-added and imported accounts', () => {
    for (const account of [
      { id: 'p1', email: 'phone-one@example.test', displayName: 'One', color: null },
      { id: 'p2', email: 'phone-two@example.test', displayName: 'Two' },
      { id: 'd1', email: 'desk@example.test', displayName: 'Desk', color: '#14b8a6' },
    ]) {
      const avatar = render(<Avatar account={account} />);
      const row = render(
        <MessageRow
          row={{ uid: 1, dateMs: 1, subject: 's', fromName: 'S', fromAddress: 's@example.test', snippet: '', seen: false, flagged: false, to: [], accountId: account.id, folder: 'INBOX' }}
          index={0}
          onOpen={() => {}}
          account={account}
        />,
      );
      const dot = row.container.querySelector('.mv-row__acct');
      expect(avatar.container.firstChild.style.backgroundColor).not.toBe('');
      expect(avatar.container.firstChild.style.backgroundColor).toBe(dot.style.backgroundColor);
      avatar.unmount();
      row.unmount();
    }
  });
});
