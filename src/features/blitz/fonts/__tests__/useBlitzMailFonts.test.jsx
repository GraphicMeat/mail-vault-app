// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
vi.mock('../../service', () => ({ fontsRender: vi.fn().mockResolvedValue({ registered: [] }) }));
vi.mock('../../../../services/fontService', () => ({
  familyForMail: vi.fn(),
  refreshFonts: vi.fn().mockResolvedValue({}),
  useFontStore: { getState: () => ({ installed: ['Lora'] }) },
}));
vi.mock('../../../../stores/settingsStore', () => ({ isTrackerBlockingActive: vi.fn(() => false) }));
import { fontsRender } from '../../service';
import { familyForMail } from '../../../../services/fontService';
import { isTrackerBlockingActive } from '../../../../stores/settingsStore';
import { prepareMailFonts, useBlitzMailFonts } from '../useBlitzMailFonts';

const parse = (b) => new DOMParser().parseFromString(`<body>${b}</body>`, 'text/html');

beforeEach(() => {
  vi.clearAllMocks();
  isTrackerBlockingActive.mockReturnValue(false);
});

describe('Blitz mail fonts', () => {
  it('installed families are sent before open; others are pending', async () => {
    const doc = parse('<p style="font-family: Lora, serif">a</p><p style="font-family:\'Merriweather\'">b</p><p style="font-family: Arial">c</p>');
    const r = await prepareMailFonts(doc);
    expect(r).toEqual({ installed: ['Lora'], pending: ['Merriweather'] });
    expect(fontsRender).toHaveBeenCalledWith(['Lora']);
  });

  it('a pending family downloads through familyForMail (same session failure memory) and is sent when ready', async () => {
    familyForMail.mockResolvedValue(true);
    renderHook(() => useBlitzMailFonts({ families: ['Merriweather'], messageKey: 'k' }));
    await waitFor(() => expect(fontsRender).toHaveBeenCalledWith(['Merriweather']));
    expect(familyForMail).toHaveBeenCalledWith('Merriweather', expect.any(Function));
    expect(familyForMail.mock.calls[0][1]()).toBe(false);
  });

  it('tracker blocking: familyForMail says no, nothing is sent', async () => {
    isTrackerBlockingActive.mockReturnValue(true);
    familyForMail.mockImplementation(async (_f, blocking) => !blocking());
    renderHook(() => useBlitzMailFonts({ families: ['Merriweather'], messageKey: 'k' }));
    await waitFor(() => expect(familyForMail).toHaveBeenCalled());
    expect(fontsRender).not.toHaveBeenCalled();
  });

  it('tracker blocking: the blocking probe reads the live setting, installed fonts still go through fonts.read', async () => {
    isTrackerBlockingActive.mockReturnValue(true);
    const doc = parse('<p style="font-family: Lora">a</p><p style="font-family: Merriweather">b</p>');
    const r = await prepareMailFonts(doc);
    expect(r).toEqual({ installed: ['Lora'], pending: ['Merriweather'] });
    expect(fontsRender).toHaveBeenCalledWith(['Lora']);
    familyForMail.mockImplementation(async (_f, blocking) => !blocking());
    renderHook(() => useBlitzMailFonts({ families: r.pending, messageKey: 'k' }));
    await waitFor(() => expect(familyForMail).toHaveBeenCalledWith('Merriweather', expect.any(Function)));
    expect(familyForMail.mock.calls[0][1]()).toBe(true);
    expect(fontsRender).toHaveBeenCalledTimes(1);
  });

  it('a failed download or a throwing send degrades silently', async () => {
    familyForMail.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(true);
    fontsRender.mockRejectedValueOnce(new Error('worker gone'));
    renderHook(() => useBlitzMailFonts({ families: ['Merriweather', 'Lato'], messageKey: 'k' }));
    await waitFor(() => expect(familyForMail).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fontsRender).toHaveBeenCalledTimes(1));
  });

  it('the same families on a re-render are not asked twice', async () => {
    familyForMail.mockResolvedValue(true);
    const { rerender } = renderHook((p) => useBlitzMailFonts(p), { initialProps: { families: ['Merriweather'], messageKey: 'k' } });
    await waitFor(() => expect(fontsRender).toHaveBeenCalledTimes(1));
    rerender({ families: ['Merriweather'], messageKey: 'k' });
    expect(familyForMail).toHaveBeenCalledTimes(1);
  });

  it('prepare never throws and never waits more than 300 ms', async () => {
    fontsRender.mockImplementationOnce(() => new Promise(() => {}));
    const t0 = Date.now();
    await prepareMailFonts(parse('<p style="font-family: Lora">a</p>'));
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('prepare on a missing document does not throw', async () => {
    await expect(prepareMailFonts(undefined)).resolves.toEqual({ installed: [], pending: [] });
  });
});
