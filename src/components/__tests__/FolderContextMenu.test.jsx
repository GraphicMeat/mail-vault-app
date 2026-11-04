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

// Move folder copies a folder's mail elsewhere and retires the original: a
// folder the app addresses by role, or one that is on no server, has none.
describe('FolderContextMenu Move folder', () => {
  const move = (node) => {
    const onMove = vi.fn();
    const onClose = vi.fn();
    draw(node, { onMove, onClose });
    return { onMove, onClose, item: item(t('sidebar.moveFolder')) };
  };

  it('offers Move folder for a custom folder, after Rename, and hands it the node', () => {
    const node = { path: 'Projects', name: 'Projects' };
    const { onMove, onClose, item: moveItem } = move(node);
    expect(items().map(b => b.textContent)).toEqual([
      t('sidebar.newSubfolder'), t('sidebar.renameFolder'), t('sidebar.moveFolder'), t('sidebar.deleteFolder'),
    ]);
    fireEvent.click(moveItem);
    expect(onMove).toHaveBeenCalledWith(node);
    expect(onClose).toHaveBeenCalled();
  });

  it('offers it for a folder under Trash too', () => {
    expect(move({ path: 'Trash/Old', name: 'Old' }).item).toBeTruthy();
  });

  it.each([
    ['INBOX', { path: 'INBOX', name: 'INBOX' }],
    ['a special-use folder', { path: 'Trash', name: 'Trash', specialUse: '\\Trash' }],
    ['a guessed special use', { path: 'Archive', name: 'Archive', specialUse: '\\Archive', specialUseGuessed: true }],
    ['a local folder', { path: 'MBOX import', name: 'MBOX import', local: true }],
  ])('never offers it on %s', (_, node) => {
    expect(move(node).item).toBeUndefined();
  });

  // The move ends by renaming the original's vault folders, which an import
  // may be filling.
  it('offers it disabled while an import runs', () => {
    const onMove = vi.fn();
    draw({ path: 'Projects', name: 'Projects' }, { onMove, importRunning: true });
    const moveItem = item(t('sidebar.moveFolder'));
    expect(moveItem.disabled).toBe(true);
    fireEvent.click(moveItem);
    expect(onMove).not.toHaveBeenCalled();
  });

  it('shows nothing to move with when the caller cannot move folders', () => {
    draw({ path: 'Projects', name: 'Projects' });
    expect(item(t('sidebar.moveFolder'))).toBeUndefined();
  });
});

describe('FolderContextMenu icon colour', () => {
  it('offers swatches and reports the picked colour', () => {
    const onSetColor = vi.fn();
    draw({ path: 'Projects' }, { onSetColor });
    const swatches = document.querySelectorAll('[data-testid="folder-color-swatch"]');
    expect(swatches.length).toBeGreaterThan(5);
    fireEvent.click(swatches[1]);
    expect(onSetColor).toHaveBeenCalledWith({ path: 'Projects' }, swatches[1].getAttribute('data-color'));
  });

  it('reset clears the custom colour', () => {
    const onSetColor = vi.fn();
    draw({ path: 'Projects' }, { onSetColor });
    fireEvent.click(document.querySelector('[data-testid="folder-color-reset"]'));
    expect(onSetColor).toHaveBeenCalledWith({ path: 'Projects' }, null);
  });

  it('special and local folders can be recoloured too', () => {
    draw({ path: 'Trash', specialUse: '\\Trash' }, { onSetColor: () => {} });
    expect(document.querySelectorAll('[data-testid="folder-color-swatch"]').length).toBeGreaterThan(5);
    cleanup();
    draw({ path: 'L', local: true }, { onSetColor: () => {} });
    expect(document.querySelectorAll('[data-testid="folder-color-swatch"]').length).toBeGreaterThan(5);
  });
});
