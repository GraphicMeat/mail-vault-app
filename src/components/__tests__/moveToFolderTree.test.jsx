// @vitest-environment jsdom
//
// The Move-to-folder list showed the leaf name only, and its `depth` came from
// `mailbox.children` — which is always empty, so every row sat at depth 0. On
// bson73's server that is ten identical "erledigt" buttons and no way to tell
// which project you are filing into.

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});

vi.mock('framer-motion', () => ({
  motion: new Proxy({}, {
    get: () => React.forwardRef(({ children, ...props }, ref) =>
      React.createElement('div', { ...props, ref }, children)),
  }),
}));

const box = (path, extra = {}) => ({
  path,
  name: path.split('.').pop(),
  delimiter: '.',
  specialUse: null,
  noselect: false,
  children: [],
  ...extra,
});

const MAILBOXES = [
  box('INBOX'),
  box('INBOX.Kunden'),
  box('INBOX.Lieferanten'),
  box('INBOX.Lieferanten.Bestellungen'),
  box('INBOX.Lieferanten.Bestellungen.erledigt'),
  box('INBOX.Lieferanten.Technik'),
  box('INBOX.Lieferanten.Technik.Telefonie'),
  box('INBOX.Lieferanten.Technik.Telefonie.NFon AG'),
  box('INBOX.Lieferanten.Technik.Telefonie.NFon AG.erledigt'),
  box('INBOX.Privat'),
  box('INBOX.Sammelmappe', { noselect: true }),
];

let accountState = { mailboxes: MAILBOXES, activeMailbox: 'INBOX' };
vi.mock('../../stores/accountStore', () => ({
  useAccountStore: (selector) => selector(accountState),
}));
vi.mock('../../stores/selectionStore', () => ({
  useSelectionStore: (selector) => selector({ moveEmails: vi.fn() }),
}));

import { MoveToFolderDropdown } from '../MoveToFolderDropdown';

const options = () => [...document.querySelectorAll('[data-testid="move-folder-option"]')];
const paths = () => options().map(o => o.getAttribute('data-path'));
const labelOf = (path) => options().find(o => o.getAttribute('data-path') === path)?.textContent;
const padOf = (path) => parseFloat(
  options().find(o => o.getAttribute('data-path') === path).style.paddingLeft);

const open = () => render(
  <MoveToFolderDropdown uids={[1]} onClose={() => {}} anchorRect={null} />
);
const search = (text) => fireEvent.change(
  document.querySelector('[data-testid="move-folder-search"]'), { target: { value: text } });

afterEach(cleanup);

describe('Move to folder, on a nested server', () => {
  it('indents each level past the one above it', () => {
    open();
    expect(padOf('INBOX.Lieferanten.Technik')).toBeGreaterThan(padOf('INBOX.Lieferanten'));
    expect(padOf('INBOX.Lieferanten.Technik.Telefonie.NFon AG.erledigt'))
      .toBeGreaterThan(padOf('INBOX.Lieferanten.Technik.Telefonie'));
  });

  it('files each folder under its own parent instead of one flat A-Z run', () => {
    open();
    const order = paths();
    // Lieferanten's whole subtree sits between it and the next root.
    expect(order.indexOf('INBOX.Lieferanten.Technik'))
      .toBeGreaterThan(order.indexOf('INBOX.Lieferanten'));
    expect(order.indexOf('INBOX.Lieferanten.Technik'))
      .toBeLessThan(order.indexOf('INBOX.Privat'));
  });

  it('names the parent once a search has collapsed the tree', () => {
    // Indentation says nothing when the parents have been filtered away.
    open();
    search('erledigt');
    expect(paths()).toHaveLength(2);
    expect(labelOf('INBOX.Lieferanten.Bestellungen.erledigt')).toContain('Bestellungen');
    expect(labelOf('INBOX.Lieferanten.Technik.Telefonie.NFon AG.erledigt')).toContain('NFon AG');
  });

  it('finds a folder by a word from its parent', () => {
    open();
    search('Telefonie');
    expect(paths()).toContain('INBOX.Lieferanten.Technik.Telefonie.NFon AG.erledigt');
  });

  it('leaves out the folder the messages are already in', () => {
    accountState = { ...accountState, activeMailbox: 'INBOX.Lieferanten.Technik' };
    open();
    expect(paths()).not.toContain('INBOX.Lieferanten.Technik');
    // ...but its children are still perfectly good targets.
    expect(paths()).toContain('INBOX.Lieferanten.Technik.Telefonie');
    accountState = { ...accountState, activeMailbox: 'INBOX' };
  });

  it('leaves out a container the server will not let you file into', () => {
    open();
    expect(paths()).not.toContain('INBOX.Sammelmappe');
  });
});
