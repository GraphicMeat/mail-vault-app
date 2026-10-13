// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { registerBodyRenderer, useAltBodyRenderer, BodyRendererSettingsSlot, _resetBodyRenderersForTest } from '../bodyRendererRegistry';

const Body = () => <div>alt body</div>;
const Row = () => <div>alt row</div>;

afterEach(() => { cleanup(); _resetBodyRenderersForTest(); useSettingsStore.setState({ emailRenderer: 'web' }); });

describe('bodyRendererRegistry', () => {
  it('returns null with nothing registered, whatever the setting says', () => {
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    const { result } = renderHook(() => useAltBodyRenderer('reader'));
    expect(result.current).toBeNull();
  });
  it('returns null on web even when a renderer is registered', () => {
    registerBodyRenderer('blitz', { Body, SettingsRow: Row });
    const { result } = renderHook(() => useAltBodyRenderer('reader'));
    expect(result.current).toBeNull();
  });
  it('returns the registered Body when the setting names it, and follows the setting live', () => {
    registerBodyRenderer('blitz', { Body, SettingsRow: Row });
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    const { result } = renderHook(() => useAltBodyRenderer('reader'));
    expect(result.current).toBe(Body);
    act(() => useSettingsStore.getState().setEmailRenderer('web'));
    expect(result.current).toBeNull();
  });
  it('the settings slot renders registered rows and nothing otherwise', () => {
    const { container } = render(<BodyRendererSettingsSlot />);
    expect(container.textContent).toBe('');
    cleanup();
    registerBodyRenderer('blitz', { Body, SettingsRow: Row });
    render(<BodyRendererSettingsSlot />);
    expect(screen.getByText('alt row')).toBeTruthy();
  });
});
