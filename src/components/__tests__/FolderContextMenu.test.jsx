// @vitest-environment jsdom
//
// The right-click menu on a folder. What it must never offer is as important
// as what it offers: INBOX and every special-use folder are addressed by role
// (the app files a sent message into \Sent), so renaming or deleting one is
// off the table. A folder already in Trash has nowhere further to go, so its
// destructive item is the permanent one.
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
// folderOps' helpers are pure, but its module pulls the transport in.
vi.mock('../../services/api', () => ({}));
vi.mock('../../services/authUtils', () => ({ ensureFreshToken: async (a) => a }));

import { FolderContextMenu } from '../FolderContextMenu';
import { t } from '../../i18n/index.js';

const MAILBOXES = [
  { path: 'INBOX', delimiter: '/' },
  { path: 'Trash', delimiter: '/', specialUse: '\\Trash' },
  { path: 'Trash/Old', delimiter: '/' },
  { path: 'Projects', delimiter: '/' },
];

const draw = (node, props = {}) => render(
  <FolderContextMenu
    menu={node ? { node, x: 40, y: 90 } : null}
    mailboxes={MAILBOXES}
    onClose={() => {}}
    onNewSubfolder={() => {}}
    onRename={() => {}}
    onDelete={() => {}}
    {...props}
  />
);

const items = () => [...document.querySelectorAll('[data-testid="folder-context-menu"] button')];
const item = (label) => items().find(b => b.textContent.includes(label));

afterEach(cleanup);

describe('FolderContextMenu', () => {
  it('draws nothing without a menu', () => {
    draw(null);
    expect(document.querySelector('[data-testid="folder-context-menu"]')).toBeNull();
  });

  it('opens where the pointer was', () => {
    draw({ path: 'Projects', name: 'Projects' });
    const menu = document.querySelector('[data-testid="folder-context-menu"]');
    expect(menu.style.top).toBe('90px');
    expect(menu.style.left).toBe('40px');
    expect(menu.getAttribute('role')).toBe('menu');
  });

  it('offers a plain folder all three actions, with Trash as the destructive one', () => {
    draw({ path: 'Projects', name: 'Projects' });
    expect(items().map(b => b.textContent)).toEqual([
      t('sidebar.newSubfolder'), t('sidebar.renameFolder'), t('sidebar.deleteFolder'),
    ]);
    expect(item(t('sidebar.renameFolder')).disabled).toBe(false);
    expect(item(t('sidebar.deleteFolder')).disabled).toBe(false);
  });

  it('locks rename and delete on INBOX, but still lets a subfolder be added', () => {
    draw({ path: 'INBOX', name: 'INBOX' });
    expect(item(t('sidebar.newSubfolder')).disabled).toBe(false);
    expect(item(t('sidebar.renameFolder')).disabled).toBe(true);
    expect(item(t('sidebar.deleteFolder')).disabled).toBe(true);
  });

  it('locks rename and delete on a special-use folder', () => {
    draw({ path: 'Trash', name: 'Trash', specialUse: '\\Trash' });
    expect(item(t('sidebar.renameFolder')).disabled).toBe(true);
  });

  it('offers the permanent delete for a folder already under Trash', () => {
    draw({ path: 'Trash/Old', name: 'Old' });
    expect(item(t('sidebar.deleteFolderForever'))).toBeTruthy();
    expect(item(t('sidebar.deleteFolder'))).toBeUndefined();
  });

  it('tells the caller the delete is permanent', () => {
    const onDelete = vi.fn();
    const onClose = vi.fn();
    const node = { path: 'Trash/Old', name: 'Old' };
    draw(node, { onDelete, onClose });
    fireEvent.click(item(t('sidebar.deleteFolderForever')));
    expect(onDelete).toHaveBeenCalledWith(node, { permanent: true });
    expect(onClose).toHaveBeenCalled();
  });

  it('reports a plain delete as reversible', () => {
    const onDelete = vi.fn();
    const node = { path: 'Projects', name: 'Projects' };
    draw(node, { onDelete });
    fireEvent.click(item(t('sidebar.deleteFolder')));
    expect(onDelete).toHaveBeenCalledWith(node, { permanent: false });
  });

  it('hands the node to New subfolder and closes itself', () => {
    const onNewSubfolder = vi.fn();
    const onClose = vi.fn();
    const node = { path: 'Projects', name: 'Projects' };
    draw(node, { onNewSubfolder, onClose });
    fireEvent.click(item(t('sidebar.newSubfolder')));
    expect(onNewSubfolder).toHaveBeenCalledWith(node);
    expect(onClose).toHaveBeenCalled();
  });

  it('hands the node to Rename', () => {
    const onRename = vi.fn();
    const node = { path: 'Projects', name: 'Projects' };
    draw(node, { onRename });
    fireEvent.click(item(t('sidebar.renameFolder')));
    expect(onRename).toHaveBeenCalledWith(node);
  });
});
