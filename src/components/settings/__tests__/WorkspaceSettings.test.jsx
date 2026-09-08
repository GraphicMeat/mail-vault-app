// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WorkspaceSettings } from '../WorkspaceSettings';
import { useSettingsStore } from '../../../stores/settingsStore';

beforeEach(() => useSettingsStore.setState({ viewStyle: 'list', layoutMode: 'three-column', sidebarStyle: 'list', emailListStyle: 'compact' }));
afterEach(cleanup);

describe('workspace choices', () => {
  it('applies each layout choice and exposes the current selection', () => {
    render(<WorkspaceSettings windowIsNarrow={false} />);
    const below = screen.getByRole('button', { name: /Below the list/ });
    fireEvent.click(below);
    expect(useSettingsStore.getState().layoutMode).toBe('two-column');
    expect(below.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /Bubbles/ }));
    fireEvent.click(screen.getByRole('button', { name: /Single line/ }));
    expect(useSettingsStore.getState().sidebarStyle).toBe('tagcloud');
    expect(useSettingsStore.getState().emailListStyle).toBe('default');
  });

  it('explains inactive chat settings without discarding the saved email layout', () => {
    render(<WorkspaceSettings windowIsNarrow={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    const below = screen.getByRole('button', { name: /Below the list/ });
    expect(below.disabled).toBe(true);
    fireEvent.click(below);
    expect(useSettingsStore.getState().layoutMode).toBe('three-column');
    expect(screen.getAllByText(/Chat uses its own conversation layout/).length).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Email' }));
    expect(below.disabled).toBe(false);
  });
});
