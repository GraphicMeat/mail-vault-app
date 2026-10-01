// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';

const stubCanvas = () => ({ width: 200, height: 300 });
const buildSocialContent = vi.fn(async () => stubCanvas());
const buildSocialExport = vi.fn(async () => ({ ok: true, file: { name: 'x - social.png', base64: 'AAAA' }, canvas: stubCanvas() }));
const composeSocialImage = vi.fn(() => stubCanvas());
const saveOneFile = vi.fn(async () => ({ path: '/tmp/x.png', failed: [] }));
const setSocialExport = vi.fn();

vi.mock('../../../services/export/social/buildSocialExport', () => ({
  buildSocialContent: (...a) => buildSocialContent(...a),
  buildSocialExport: (...a) => buildSocialExport(...a),
  chromeTheme: (content, appTheme) => (content === 'app' && appTheme === 'dark' ? 'dark' : 'light'),
}));
vi.mock('../../../services/export/social/composeSocialImage', () => ({
  composeSocialImage: (...a) => composeSocialImage(...a),
}));
vi.mock('../../../services/export/exportSaver', () => ({
  saveOneFile: (...a) => saveOneFile(...a),
}));

const DEFAULT_SOCIAL_EXPORT = {
  content: 'card', size: 'auto', background: { type: 'gradient', id: 'sunset' },
  padding: 64, radius: 16, shadow: true, chrome: true,
};
// Saved by an earlier session: a style, and a stray redact:false that must not win.
let settingsState;
vi.mock('../../../stores/settingsStore', () => ({
  hasPremiumAccess: () => true,
  DEFAULT_SOCIAL_EXPORT: {
    content: 'card', size: 'auto', background: { type: 'gradient', id: 'sunset' },
    padding: 64, radius: 16, shadow: true, chrome: true,
  },
  useSettingsStore: (sel) => sel(settingsState),
}));

import { SocialExportPanel } from '../SocialExportPanel';
import { SIZE_PRESETS } from '../../../services/export/social/socialLayout';
import { FIXTURE_MESSAGE } from '../../../test/privacyFixtures';
import { usePrivacyStore } from '../../../stores/privacyStore';
import { useThemeStore } from '../../../stores/themeStore';

let getContext;
beforeEach(() => {
  settingsState = {
    socialExport: { ...DEFAULT_SOCIAL_EXPORT, size: 'square', redact: false },
    setSocialExport, billingProfile: { hasSubscription: true }, localeEpoch: 0,
  };
  [buildSocialContent, buildSocialExport, composeSocialImage, saveOneFile, setSocialExport].forEach(m => m.mockClear());
  getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect() {}, drawImage() {} });
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 50, height: 50, close: vi.fn() })));
});
afterEach(() => {
  cleanup(); getContext.mockRestore(); vi.unstubAllGlobals();
  usePrivacyStore.setState({ enabled: false });
  useThemeStore.setState({ theme: 'dark' });
});

const renderPanel = (props = {}) => render(<SocialExportPanel message={FIXTURE_MESSAGE} onDone={() => {}} {...props} />);
const lastCompose = () => composeSocialImage.mock.calls.at(-1)[0];

describe('SocialExportPanel', () => {
  it('opens with redaction on, whatever was saved, and builds redacted content', async () => {
    renderPanel();
    expect(screen.getByRole('checkbox', { name: /redact sensitive info/i }).checked).toBe(true);
    await waitFor(() => expect(buildSocialContent).toHaveBeenCalled());
    expect(buildSocialContent.mock.calls[0][1]).toEqual({ content: 'card', redact: true });
    await waitFor(() => expect(composeSocialImage).toHaveBeenCalled());
    // The preview composes at preview size; only Save renders full size.
    expect(lastCompose()).toMatchObject({ size: SIZE_PRESETS.square, fit: 'crop', maxSize: { w: 720, h: 840 } });
  });

  it('re-composes at 9:16 from the cached content, and remembers the size', async () => {
    renderPanel();
    await waitFor(() => expect(composeSocialImage).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '9:16' }));
    await waitFor(() => expect(lastCompose().size).toBe(SIZE_PRESETS.story));
    expect(buildSocialContent).toHaveBeenCalledTimes(1);
    expect(setSocialExport).toHaveBeenCalledWith({ size: 'story' });
  });

  it('saves a redacted PNG through the save dialog, then closes', async () => {
    const onDone = vi.fn();
    renderPanel({ onDone });
    const save = screen.getByRole('button', { name: /save png/i });
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(buildSocialExport.mock.calls[0][0].options).toMatchObject({ redact: true, size: 'square', content: 'card' });
    expect(saveOneFile).toHaveBeenCalledWith({ name: 'x - social.png', base64: 'AAAA' }, expect.any(String));
  });

  it('never stores the redact choice or an own image', async () => {
    const { container } = renderPanel();
    await waitFor(() => expect(composeSocialImage).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('checkbox', { name: /redact sensitive info/i }));
    await waitFor(() => expect(buildSocialContent.mock.calls.at(-1)[1]).toMatchObject({ redact: false }));
    const file = new File(['x'], 'bg.png', { type: 'image/png' });
    fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [file] } });
    await waitFor(() => expect(lastCompose().background.type).toBe('image'));
    fireEvent.click(screen.getByRole('button', { name: '9:16' }));
    await waitFor(() => expect(lastCompose().size).toBe(SIZE_PRESETS.story));
    expect(setSocialExport).toHaveBeenCalledWith({ size: 'story' });
    for (const [patch] of setSocialExport.mock.calls) {
      expect(patch).not.toHaveProperty('redact');
      expect(patch.background?.type).not.toBe('image');
    }
  });

  it('has no theme choice: the card is light, the app window frame follows the app theme', async () => {
    useThemeStore.setState({ theme: 'dark' });
    renderPanel();
    expect(screen.queryByRole('button', { name: /^dark$/i })).toBeNull();
    await waitFor(() => expect(composeSocialImage).toHaveBeenCalled());
    expect(lastCompose().theme).toBe('light');
    fireEvent.click(screen.getByRole('button', { name: /app window/i }));
    await waitFor(() => expect(buildSocialContent.mock.calls.at(-1)[1]).toEqual({ content: 'app', redact: true }));
    await waitFor(() => expect(lastCompose().theme).toBe('dark'));
    act(() => useThemeStore.setState({ theme: 'light' }));
    await waitFor(() => expect(lastCompose().theme).toBe('light'));
    // The theme is not part of the content: no second capture.
    expect(buildSocialContent).toHaveBeenCalledTimes(2);
  });

  it('names each background swatch', () => {
    renderPanel();
    for (const name of ['Sunset', 'Midnight', 'White', 'Blush']) expect(screen.getByRole('button', { name })).toBeTruthy();
  });

  it('forces redaction on while privacy mode is on, and says why', async () => {
    usePrivacyStore.setState({ enabled: true });
    renderPanel();
    const box = screen.getByRole('checkbox', { name: /redact sensitive info/i });
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(screen.getByText(/always on while privacy mode is on/i)).toBeTruthy();
    const save = screen.getByRole('button', { name: /save png/i });
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(buildSocialExport).toHaveBeenCalled());
    expect(buildSocialExport.mock.calls[0][0].options.redact).toBe(true);
  });

  it('takes an unredacted preview down at once when privacy mode turns on', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('checkbox', { name: /redact sensitive info/i }));
    fireEvent.click(screen.getByRole('button', { name: /app window/i }));
    await waitFor(() => expect(buildSocialContent.mock.calls.at(-1)[1]).toEqual({ content: 'app', redact: false }));
    await waitFor(() => expect(screen.getByRole('img', { name: /preview/i })).toBeTruthy());
    // Not cached yet: the redacted capture is still building when privacy turns on.
    buildSocialContent.mockImplementationOnce(() => new Promise(() => {}));
    act(() => usePrivacyStore.setState({ enabled: true }));
    expect(buildSocialContent.mock.calls.at(-1)[1]).toEqual({ content: 'app', redact: true });
    expect(screen.queryByRole('img', { name: /preview/i })).toBeNull();
  });
});
