// @vitest-environment jsdom
//
// MBOX import mode 3 ("Import as a separate folder") files the mail into a
// folder that exists only in the vault. The sidebar draws those folders under
// their own "On this computer" group, after the server's tree: never mixed
// into it (they are not server folders, and one row outside an INBOX-prefixed
// namespace would stop the prefix being lifted for the whole account), and
// their right-click menu offers the one thing that works on them, Delete folder.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, fireEvent, cleanup, within } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});
// folderOps' helpers are pure, but its module pulls the transport in.
vi.mock('../../services/api', () => ({}));
vi.mock('../../services/authUtils', () => ({ ensureFreshToken: async (a) => a }));

import { FolderTree, FolderBubbles } from '../FolderTree';
import { FolderContextMenu } from '../FolderContextMenu';
import { withLocalFolders } from '../../services/workflows/mailboxTree';

const box = (path, extra = {}) => ({
  path, name: path.split('.').pop(), delimiter: '.', specialUse: null, noselect: false, children: [], ...extra,
});

// A Dovecot-style account: every server folder under INBOX, so the tree lifts
// the prefix and draws Kunden beside INBOX, not inside it.
const SERVER = [box('INBOX'), box('INBOX.Kunden'), box('INBOX.Sent', { specialUse: '\\Sent' })];
const LOCAL = [
  { name: 'MBOX import 2026-09-29', dir: 'MBOX_import_2026-09-29', kind: 'import', created: 1, source: 'a.mbox' },
  { name: 'MBOX import 2026-09-29 2', dir: 'MBOX_import_2026-09-29_2', kind: 'import', created: 2, source: 'b.mbox' },
];
const LOCAL_NAMES = LOCAL.map(f => f.name);

const draw = (Component, props = {}) => render(
  <Component
    mailboxes={withLocalFolders(SERVER, LOCAL)}
    activeMailbox="INBOX"
    expanded={new Set()}
    onToggle={() => {}}
    onSelect={() => {}}
    {...props}
  />
);

const rows = (root = document) => [...root.querySelectorAll('[data-testid="folder-row"]')];
const paths = (root) => rows(root).map(r => r.getAttribute('data-path'));
const group = () => document.querySelector('[role="group"][aria-label="On this computer"]');

afterEach(cleanup);

describe('local folders in the folder tree', () => {
  it('merge as local rows addressed by their display name, after the server list', () => {
    const merged = withLocalFolders(SERVER, LOCAL);
    expect(merged.slice(0, SERVER.length)).toEqual(SERVER);
    expect(merged.slice(SERVER.length).map(m => [m.path, m.name, m.local])).toEqual(
      LOCAL_NAMES.map(n => [n, n, true]),
    );
    // No local folder: the server list itself, untouched.
    expect(withLocalFolders(SERVER, [])).toBe(SERVER);
    expect(withLocalFolders(SERVER, undefined)).toBe(SERVER);
  });

  it('draws them under "On this computer", after the server tree, not inside it', () => {
    draw(FolderTree);
    const g = group();
    expect(g).toBeTruthy();
    expect(within(g).getByText('On this computer')).toBeTruthy();
    expect(paths(g)).toEqual(LOCAL_NAMES);
    // The server tree is drawn exactly as without them: the INBOX prefix is
    // still lifted (Kunden beside INBOX, at depth 0), and they come last.
    expect(paths()).toEqual(['INBOX', 'INBOX.Kunden', 'INBOX.Sent', ...LOCAL_NAMES]);
    expect(rows().find(r => r.getAttribute('data-path') === 'INBOX.Kunden').getAttribute('data-depth')).toBe('0');
    for (const r of rows(g)) expect(r.getAttribute('data-depth')).toBe('0');
  });

  it('draws no group for an account without local folders', () => {
    render(<FolderTree mailboxes={SERVER} activeMailbox="INBOX" expanded={new Set()} onToggle={() => {}} onSelect={() => {}} />);
    expect(group()).toBeNull();
  });

  it('selects a local folder by its display name and marks it current', () => {
    const onSelect = vi.fn();
    draw(FolderTree, { onSelect, activeMailbox: LOCAL_NAMES[0] });
    const r = rows(group())[0];
    expect(r.getAttribute('aria-current')).toBe('true');
    fireEvent.click(r);
    expect(onSelect).toHaveBeenCalledWith(LOCAL_NAMES[0]);
  });

  it('keeps the group in the collapsed rail, named for assistive tech', () => {
    draw(FolderTree, { compact: true });
    expect(paths(group())).toEqual(LOCAL_NAMES);
  });

  it('draws the same group in the tag-cloud style', () => {
    draw(FolderBubbles);
    expect(paths(group())).toEqual(LOCAL_NAMES);
    expect(paths()).toEqual(['INBOX', 'INBOX.Kunden', 'INBOX.Sent', ...LOCAL_NAMES]);
  });

  it('finds a local folder by name in the folder search', () => {
    draw(FolderTree, { searchQuery: 'mbox import' });
    expect(paths()).toEqual(LOCAL_NAMES);
  });
});

describe('the right-click menu of a local folder', () => {
  const node = { path: LOCAL_NAMES[0], name: LOCAL_NAMES[0], local: true };
  const menu = (props = {}) => render(
    <FolderContextMenu menu={{ node, x: 10, y: 20 }} mailboxes={SERVER}
      onClose={() => {}} onNewSubfolder={() => {}} onRename={() => {}} onDelete={() => {}} {...props} />
  );
  const items = () => [...document.querySelectorAll('[data-testid="folder-context-menu"] button')];

  it('offers Delete folder alone: no subfolder, no rename, no move to Trash', () => {
    menu();
    expect(items().map(b => b.textContent)).toEqual(['Delete folder…']);
  });

  it('asks for the confirmed delete', () => {
    const onDelete = vi.fn();
    const onClose = vi.fn();
    menu({ onDelete, onClose });
    fireEvent.click(items()[0]);
    expect(onDelete).toHaveBeenCalledWith(node, { permanent: true });
    expect(onClose).toHaveBeenCalled();
  });

  it('is not offered while an import is still running', () => {
    const onDelete = vi.fn();
    menu({ onDelete, importRunning: true });
    expect(items()[0].disabled).toBe(true);
    fireEvent.click(items()[0]);
    expect(onDelete).not.toHaveBeenCalled();
  });
});
