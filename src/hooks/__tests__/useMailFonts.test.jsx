// @vitest-environment jsdom
// A mail frame downloads the Google Fonts its mail chose unless something says
// no: tracker blocking, or the user asking before external content loads.
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const fonts = vi.hoisted(() => ({ attachMailFonts: vi.fn(() => () => {}) }));
vi.mock('../../services/fontService', () => fonts);

const { useSettingsStore } = await import('../../stores/settingsStore');
const { useMailFonts } = await import('../useMailFonts');

afterEach(() => useSettingsStore.setState({ holdExternalContent: false }));

describe('useMailFonts', () => {
  it('asks the live setting whether a mail may download a font', () => {
    renderHook(() => {
      const frame = useRef(document.createElement('iframe'));
      useMailFonts(frame);
    });
    const { blocking } = fonts.attachMailFonts.mock.calls[0][1];
    expect(blocking()).toBe(false);
    useSettingsStore.setState({ holdExternalContent: true });
    expect(blocking()).toBe(true);
  });
});
