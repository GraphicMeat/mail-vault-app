// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const stubCanvas = () => ({ width: 200, height: 300 });
const buildSocialContent = vi.fn(async () => stubCanvas());
const buildSocialExport = vi.fn(async () => ({ ok: true, file: { name: 'x - social.png', base64: 'AAAA' }, canvas: stubCanvas() }));
const composeSocialImage = vi.fn(() => stubCanvas());
const saveOneFile = vi.fn(async () => ({ path: '/tmp/x.png', failed: [] }));
const setSocialExport = vi.fn();

vi.mock('../../../services/export/social/buildSocialExport', () => ({
  buildSocialContent: (...a) => buildSocialContent(...a),
  buildSocialExport: (...a) => buildSocialExport(...a),
  effectiveTheme: (content, theme) => (content === 'app' && theme === 'dark' ? 'dark' : 'light'),
}));
vi.mock('../../../services/export/social/composeSocialImage', () => ({
  composeSocialImage: (...a) => composeSocialImage(...a),
}));
vi.mock('../../../services/export/exportSaver', () => ({
  saveOneFile: (...a) => saveOneFile(...a),
}));

const DEFAULT_SOCIAL_EXPORT = {
  content: 'card', size: 'auto', background: { type: 'gradient', id: 'sunset' },
  padding: 64, radius: 16, shadow: true, chrome: true, theme: 'light',
};
// Saved by an earlier session: a style, and a stray redact:false that must not win.
let settingsState;
vi.mock('../../../stores/settingsStore', () => ({
  hasPremiumAccess: () => true,
  DEFAULT_SOCIAL_EXPORT: {
    content: 'card', size: 'auto', background: { type: 'gradient', id: 'sunset' },
    padding: 64, radius: 16, shadow: true, chrome: true, theme: 'light',
  },
  useSettingsStore: (sel) => sel(settingsState),
}));

import { SocialExportPanel } from '../SocialExportPanel';
import { SIZE_PRESETS } from '../../../services/export/social/socialLayout';
import { FIXTURE_MESSAGE } from '../../../test/privacyFixtures';

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
afterEach(() => { cleanup(); getContext.mockRestore(); vi.unstubAllGlobals(); });

const renderPanel = (props = {}) => render(<SocialExportPanel message={FIXTURE_MESSAGE} onDone={() => {}} {...props} />);
const lastCompose = () => composeSocialImage.mock.calls.at(-1)[0];

describe('SocialExportPanel', () => {
  it('opens with redaction on, whatever was saved, and builds redacted content', async () => {
    renderPanel();
    expect(screen.getByRole('checkbox', { name: /redact sensitive info/i }).checked).toBe(true);
    await waitFor(() => expect(buildSocialContent).toHaveBeenCalled());
    expect(buildSocialContent.mock.calls[0][1]).toMatchObject({ content: 'card', redact: true, theme: 'light' });
    await waitFor(() => expect(composeSocialImage).toHaveBeenCalled());
    expect(lastCompose()).toMatchObject({ size: SIZE_PRESETS.square, fit: 'crop' });
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

  it('offers Dark only for the app window', async () => {
    renderPanel();
    expect(screen.getByRole('button', { name: /^dark$/i }).disabled).toBe(true);
    expect(screen.getByText(/dark is available for app window/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /app window/i }));
    expect(screen.getByRole('button', { name: /^dark$/i }).disabled).toBe(false);
    await waitFor(() => expect(buildSocialContent.mock.calls.at(-1)[1]).toMatchObject({ content: 'app' }));
  });
});
