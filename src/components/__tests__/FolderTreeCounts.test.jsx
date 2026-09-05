// @vitest-environment jsdom
//
// A closed folder shows the unread count STATUS reported for it; the open
// folder and folders with nothing unread show no badge.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});

import { FolderTree } from '../FolderTree';

const box = (path) => ({ path, name: path, delimiter: '/', specialUse: null, noselect: false, children: [] });

afterEach(cleanup);

describe('FolderTree counts', () => {
  it('draws the unseen count for a folder that is not open', () => {
    const { getAllByTestId } = render(
      <FolderTree
        mailboxes={[box('INBOX'), box('Archive'), box('Drafts')]}
        activeMailbox="INBOX"
        expanded={new Set()}
        onToggle={() => {}}
        onSelect={() => {}}
        counts={{ Archive: { unseen: 2 }, Drafts: { unseen: 0 }, INBOX: { unseen: 9 } }}
      />
    );
    const badges = getAllByTestId('folder-unseen');
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe('2');
  });

  it('caps the badge at 99+', () => {
    const { getByTestId } = render(
      <FolderTree mailboxes={[box('INBOX'), box('Bulk')]} activeMailbox="INBOX" expanded={new Set()}
        onToggle={() => {}} onSelect={() => {}} counts={{ Bulk: { unseen: 250 } }} compact />
    );
    expect(getByTestId('folder-unseen').textContent).toBe('99+');
  });
});
