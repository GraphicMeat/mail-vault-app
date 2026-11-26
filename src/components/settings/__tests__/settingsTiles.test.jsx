// @vitest-environment jsdom
// The colour tile behind every settings navigation icon, drawn by the shared SettingsNavIcon in
// desktop's sidebar and the phone's first screen (the hues are settingsTileColors.test.js).
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Mail } from 'lucide-react';
import { SETTINGS_TILE_COLORS } from '../settingsManifest';
import { SettingsNavIcon } from '../../ui/SettingsNavIcon';
import { useMailStore } from '../../../stores/mailStore';
import { SettingsPage } from '../../SettingsPage';
import '../../../services/workflows/bindStoreActions';

vi.mock('../../../services/db', () => ({ getCachedMailboxes: async () => [], saveAccount: async () => {} }));

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
  useMailStore.setState({ accounts: [], activeAccountId: null });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('SettingsNavIcon', () => {
  it('draws the glyph on the entry\'s tile, hidden from assistive tech', () => {
    render(<SettingsNavIcon id="appearance" icon={Mail} />);
    const tile = document.querySelector('[data-settings-tile="appearance"]');
    expect(tile).toBeTruthy();
    expect(tile.getAttribute('aria-hidden')).toBe('true');
    expect(tile.style.getPropertyValue('--settings-tile')).toBe(SETTINGS_TILE_COLORS.appearance);
    expect(tile.querySelector('svg')).toBeTruthy();
  });
});

describe('desktop settings sidebar', () => {
  it('puts a tile behind every navigation icon', () => {
    render(<SettingsPage onClose={() => {}} />);
    const items = [...screen.getByRole('navigation', { name: 'Settings' }).querySelectorAll('.settings-nav-item')];
    expect(items.length).toBeGreaterThan(10);
    for (const item of items) expect(item.querySelector('[data-settings-tile]'), item.textContent).toBeTruthy();
  });
});
