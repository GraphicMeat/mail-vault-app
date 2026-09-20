// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QuickActions } from '../QuickActions';

const icon = () => <span aria-hidden="true">•</span>;
const descriptors = [
  { id: 'archive', action: 'archive', label: 'Archive', Icon: icon, onActivate: vi.fn() },
  { id: 'reply', action: 'reply', label: 'Reply', Icon: icon, onActivate: vi.fn() },
  { id: 'delete', action: 'delete', label: 'Delete', Icon: icon, onActivate: vi.fn(), tone: 'danger' },
];
const config = (mode, entries = descriptors, favoriteId = 'archive') => ({
  mode, entries: entries.map(({ id, action }) => ({ id, action })), favoriteId, palette: 'neutral',
});

afterEach(() => {
  cleanup();
  descriptors.forEach(item => item.onActivate.mockClear());
});

describe('QuickActions', () => {
  it('renders configured entries in order and applies custom colors without replacing labels', () => {
    render(<QuickActions config={{ ...config('inline'), palette: 'custom', entries: [
      { id: 'reply', action: 'reply', color: '#123456' },
      { id: 'archive', action: 'archive' },
    ] }} descriptors={descriptors} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual(['Reply', 'Archive']);
    expect(buttons[0].style.getPropertyValue('--quick-action-color')).toBe('#123456');
  });

  it('opens a menu and supports arrow, Home, and End navigation', () => {
    render(<QuickActions config={config('menu')} descriptors={descriptors} />);
    fireEvent.click(screen.getByRole('button', { name: 'Quick actions' }));
    const menu = screen.getByRole('menu');
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
  });

  it('runs an action once, stops row activation, and restores focus after dismissal', async () => {
    const parentClick = vi.fn();
    render(<div onClick={parentClick}><QuickActions config={config('favorite-menu')} descriptors={descriptors} /></div>);
    const favorite = screen.getByRole('button', { name: 'Archive' });
    fireEvent.click(favorite);
    expect(descriptors[0].onActivate).toHaveBeenCalledOnce();
    expect(parentClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Quick actions' }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Quick actions' })));
  });

  it('uses a safe favorite fallback when the saved favorite is unavailable', () => {
    render(<QuickActions config={{ ...config('favorite-menu', descriptors, 'missing') }} descriptors={descriptors} />);
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('allows an explicitly chosen destructive favorite to route through its guarded handler', () => {
    render(<QuickActions config={config('favorite-menu', descriptors, 'delete')} descriptors={descriptors} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(descriptors[2].onActivate).toHaveBeenCalledOnce();
  });

  it('does not substitute a different saved template or folder for a missing parameterized entry', () => {
    const parameterized = [
      { id: 'replyTemplate:template-1', action: 'replyTemplate', label: 'Template one', Icon: icon, onActivate: vi.fn() },
      { id: 'move:account-a:Archive', action: 'move', label: 'Move to Archive', Icon: icon, onActivate: vi.fn() },
    ];
    render(<QuickActions config={{ mode: 'inline', favoriteId: null, palette: 'neutral', entries: [
      { id: 'replyTemplate:template-2', action: 'replyTemplate', params: { templateId: 'template-2' } },
      { id: 'move:account-b:Archive', action: 'move', params: { accountId: 'account-b', mailbox: 'Archive' } },
    ] }} descriptors={parameterized} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(parameterized.every(item => item.onActivate.mock.calls.length === 0)).toBe(true);
  });

  it('keeps unavailable actions disabled and offers radial actions through keyboard', () => {
    const unavailable = [{ id: 'reply', action: 'reply', label: 'Reply', Icon: icon, disabled: true }];
    render(<QuickActions config={config('radial', unavailable)} descriptors={unavailable} />);
    fireEvent.click(screen.getByRole('button', { name: 'Quick actions' }));
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Reply' }).hasAttribute('disabled')).toBe(true);
  });
});
