// @vitest-environment jsdom
// The presentational wheel (QuickActionsWheel.jsx), as the phone renders it: no desktop store or
// translator behind it, a wheel on a window narrower than the desktop's gate, and a wedge a touch
// lit by hand.
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { QuickActionsConfigured } from '../QuickActionsWheel';
import { SettingsViewProvider } from '../settings/views/viewContext';

const icon = () => <span aria-hidden="true">.</span>;
const descriptors = ['archive', 'reply', 'delete'].map((action) => ({ id: action, action, label: action, Icon: icon, onActivate: vi.fn() }));
const config = (mode) => ({ mode, entries: descriptors.map(({ id, action }) => ({ id, action })), favoriteId: 'archive', palette: 'neutral' });

afterEach(() => cleanup());

describe('QuickActionsWheel', () => {
  it('draws a wheel on a phone-wide window when forceRadial says so, and a menu when not', () => {
    window.innerWidth = 375;
    window.innerHeight = 700;
    const open = { x: 180, y: 300 };
    const { unmount } = render(<QuickActionsConfigured config={config('radial')} descriptors={descriptors} openAt={open} />);
    expect(document.querySelector('.quick-actions-radial')).toBeNull();
    expect(document.querySelector('.quick-actions-menu')).not.toBeNull();
    unmount();
    render(<QuickActionsConfigured config={config('radial')} descriptors={descriptors} openAt={open} forceRadial />);
    expect(document.querySelector('.quick-actions-radial')).not.toBeNull();
    expect(document.querySelectorAll('.quick-action-radial-item')).toHaveLength(3);
  });

  it('takes its words from the view context, not the desktop translator', () => {
    render(
      <SettingsViewProvider t={(key) => `T:${key}`}>
        <QuickActionsConfigured config={config('menu')} descriptors={descriptors} />
      </SettingsViewProvider>,
    );
    expect(screen.getByRole('button', { name: 'T:quickActions.title' })).toBeTruthy();
  });
});
