// @vitest-environment jsdom
// The Google Fonts picker and the Text settings that open it. The daemon is
// faked at its RPC and event edge; the fonts service in between is the real one.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const listeners = new Map();
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name, cb) => { listeners.set(name, cb); return () => listeners.delete(name); }),
}));
const daemonCall = vi.fn();
vi.mock('../../../services/daemonClient', () => ({ daemonCall: (...args) => daemonCall(...args) }));

import { GoogleFontPicker } from '../GoogleFontPicker';
import { AppearanceSettings } from '../AppearanceSettings';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useFontStore } from '../../../services/fontService';
import { t } from '../../../i18n';

let installed;
let downloadAnswer;
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));
  // The service wires its listeners once per module, like once per window.
  installed = ['Lora'];
  downloadAnswer = { state: 'downloading' };
  daemonCall.mockReset();
  daemonCall.mockImplementation(async (method, params) => {
    if (method === 'fonts.list') return { fonts: installed.map(family => ({ family })), downloading: [] };
    if (method === 'fonts.download') return { family: params.family, ...(installed.includes(params.family) ? { state: 'ready' } : downloadAnswer) };
    if (method === 'fonts.remove') { installed = installed.filter(f => f !== params.family); return { removed: true }; }
    return { family: params?.family, faces: [] };
  });
  useFontStore.setState({ installed: [], progress: {}, errors: {} });
  useSettingsStore.setState({ appFont: 'instrument-sans', textScale: 1 });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const fire = (name, payload) => act(() => { listeners.get(name)?.({ payload }); });
const row = family => screen.getByTestId(`google-font-${family}`);
const search = text => fireEvent.change(screen.getByRole('searchbox', { name: t('fonts.picker.search') }), { target: { value: text } });

describe('GoogleFontPicker', () => {
  function open(props = {}) {
    const onPick = vi.fn();
    render(<GoogleFontPicker open onClose={() => {}} onPick={onPick} {...props} />);
    return onPick;
  }

  it('searches the catalogue by name and filters by category, with no network for browsing', async () => {
    open();
    await waitFor(() => expect(within(row('Lora')).getByText(t('fonts.picker.downloaded'))).toBeTruthy());
    fireEvent.change(screen.getByRole('searchbox', { name: t('fonts.picker.search') }), { target: { value: 'rob' } });
    expect(screen.getByTestId('google-font-Roboto')).toBeTruthy();
    expect(screen.queryByTestId('google-font-Lora')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('fonts.category.mono') }));
    expect(screen.getAllByTestId(/^google-font-/).map(el => el.dataset.testid)).toEqual(['google-font-Roboto Mono']);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzzz' } });
    expect(screen.getByText(t('fonts.picker.noMatch'))).toBeTruthy();
    expect(daemonCall.mock.calls.map(([method]) => method)).toEqual(['fonts.list']);
  });

  it('keeps the rendered list short until a search narrows it', () => {
    open();
    expect(screen.getAllByTestId(/^google-font-/).length).toBeLessThanOrEqual(60);
    expect(screen.getByText(t('fonts.picker.narrow'))).toBeTruthy();
  });

  it('picks a downloaded family at once and draws it in its own face', async () => {
    const onPick = open();
    await waitFor(() => expect(within(row('Lora')).getByText(t('fonts.picker.downloaded'))).toBeTruthy());
    expect(row('Lora').querySelector('[data-font-name]').style.fontFamily).toContain('Lora');
    fireEvent.click(within(row('Lora')).getByRole('button', { name: /^Lora/ }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith('Lora'));
    expect(within(row('Lora')).queryByRole('status')).toBeNull();
  });

  it('downloads a family first, shows progress in its row, then picks it', async () => {
    const onPick = open();
    search('Pacifico');
    fireEvent.click(within(row('Pacifico')).getByRole('button', { name: /^Pacifico/ }));
    await waitFor(() => expect(daemonCall).toHaveBeenCalledWith('fonts.download', { family: 'Pacifico' }));
    expect(within(row('Pacifico')).getByRole('status').textContent).toContain(t('fonts.picker.downloading'));
    expect(onPick).not.toHaveBeenCalled();
    fire('font-download', { family: 'Pacifico', state: 'ready' });
    await waitFor(() => expect(onPick).toHaveBeenCalledWith('Pacifico'));
  });

  it('shows an offline failure inline with a retry, and never picks the family', async () => {
    downloadAnswer = { state: 'failed', errorCode: 'E_FONT_OFFLINE' };
    const onPick = open();
    search('Pacifico');
    fireEvent.click(within(row('Pacifico')).getByRole('button', { name: /^Pacifico/ }));
    await waitFor(() => expect(within(row('Pacifico')).getByText(t('fonts.error.offline'))).toBeTruthy());
    expect(onPick).not.toHaveBeenCalled();

    downloadAnswer = { state: 'ready' };
    fireEvent.click(within(row('Pacifico')).getByRole('button', { name: t('common.retry') }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith('Pacifico'));
  });

  it('removes a downloaded family', async () => {
    const onRemoved = vi.fn();
    open({ onRemoved });
    const remove = await within(row('Lora')).findByRole('button', { name: t('fonts.picker.remove', { family: 'Lora' }) });
    fireEvent.click(remove);
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith('Lora'));
    expect(daemonCall).toHaveBeenCalledWith('fonts.remove', { family: 'Lora' });
    expect(within(row('Lora')).queryByText(t('fonts.picker.downloaded'))).toBeNull();
  });

  it('says what is downloaded and from where', () => {
    open();
    expect(screen.getByText(t('settings.text.googleFontsNote'))).toBeTruthy();
  });
});

describe('Text settings with Google Fonts', () => {
  it('opens the picker and makes a downloaded family the app font', async () => {
    render(<AppearanceSettings initialSection="text" />);
    expect(screen.getByText(t('settings.text.googleFontsNote'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('settings.text.moreFonts') }));
    await waitFor(() => expect(within(row('Lora')).getByText(t('fonts.picker.downloaded'))).toBeTruthy());
    fireEvent.click(within(row('Lora')).getByRole('button', { name: /^Lora/ }));
    await waitFor(() => expect(useSettingsStore.getState().appFont).toBe('google:Lora'));
  });

  it('lists downloaded families beside the bundled ones, drawn in their own face', async () => {
    useSettingsStore.setState({ appFont: 'google:Lora' });
    render(<AppearanceSettings initialSection="text" />);
    const group = await screen.findByRole('group', { name: t('settings.text.downloadedFonts') });
    const lora = within(group).getByRole('button', { name: /Lora/ });
    expect(lora.getAttribute('aria-pressed')).toBe('true');
    expect(lora.style.fontFamily).toContain('Lora');
    fireEvent.click(screen.getByRole('button', { name: /Inter/ }));
    expect(useSettingsStore.getState().appFont).toBe('inter');
  });

  // The picker may be closed while the download runs: its outcome still shows.
  it('keeps a download it started in view after the picker closes, with a retry on failure', async () => {
    downloadAnswer = { state: 'failed', errorCode: 'E_FONT_OFFLINE' };
    render(<AppearanceSettings initialSection="text" />);
    fireEvent.click(screen.getByRole('button', { name: t('settings.text.moreFonts') }));
    search('Pacifico');
    fireEvent.click(within(row('Pacifico')).getByRole('button', { name: /^Pacifico/ }));
    await waitFor(() => expect(within(row('Pacifico')).getByText(t('fonts.error.offline'))).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: t('common.close') }));
    const status = await screen.findByTestId('font-download-status');
    expect(status.textContent).toContain('Pacifico');
    expect(status.textContent).toContain(t('fonts.error.offline'));

    downloadAnswer = { state: 'ready' };
    fireEvent.click(within(status).getByRole('button', { name: t('common.retry') }));
    await waitFor(() => expect(useSettingsStore.getState().appFont).toBe('google:Pacifico'));
    await waitFor(() => expect(screen.queryByTestId('font-download-status')).toBeNull());
  });

  it('goes back to the default font when the current one is removed', async () => {
    useSettingsStore.setState({ appFont: 'google:Lora' });
    render(<AppearanceSettings initialSection="text" />);
    fireEvent.click(screen.getByRole('button', { name: t('settings.text.moreFonts') }));
    fireEvent.click(await within(row('Lora')).findByRole('button', { name: t('fonts.picker.remove', { family: 'Lora' }) }));
    await waitFor(() => expect(useSettingsStore.getState().appFont).toBe('instrument-sans'));
  });
});
