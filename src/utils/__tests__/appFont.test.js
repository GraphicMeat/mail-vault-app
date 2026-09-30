// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const setZoom = vi.fn(() => Promise.resolve());
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ setZoom }) }));
const loadFontFaces = vi.fn(() => Promise.resolve(true));
vi.mock('../../services/fontService', () => ({ loadFontFaces: (...args) => loadFontFaces(...args) }));

import { APP_FONTS, DEFAULT_APP_FONT, applyAppFont, applyTextScale, fontStack, normalizeAppFont, watchTextAppearance } from '../appFont';

const appliedFont = () => document.documentElement.style.getPropertyValue('--app-font');

afterEach(() => {
  delete window.__TAURI__;
  setZoom.mockClear();
  loadFontFaces.mockClear();
});

describe('app font', () => {
  it('sets --app-font to each choice, and an unknown id to the default', () => {
    for (const { id, family } of APP_FONTS) {
      applyAppFont(id);
      expect(appliedFont(), id).toBe(fontStack(id));
      expect(appliedFont(), id).toContain(family ? `'${family}'` : 'system-ui');
    }
    applyAppFont('comic-sans');
    expect(appliedFont()).toBe(fontStack(DEFAULT_APP_FONT));
    expect(appliedFont()).toContain("'Instrument Sans'");
  });

  it('falls back to a monospace face for a coding font', () => {
    expect(fontStack('fira-code')).toMatch(/^'Fira Code', .*monospace$/);
    expect(fontStack('inter')).toMatch(/^'Inter', .*sans-serif$/);
  });
});

describe('a downloaded Google font as the app font', () => {
  it('is kept only when the catalogue lists it', () => {
    expect(normalizeAppFont('google:Roboto')).toBe('google:Roboto');
    expect(normalizeAppFont('google:Comic Sans MS')).toBe(DEFAULT_APP_FONT);
    expect(normalizeAppFont('google:')).toBe(DEFAULT_APP_FONT);
    expect(normalizeAppFont('Roboto')).toBe(DEFAULT_APP_FONT);
  });

  it('stacks the family over its category fallback, so text draws before the face loads', () => {
    expect(fontStack('google:Roboto')).toBe("'Roboto', system-ui, sans-serif");
    expect(fontStack('google:Lora')).toBe("'Lora', Georgia, serif");
    expect(fontStack('google:Evil'), 'unknown: the default').toBe(fontStack(DEFAULT_APP_FONT));
  });

  it('registers the face in this window when applied, and nothing for a bundled font', () => {
    applyAppFont('google:Lora');
    expect(appliedFont()).toBe("'Lora', Georgia, serif");
    expect(loadFontFaces).toHaveBeenCalledWith('Lora');
    loadFontFaces.mockClear();
    applyAppFont('inter');
    expect(loadFontFaces).not.toHaveBeenCalled();
  });
});

describe('text scale', () => {
  it('zooms the webview inside Tauri', async () => {
    window.__TAURI__ = {};
    await applyTextScale(1.25);
    expect(setZoom).toHaveBeenCalledWith(1.25);
  });

  it('zooms an unknown factor back to 100%', async () => {
    window.__TAURI__ = {};
    await applyTextScale(7);
    expect(setZoom).toHaveBeenCalledWith(1);
  });

  it('does nothing outside Tauri', async () => {
    await applyTextScale(1.5);
    expect(setZoom).not.toHaveBeenCalled();
  });
});

describe('watching the settings store', () => {
  function fakeStore(state) {
    const listeners = [];
    const finished = [];
    let hydrated = false;
    return {
      getState: () => state,
      subscribe: fn => { listeners.push(fn); return () => {}; },
      persist: { hasHydrated: () => hydrated, onFinishHydration: fn => finished.push(fn) },
      set(patch) { state = { ...state, ...patch }; listeners.forEach(fn => fn(state)); },
      hydrate(patch) { this.set(patch); hydrated = true; finished.forEach(fn => fn(state)); },
    };
  }

  it('applies the font at once, zooms only once the saved size is known, and follows changes', async () => {
    window.__TAURI__ = {};
    const store = fakeStore({ appFont: 'instrument-sans', textScale: 1 });
    watchTextAppearance(store);
    expect(appliedFont()).toBe(fontStack('instrument-sans'));
    expect(setZoom).not.toHaveBeenCalled();

    store.hydrate({ appFont: 'inter', textScale: 1.25 });
    await Promise.resolve();
    await Promise.resolve();
    expect(appliedFont()).toBe(fontStack('inter'));
    await vi.waitFor(() => expect(setZoom).toHaveBeenCalledTimes(1));
    expect(setZoom).toHaveBeenLastCalledWith(1.25);

    store.set({ textScale: 0.9 });
    await vi.waitFor(() => expect(setZoom).toHaveBeenLastCalledWith(0.9));
    store.set({ language: 'de' });
    await Promise.resolve();
    expect(setZoom).toHaveBeenCalledTimes(2);
  });
});
