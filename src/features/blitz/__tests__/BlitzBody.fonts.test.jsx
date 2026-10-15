// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

const order = vi.hoisted(() => []);
vi.mock('../BlitzTiles', () => ({
  default: React.forwardRef((p, _ref) => { order.push('tiles'); return <div data-testid="tiles-stub" />; }),
}));
vi.mock('../prepass/privacyDict', () => ({ usePrivacyDict: () => ({ active: false, dict: null, hold: false }) }));
vi.mock('../service', () => ({ fontsRender: vi.fn(async (f) => { order.push(`fonts:${f.join(',')}`); return { registered: f }; }) }));
vi.mock('../../../services/fontService', () => ({
  familyForMail: vi.fn().mockResolvedValue(true),
  refreshFonts: vi.fn().mockResolvedValue({}),
  useFontStore: { getState: () => ({ installed: ['Lora'] }) },
}));
import { familyForMail, refreshFonts } from '../../../services/fontService';
import BlitzBody from '../BlitzBody';
import { _resetDocRegistryForTest } from '../surfaces/docRegistry';

beforeEach(() => { order.length = 0; vi.clearAllMocks(); });
afterEach(() => { cleanup(); _resetDocRegistryForTest(); });

describe('BlitzBody mail fonts', () => {
  it('sends installed families before the tiles get the body, downloads the rest after', async () => {
    render(<BlitzBody surface="reader" messageKey="k-fonts" theme={{ dark: false, palette: 'graphite' }} onLink={vi.fn()} sizing="content"
      bodyHtml={'<p style="font-family: Lora">a</p><p style="font-family: Merriweather">b</p>'} plainText="a b" />);
    await screen.findByTestId('tiles-stub');
    await waitFor(() => expect(order).toContain('fonts:Merriweather'));
    expect(order.indexOf('fonts:Lora')).toBeLessThan(order.indexOf('tiles'));
    expect(order.indexOf('tiles')).toBeLessThan(order.indexOf('fonts:Merriweather'));
    expect(familyForMail).toHaveBeenCalledTimes(1);
  });

  it('a hanging fonts.list does not hold the body back', async () => {
    refreshFonts.mockImplementation(() => new Promise(() => {}));
    render(<BlitzBody surface="reader" messageKey="k-fonts-hang" theme={{ dark: false, palette: 'graphite' }} onLink={vi.fn()} sizing="content"
      bodyHtml={'<p style="font-family: Lora">a</p>'} plainText="a" />);
    await screen.findByTestId('tiles-stub', {}, { timeout: 1500 });
    refreshFonts.mockResolvedValue({});
  });
});
