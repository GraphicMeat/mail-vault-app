// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const openInBrowser = vi.fn(() => Promise.resolve(true));
vi.mock('../../../services/billingApi', () => ({ openInBrowser: (url) => openInBrowser(url) }));
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: () => ({ setOnboardingComplete: vi.fn() }),
}));

import { HelpSettings } from '../HelpSettings';

afterEach(() => { cleanup(); openInBrowser.mockClear(); });

// jsdom's import.meta.url is not a file: URL — resolve from the vitest root.
const mainRs = readFileSync('src-tauri/src/main.rs', 'utf8');

describe('Help & Support product links', () => {
  it('opens the live website, not the dead mailvault.app domain', () => {
    render(<HelpSettings onClose={() => {}} onReportBug={() => {}} />);
    const row = screen.getByTestId('settings-link-website');
    const button = row.querySelector('button');
    expect(button.dataset.url).toBe('https://mailvaultapp.com');
    fireEvent.click(button);
    expect(openInBrowser).toHaveBeenCalledWith('https://mailvaultapp.com');
  });

  it('offers the GraphicMeat catalogue so people can find the other products', () => {
    render(<HelpSettings onClose={() => {}} onReportBug={() => {}} />);
    const row = screen.getByTestId('settings-link-more-apps');
    expect(row.textContent).toMatch(/GraphicMeat/);
    const button = row.querySelector('button');
    expect(button.dataset.url).toBe('https://graphicmeat.com');
    fireEvent.click(button);
    expect(openInBrowser).toHaveBeenCalledWith('https://graphicmeat.com');
  });

  // The native Help menu cannot be driven from a webview test, so guard its
  // URLs at the source: mailvault.app is offline and must never come back.
  it('keeps the native Help menu on the same two live URLs', () => {
    expect(mainRs).not.toMatch(/https:\/\/mailvault\.app\b/);
    expect(mainRs).toContain('.open("https://mailvaultapp.com"');
    expect(mainRs).toContain('.open("https://graphicmeat.com"');
    expect(mainRs).toContain('"open_more_apps", "More Apps by GraphicMeat"');
  });
});
