// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor, act, within } from '@testing-library/react';

const stubCanvas = () => ({ width: 200, height: 300 });
const buildSocialContent = vi.fn(async () => stubCanvas());
const buildSocialExport = vi.fn(async () => ({ ok: true, file: { name: 'x - social.png', base64: 'AAAA' }, canvas: stubCanvas() }));
const composeSocialImage = vi.fn(() => stubCanvas());
const saveOneFile = vi.fn(async () => ({ path: '/tmp/x.png', failed: [] }));
const setSocialExport = vi.fn();
const isSpam = vi.hoisted(() => vi.fn(() => false));
vi.mock('../../../utils/spamFolder', () => ({ isSpamMessage: (...a) => isSpam(...a) }));
vi.mock('../../../stores/mailStore', () => ({ useMailStore: { getState: () => ({}) } }));

vi.mock('../../../services/export/social/buildSocialExport', () => ({
  buildSocialContent: (...a) => buildSocialContent(...a),
  buildSocialExport: (...a) => buildSocialExport(...a),
  chromeTheme: (_content, appTheme) => (appTheme === 'dark' ? 'dark' : 'light'),
}));
vi.mock('../../../services/export/social/composeSocialImage', () => ({
  composeSocialImage: (...a) => composeSocialImage(...a),
}));
const MARK = { icon: { naturalWidth: 256, naturalHeight: 256 }, mark: { naturalWidth: 478, naturalHeight: 84 } };
vi.mock('../../../services/export/social/socialWatermark', () => ({ loadWatermark: async () => MARK }));
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
    padding: 64, radius: 16, shadow: true, chrome: true, senderDetails: false, links: false, appTheme: null, mailTheme: null,
  },
  useSettingsStore: (sel) => sel(settingsState),
}));

import { SocialExportPanel } from '../SocialExportPanel';
import { SIZE_PRESETS, rangeMarkLeft } from '../../../services/export/social/socialLayout';
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
  isSpam.mockReset();
  isSpam.mockReturnValue(false);
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
    expect(buildSocialContent.mock.calls[0][1]).toEqual({ content: 'card', redact: true, theme: 'dark', mailTheme: 'dark', width: 820 });
    await waitFor(() => expect(composeSocialImage).toHaveBeenCalled());
    // The preview composes at the size it is shown (a 2160px square fitted
    // into the 360x420 box); only Save renders full size.
    expect(lastCompose()).toMatchObject({ size: SIZE_PRESETS.square, theme: 'dark', maxSize: { w: 360, h: 360 } });
    expect(lastCompose()).not.toHaveProperty('fit');
  });

  it('the preview carries the maker\'s lockup once it has loaded', async () => {
    renderPanel();
    await waitFor(() => expect(lastCompose()?.watermark).toBe(MARK));
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

  it('the frame follows the Appearance for the card and the app window alike', async () => {
    useThemeStore.setState({ theme: 'dark' });
    renderPanel();
    await waitFor(() => expect(composeSocialImage).toHaveBeenCalled());
    expect(lastCompose().theme).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: /app window/i }));
    await waitFor(() => expect(buildSocialContent.mock.calls.at(-1)[1]).toEqual({ content: 'app', redact: true, theme: 'dark' }));
    await waitFor(() => expect(lastCompose().theme).toBe('dark'));
    act(() => useThemeStore.setState({ theme: 'light' }));
    await waitFor(() => expect(lastCompose().theme).toBe('light'));
    // Following the app: a new app theme is a different shot.
    expect(buildSocialContent.mock.calls.at(-1)[1]).toEqual({ content: 'app', redact: true, theme: 'light' });
  });

  it('shows Appearance for both contents, preselected to the app theme, and Mail for the card only', async () => {
    useThemeStore.setState({ theme: 'dark' });
    renderPanel();
    const appearance = await screen.findByRole('group', { name: /appearance/i });
    expect(appearance.querySelector('[aria-pressed="true"]').textContent).toBe('Dark');
    expect(appearance.querySelectorAll('button')).toHaveLength(2);
    const mail = screen.getByRole('group', { name: /email content/i });
    expect(mail.querySelector('[aria-pressed="true"]').textContent).toBe('Dark'); // follows the Appearance
    expect(mail.querySelectorAll('button')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /app window/i }));
    expect(screen.getByRole('group', { name: /appearance/i })).toBeTruthy();
    expect(screen.queryByRole('group', { name: /email content/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /email card/i }));
    expect(screen.getByRole('group', { name: /email content/i })).toBeTruthy();
  });

  it('Mail follows the Appearance until picked, then stays: dark appearance over a light mail', async () => {
    useThemeStore.setState({ theme: 'light' });
    renderPanel();
    await waitFor(() => expect(buildSocialContent).toHaveBeenCalled());
    expect(buildSocialContent.mock.calls[0][1]).toEqual({ content: 'card', redact: true, theme: 'light', mailTheme: 'light', width: 820 });
    // Picking Dark Appearance drags the unpicked Mail along.
    fireEvent.click(within(screen.getByRole('group', { name: /appearance/i })).getByRole('button', { name: /^dark$/i }));
    await waitFor(() => expect(buildSocialContent.mock.calls.at(-1)[1]).toEqual({ content: 'card', redact: true, theme: 'dark', mailTheme: 'dark', width: 820 }));
    expect(setSocialExport).toHaveBeenCalledWith({ appTheme: 'dark' });
    // Mail Light: a picked Mail holds still.
    fireEvent.click(within(screen.getByRole('group', { name: /email content/i })).getByRole('button', { name: /^light$/i }));
    await waitFor(() => expect(buildSocialContent.mock.calls.at(-1)[1]).toEqual({ content: 'card', redact: true, theme: 'dark', mailTheme: 'light', width: 820 }));
    expect(setSocialExport).toHaveBeenCalledWith({ mailTheme: 'light' });
    await waitFor(() => expect(lastCompose().theme).toBe('dark')); // the frame stays on the Appearance
    const before = buildSocialContent.mock.calls.length;
    fireEvent.click(within(screen.getByRole('group', { name: /appearance/i })).getByRole('button', { name: /^light$/i }));
    // Light over light was the first build: served from the cache, not built again.
    await waitFor(() => expect(lastCompose().theme).toBe('light'));
    expect(buildSocialContent).toHaveBeenCalledTimes(before);
  });

  it('a card is rebuilt per Appearance and Mail pair; the app window ignores Mail', async () => {
    useThemeStore.setState({ theme: 'light' });
    renderPanel();
    await waitFor(() => expect(buildSocialContent).toHaveBeenCalledTimes(1));
    fireEvent.click(within(screen.getByRole('group', { name: /email content/i })).getByRole('button', { name: /^dark$/i }));
    await waitFor(() => expect(buildSocialContent).toHaveBeenCalledTimes(2));
    expect(buildSocialContent.mock.calls[1][1]).toMatchObject({ theme: 'light', mailTheme: 'dark' });
    fireEvent.click(screen.getByRole('button', { name: /app window/i }));
    await waitFor(() => expect(buildSocialContent).toHaveBeenCalledTimes(3));
    expect(buildSocialContent.mock.calls[2][1]).not.toHaveProperty('mailTheme');
  });

  it('picking Light shoots the app window again in light, and remembers it', async () => {
    useThemeStore.setState({ theme: 'dark' });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /app window/i }));
    await waitFor(() => expect(buildSocialContent.mock.calls.at(-1)[1]).toMatchObject({ content: 'app', theme: 'dark' }));
    const before = buildSocialContent.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /^light$/i }));
    await waitFor(() => expect(buildSocialContent).toHaveBeenCalledTimes(before + 1));
    expect(buildSocialContent.mock.calls.at(-1)[1]).toEqual({ content: 'app', redact: true, theme: 'light' });
    expect(setSocialExport).toHaveBeenCalledWith({ appTheme: 'light' });
    await waitFor(() => expect(lastCompose().theme).toBe('light'));
    // Back to the first theme: served from the cache, not captured a third time.
    fireEvent.click(screen.getByRole('button', { name: /^dark$/i }));
    await waitFor(() => expect(lastCompose().theme).toBe('dark'));
    expect(buildSocialContent).toHaveBeenCalledTimes(before + 1);
  });

  it('saves with the picked appearance, and a saved choice wins over the app theme', async () => {
    settingsState.socialExport = { ...settingsState.socialExport, content: 'app', appTheme: 'light' };
    useThemeStore.setState({ theme: 'dark' });
    renderPanel();
    await waitFor(() => expect(buildSocialContent).toHaveBeenCalled());
    expect(buildSocialContent.mock.calls[0][1]).toMatchObject({ content: 'app', theme: 'light' });
    const save = screen.getByRole('button', { name: /save png/i });
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(buildSocialExport).toHaveBeenCalled());
    expect(buildSocialExport.mock.calls[0][0].options).toMatchObject({ content: 'app', appTheme: 'light' });
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
    await waitFor(() => expect(buildSocialContent.mock.calls.at(-1)[1]).toEqual({ content: 'app', redact: false, theme: 'dark' }));
    await waitFor(() => expect(screen.getByRole('img', { name: /preview/i })).toBeTruthy());
    // Not cached yet: the redacted capture is still building when privacy turns on.
    buildSocialContent.mockImplementationOnce(() => new Promise(() => {}));
    act(() => usePrivacyStore.setState({ enabled: true }));
    expect(buildSocialContent.mock.calls.at(-1)[1]).toEqual({ content: 'app', redact: true, theme: 'dark' });
    expect(screen.queryByRole('img', { name: /preview/i })).toBeNull();
  });

  describe('Show sender, Sender details, Links and the macOS corner tick', () => {
    const toggle = (name) => screen.getByRole('switch', { name });
    const lastOptions = () => buildSocialContent.mock.calls.at(-1)[1];

    it('Show sender starts on for a message in the spam folder, off for any other, and is never stored', async () => {
      isSpam.mockReturnValue(true);
      renderPanel();
      expect(isSpam.mock.calls[0][0]).toBe(FIXTURE_MESSAGE);
      expect(toggle('Show sender').getAttribute('aria-checked')).toBe('true');
      expect(screen.getByText(/keeps the spam sender's address visible/i)).toBeTruthy();
      await waitFor(() => expect(buildSocialContent).toHaveBeenCalled());
      expect(buildSocialContent.mock.calls[0][1]).toEqual({ content: 'card', redact: true, theme: 'dark', mailTheme: 'dark', width: 820, revealSender: true });
      cleanup();
      isSpam.mockReturnValue(false);
      buildSocialContent.mockClear();
      renderPanel();
      expect(toggle('Show sender').getAttribute('aria-checked')).toBe('false');
      await waitFor(() => expect(buildSocialContent).toHaveBeenCalled());
      expect(buildSocialContent.mock.calls[0][1]).not.toHaveProperty('revealSender');
      fireEvent.click(toggle('Show sender'));
      for (const [patch] of setSocialExport.mock.calls) expect(patch).not.toHaveProperty('revealSender');
    });

    it('is offered whenever the image is redacted, including by privacy mode, and not otherwise', async () => {
      renderPanel();
      expect(screen.getByRole('switch', { name: 'Show sender' })).toBeTruthy();
      fireEvent.click(screen.getByRole('checkbox', { name: /redact sensitive info/i }));
      expect(screen.queryByRole('switch', { name: 'Show sender' })).toBeNull();
      cleanup();
      usePrivacyStore.setState({ enabled: true });
      renderPanel();
      expect(screen.getByRole('switch', { name: 'Show sender' })).toBeTruthy();
    });

    it('turning it off rebuilds without the reveal and never serves the revealed canvas; turning it on again hits the cache', async () => {
      isSpam.mockReturnValue(true);
      const revealed = { width: 200, height: 300, tag: 'revealed' };
      const masked = { width: 200, height: 300, tag: 'masked' };
      buildSocialContent.mockResolvedValueOnce(revealed).mockResolvedValueOnce(masked);
      renderPanel();
      await waitFor(() => expect(composeSocialImage.mock.calls.at(-1)?.[0].content).toBe(revealed));
      fireEvent.click(toggle('Show sender'));
      await waitFor(() => expect(buildSocialContent).toHaveBeenCalledTimes(2));
      expect(lastOptions()).not.toHaveProperty('revealSender');
      await waitFor(() => expect(lastCompose().content).toBe(masked));
      fireEvent.click(toggle('Show sender'));
      await waitFor(() => expect(lastCompose().content).toBe(revealed));
      expect(buildSocialContent).toHaveBeenCalledTimes(2); // cached
      // Redaction off and on again must not keep the reveal around either.
      fireEvent.click(screen.getByRole('checkbox', { name: /redact sensitive info/i }));
      await waitFor(() => expect(lastOptions()).toMatchObject({ redact: false }));
      expect(lastOptions()).not.toHaveProperty('revealSender');
    });

    it('saves with the reveal when it is on and redacting, and without when redaction is off', async () => {
      isSpam.mockReturnValue(true);
      renderPanel();
      const save = screen.getByRole('button', { name: /save png/i });
      await waitFor(() => expect(save.disabled).toBe(false));
      fireEvent.click(save);
      await waitFor(() => expect(buildSocialExport).toHaveBeenCalled());
      expect(buildSocialExport.mock.calls[0][0].options).toMatchObject({ redact: true, revealSender: true });
      buildSocialExport.mockClear();
      fireEvent.click(screen.getByRole('checkbox', { name: /redact sensitive info/i }));
      await waitFor(() => expect(save.disabled).toBe(false));
      fireEvent.click(save);
      await waitFor(() => expect(buildSocialExport).toHaveBeenCalled());
      expect(buildSocialExport.mock.calls[0][0].options).toMatchObject({ redact: false, revealSender: false });
    });

    it('Sender details is remembered, builds the box, and is offered for the card and the app window', async () => {
      renderPanel();
      await waitFor(() => expect(buildSocialContent).toHaveBeenCalledTimes(1));
      expect(toggle('Sender details').getAttribute('aria-checked')).toBe('false');
      fireEvent.click(toggle('Sender details'));
      expect(setSocialExport).toHaveBeenCalledWith({ senderDetails: true });
      await waitFor(() => expect(buildSocialContent).toHaveBeenCalledTimes(2));
      expect(lastOptions()).toMatchObject({ content: 'card', senderDetails: true });
      fireEvent.click(screen.getByRole('button', { name: /app window/i }));
      await waitFor(() => expect(lastOptions()).toMatchObject({ content: 'app', senderDetails: true }));
      expect(toggle('Sender details').getAttribute('aria-checked')).toBe('true');
    });

    it('Links is a card-only toggle, remembered, and its option never reaches the app window', async () => {
      settingsState.socialExport = { ...settingsState.socialExport, links: true };
      renderPanel();
      expect(toggle('Links').getAttribute('aria-checked')).toBe('true');
      await waitFor(() => expect(buildSocialContent).toHaveBeenCalled());
      expect(buildSocialContent.mock.calls[0][1]).toMatchObject({ content: 'card', links: true });
      fireEvent.click(toggle('Links'));
      expect(setSocialExport).toHaveBeenCalledWith({ links: false });
      fireEvent.click(toggle('Links'));
      fireEvent.click(screen.getByRole('button', { name: /app window/i }));
      expect(screen.queryByRole('switch', { name: 'Links' })).toBeNull();
      await waitFor(() => expect(lastOptions().content).toBe('app'));
      expect(lastOptions()).not.toHaveProperty('links');
      fireEvent.click(screen.getByRole('button', { name: /email card/i }));
      expect(screen.getByRole('switch', { name: 'Links' })).toBeTruthy();
    });

    it('a different Links or Sender details choice is a different render, not the cached one', async () => {
      renderPanel();
      await waitFor(() => expect(buildSocialContent).toHaveBeenCalledTimes(1));
      fireEvent.click(toggle('Links'));
      await waitFor(() => expect(buildSocialContent).toHaveBeenCalledTimes(2));
      fireEvent.click(toggle('Links'));
      await waitFor(() => expect(lastCompose()).toBeTruthy());
      expect(buildSocialContent).toHaveBeenCalledTimes(2); // links off again: the first render, cached
    });

    it('the Radius slider spans 0 to 40 and a macOS tick under it sets the macOS window radius, 12', async () => {
      renderPanel();
      const slider = screen.getByRole('slider', { name: 'Corners' });
      expect([slider.min, slider.max]).toEqual(['0', '40']);
      expect(slider.value).toBe('16');
      const tick = screen.getByRole('button', { name: /macos window corner radius/i });
      expect(tick.textContent).toBe('macOS');
      fireEvent.click(tick);
      expect(setSocialExport).toHaveBeenCalledWith({ radius: 12 });
      await waitFor(() => expect(lastCompose().radius).toBe(12));
      expect(screen.getByRole('slider', { name: 'Corners' }).value).toBe('12');
    });

    it('the tick sits where the thumb centre is at 12 of 0..40 (16px thumb)', () => {
      expect(rangeMarkLeft(12, 0, 40)).toBe('calc(8px + 0.3 * (100% - 16px))');
      expect(rangeMarkLeft(0, 0, 40)).toBe('calc(8px + 0 * (100% - 16px))');
      expect(rangeMarkLeft(40, 0, 40)).toBe('calc(8px + 1 * (100% - 16px))');
    });
  });

  describe('Email width', () => {
    const slider = () => screen.getByRole('slider', { name: 'Email width' });

    it('is a card-only slider, 480 to 1600 in steps of 20, at the export column by default', async () => {
      renderPanel();
      expect([slider().min, slider().max, slider().step, slider().value]).toEqual(['480', '1600', '20', '820']);
      expect(screen.getByText('820px')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /app window/i }));
      expect(screen.queryByRole('slider', { name: 'Email width' })).toBeNull();
    });

    it('moves at once, remembers the width, and renders the card once the slider rests', async () => {
      renderPanel();
      await waitFor(() => expect(buildSocialContent).toHaveBeenCalledTimes(1));
      fireEvent.change(slider(), { target: { value: '1000' } });
      fireEvent.change(slider(), { target: { value: '1200' } });
      expect(slider().value).toBe('1200');
      expect(screen.getByText('1200px')).toBeTruthy();
      expect(setSocialExport).toHaveBeenLastCalledWith({ width: 1200 });
      // Save waits for the render at the new width.
      expect(screen.getByRole('button', { name: /save png/i }).disabled).toBe(true);
      expect(buildSocialContent).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(buildSocialContent).toHaveBeenCalledTimes(2));
      expect(buildSocialContent.mock.calls[1][1]).toMatchObject({ content: 'card', width: 1200 });
      const save = screen.getByRole('button', { name: /save png/i });
      await waitFor(() => expect(save.disabled).toBe(false));
      fireEvent.click(save);
      await waitFor(() => expect(buildSocialExport).toHaveBeenCalled());
      expect(buildSocialExport.mock.calls[0][0].options).toMatchObject({ width: 1200 });
    });

    it('a width rendered before comes from the cache', async () => {
      renderPanel();
      await waitFor(() => expect(buildSocialContent).toHaveBeenCalledTimes(1));
      fireEvent.change(slider(), { target: { value: '1200' } });
      await waitFor(() => expect(buildSocialContent).toHaveBeenCalledTimes(2));
      fireEvent.change(slider(), { target: { value: '820' } });
      await waitFor(() => expect(screen.getByRole('button', { name: /save png/i }).disabled).toBe(false));
      expect(buildSocialContent).toHaveBeenCalledTimes(2);
    });

    it('keeps only the last few renders: an old width is rendered again', async () => {
      renderPanel();
      await waitFor(() => expect(buildSocialContent).toHaveBeenCalledTimes(1));
      for (const [i, w] of ['900', '1000', '1100', '1200'].entries()) {
        fireEvent.change(slider(), { target: { value: w } });
        await waitFor(() => expect(buildSocialContent).toHaveBeenCalledTimes(i + 2));
      }
      fireEvent.change(slider(), { target: { value: '820' } });
      await waitFor(() => expect(buildSocialContent).toHaveBeenCalledTimes(6));
      expect(buildSocialContent.mock.calls[5][1]).toMatchObject({ width: 820 });
    });
  });

  describe('zoom', () => {
    it('fits by default, shows actual pixels at 100%, and steps between', async () => {
      renderPanel();
      await waitFor(() => expect(lastCompose().maxSize).toEqual({ w: 360, h: 360 }));
      expect(screen.getByRole('status').textContent).toBe('17%');
      expect(screen.getByRole('button', { name: 'Fit' }).getAttribute('aria-pressed')).toBe('true');

      fireEvent.click(screen.getByRole('button', { name: /actual pixels/i }));
      await waitFor(() => expect(lastCompose().maxSize).toEqual({ w: 2160, h: 2160 }));
      expect(screen.getByRole('status').textContent).toBe('100%');
      expect(screen.getByRole('img', { name: 'Preview' }).style.width).toBe('2160px');

      fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
      await waitFor(() => expect(lastCompose().maxSize).toEqual({ w: 1620, h: 1620 }));
      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
      await waitFor(() => expect(screen.getByRole('status').textContent).toBe('150%'));

      fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
      await waitFor(() => expect(lastCompose().maxSize).toEqual({ w: 360, h: 360 }));
    });
  });

  describe('in a window of its own', () => {
    it('hands its choices over when popped out', async () => {
      const onPopOut = vi.fn();
      renderPanel({ onPopOut });
      fireEvent.click(screen.getByRole('checkbox', { name: /redact sensitive info/i }));
      fireEvent.click(screen.getByRole('button', { name: /open in window/i }));
      expect(onPopOut).toHaveBeenCalledWith(expect.objectContaining({ redact: false, revealSender: false, prefs: expect.objectContaining({ size: 'square' }) }));
    });

    it('puts the window button in the header slot it is given, not the footer', async () => {
      const slot = document.createElement('div');
      document.body.appendChild(slot);
      const onPopOut = vi.fn();
      renderPanel({ onPopOut, headerSlot: slot });
      const button = within(slot).getByRole('button', { name: /open in window/i });
      expect(screen.getAllByRole('button', { name: /open in window/i })).toHaveLength(1);
      fireEvent.click(button);
      expect(onPopOut).toHaveBeenCalledWith(expect.objectContaining({ redact: true }));
      slot.remove();
    });

    it('shows no window button while its header slot is still mounting', () => {
      renderPanel({ onPopOut: vi.fn(), headerSlot: null });
      expect(screen.queryByRole('button', { name: /open in window/i })).toBeNull();
    });

    it('starts from the choices it was handed, renders and saves through its source', async () => {
      const content = stubCanvas();
      const source = { buildContent: vi.fn(async () => content), save: vi.fn(async () => ({ ok: true, file: { name: 'y - social.png', base64: 'BBBB' } })) };
      const onPrefsChange = vi.fn();
      const onPopIn = vi.fn();
      render(<SocialExportPanel detached source={source} onPrefsChange={onPrefsChange} onPopIn={onPopIn} onDone={() => {}}
        initial={{ redact: false, revealSender: true, prefs: { size: 'story' } }} />);
      await waitFor(() => expect(source.buildContent).toHaveBeenCalled());
      expect(buildSocialContent).not.toHaveBeenCalled();
      expect(source.buildContent.mock.calls[0][0]).toMatchObject({ content: 'card', redact: false });
      expect(screen.getByRole('checkbox', { name: /redact sensitive info/i }).checked).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: '1:1' }));
      expect(onPrefsChange).toHaveBeenCalledWith({ size: 'square' });
      expect(setSocialExport).not.toHaveBeenCalled();

      const save = screen.getByRole('button', { name: /save png/i });
      await waitFor(() => expect(save.disabled).toBe(false));
      fireEvent.click(save);
      await waitFor(() => expect(saveOneFile).toHaveBeenCalledWith({ name: 'y - social.png', base64: 'BBBB' }, expect.any(String)));
      expect(source.save).toHaveBeenCalledWith(expect.objectContaining({ size: 'square', redact: false }), content);
      expect(buildSocialExport).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: /back to app/i }));
      expect(onPopIn).toHaveBeenCalledWith(expect.objectContaining({ redact: false, revealSender: true }));
      expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    });
  });
});
