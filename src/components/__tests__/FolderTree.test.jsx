// @vitest-environment jsdom
//
// bson73, discussion #1: five levels deep on a Dovecot server, and the leaf is
// called "erledigt" ten times over. Flat and alphabetical, those ten rows are
// indistinguishable; the point of the tree is that each one sits under the
// parent that gives it its meaning.

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

import { FolderTree } from '../FolderTree';

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
  box('INBOX.Lieferanten.Technik'),
  box('INBOX.Lieferanten.Technik.Telefonie'),
  box('INBOX.Lieferanten.Technik.Telefonie.NFon AG'),
  box('INBOX.Lieferanten.Technik.Telefonie.NFon AG.erledigt'),
  box('INBOX.Sent', { specialUse: '\\Sent' }),
];

const ALL_OPEN = new Set([
  'INBOX.Lieferanten',
  'INBOX.Lieferanten.Technik',
  'INBOX.Lieferanten.Technik.Telefonie',
  'INBOX.Lieferanten.Technik.Telefonie.NFon AG',
]);

const draw = (props = {}) => render(
  <FolderTree
    mailboxes={MAILBOXES}
    activeMailbox="INBOX"
    expanded={ALL_OPEN}
    onToggle={() => {}}
    onSelect={() => {}}
    {...props}
  />
);

const rows = () => [...document.querySelectorAll('[data-testid="folder-row"]')];
const rowPaths = () => rows().map(r => r.getAttribute('data-path'));
const row = (path) => rows().find(r => r.getAttribute('data-path') === path);
const toggle = (path) => [...document.querySelectorAll('[data-testid="folder-toggle"]')]
  .find(b => b.getAttribute('data-path') === path);
// The chevron is an icon too, and it comes first. Ask for the folder's own.
const iconOf = (path) => [...row(path).querySelectorAll('[data-icon]')]
  .find(el => !el.closest('[data-testid="folder-toggle"]'))
  .getAttribute('data-icon');

afterEach(cleanup);

describe('FolderTree', () => {
  it('draws a row per folder, carrying its depth', () => {
    draw();
    expect(row('INBOX.Lieferanten').getAttribute('data-depth')).toBe('0');
    expect(row('INBOX.Lieferanten.Technik.Telefonie.NFon AG.erledigt')
      .getAttribute('data-depth')).toBe('4');
  });

  it('hides a whole subtree when its parent is collapsed', () => {
    draw({ expanded: new Set() });
    expect(rowPaths()).toEqual(['INBOX', 'INBOX.Kunden', 'INBOX.Lieferanten', 'INBOX.Sent']);
  });

  it('indents each level further than the last', () => {
    draw();
    const pad = p => parseFloat(row(p).style.paddingLeft);
    expect(pad('INBOX.Lieferanten.Technik')).toBeGreaterThan(pad('INBOX.Lieferanten'));
    expect(pad('INBOX.Lieferanten.Technik.Telefonie'))
      .toBeGreaterThan(pad('INBOX.Lieferanten.Technik'));
  });

  it('selects the folder by its full server path, not its label', () => {
    // "erledigt" alone identifies ten different mailboxes.
    const onSelect = vi.fn();
    draw({ onSelect });
    fireEvent.click(row('INBOX.Lieferanten.Technik.Telefonie.NFon AG.erledigt'));
    expect(onSelect).toHaveBeenCalledWith('INBOX.Lieferanten.Technik.Telefonie.NFon AG.erledigt');
  });

  it('toggles from the chevron without also selecting the folder', () => {
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    draw({ onToggle, onSelect });
    fireEvent.click(toggle('INBOX.Lieferanten'));
    expect(onToggle).toHaveBeenCalledWith('INBOX.Lieferanten');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('gives a childless folder no chevron', () => {
    draw();
    expect(toggle('INBOX.Kunden')).toBeUndefined();
  });

  it('marks the active folder for assistive tech, not by colour alone', () => {
    draw({ activeMailbox: 'INBOX.Lieferanten.Technik' });
    expect(row('INBOX.Lieferanten.Technik').getAttribute('aria-current')).toBe('true');
    expect(row('INBOX.Lieferanten').getAttribute('aria-current')).toBeNull();
  });

  it('draws a nested user folder as a folder, not as an inbox', () => {
    // getMailboxIcon fell through to Inbox for anything without a specialUse.
    // Flat, that was invisible; nested, all 59 of his folders became inboxes.
    draw();
    expect(iconOf('INBOX.Lieferanten.Technik')).toBe('Folder');
    expect(iconOf('INBOX')).toBe('Inbox');
    expect(iconOf('INBOX.Sent')).toBe('Send');
  });

  it('will not select a folder the server marked unselectable', () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    render(
      <FolderTree
        mailboxes={[box('INBOX'), box('INBOX.Container', { noselect: true }), box('INBOX.Container.Real')]}
        activeMailbox="INBOX"
        expanded={new Set(['INBOX.Container'])}
        onToggle={onToggle}
        onSelect={onSelect}
      />
    );
    fireEvent.click(row('INBOX.Container'));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onToggle).toHaveBeenCalledWith('INBOX.Container');
  });

  it('shows the decoded name but keeps the encoded path', () => {
    render(
      <FolderTree
        mailboxes={[box('INBOX'), box('INBOX.Bokelmu&Awg-hle')]}
        activeMailbox="INBOX"
        expanded={new Set()}
        onToggle={() => {}}
        onSelect={() => {}}
      />
    );
    const node = row('INBOX.Bokelmu&Awg-hle');
    expect(node.textContent).toContain('Bokelmühle');
    expect(node.getAttribute('data-path')).toBe('INBOX.Bokelmu&Awg-hle');
  });
});
