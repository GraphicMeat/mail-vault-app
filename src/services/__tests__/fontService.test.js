// @vitest-environment jsdom
// The app half of Google Fonts: the daemon downloads and keeps the files;
// this module asks it, follows its events, and hands the bytes to FontFace.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listeners = new Map();
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name, cb) => { listeners.set(name, cb); return () => listeners.delete(name); }),
}));
const daemonCall = vi.fn();
vi.mock('../daemonClient', () => ({ daemonCall: (...args) => daemonCall(...args) }));

const fire = (name, payload) => listeners.get(name)?.({ payload });
// The daemon has answered `fonts.download` and every microtask after it ran.
const answered = async () => {
  await vi.waitFor(() => expect(daemonCall).toHaveBeenCalledWith('fonts.download', { family: 'Lora' }));
  await new Promise(resolve => setTimeout(resolve, 0));
};
const B64 = btoa('wOF2 fake');

class FakeFontFace {
  constructor(family, source, descriptors) {
    Object.assign(this, { family, source, descriptors });
    FakeFontFace.made.push(this);
  }
  load() { return Promise.resolve(this); }
}
FakeFontFace.made = [];

let mod;
beforeEach(async () => {
  vi.resetModules();
  listeners.clear();
  daemonCall.mockReset();
  FakeFontFace.made = [];
  vi.stubGlobal('FontFace', FakeFontFace);
  const added = new Set();
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { add: vi.fn(face => added.add(face)), delete: vi.fn(face => added.delete(face)), has: face => added.has(face) },
  });
  mod = await import('../fontService');
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const faces = family => ({
  family,
  faces: [
    { weight: 400, style: 'normal', subset: 'latin-ext', unicodeRange: 'U+0100-02BA', data: B64 },
    { weight: 400, style: 'normal', subset: 'latin', unicodeRange: 'U+0000-00FF', data: B64 },
  ],
});

describe('loading a downloaded family into this window', () => {
  it('adds one FontFace per file, from bytes, with its weight and unicode-range', async () => {
    daemonCall.mockResolvedValue(faces('Lora'));
    expect(await mod.loadFontFaces('Lora')).toBe(true);
    expect(daemonCall).toHaveBeenCalledWith('fonts.read', { family: 'Lora' });
    expect(FakeFontFace.made).toHaveLength(2);
    const [ext, latin] = FakeFontFace.made;
    expect(latin.family).toBe('Lora');
    expect(latin.source).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(latin.source)).toBe('wOF2 fake');
    expect(latin.descriptors).toEqual({ weight: '400', style: 'normal', unicodeRange: 'U+0000-00FF' });
    expect(ext.descriptors.unicodeRange).toBe('U+0100-02BA');
    expect(document.fonts.add).toHaveBeenCalledTimes(2);
  });

  it('asks once per family, whoever asks', async () => {
    daemonCall.mockResolvedValue(faces('Lora'));
    await Promise.all([mod.loadFontFaces('Lora'), mod.loadFontFaces('Lora')]);
    await mod.loadFontFaces('Lora');
    expect(daemonCall).toHaveBeenCalledTimes(1);
  });

  it('answers false, never throws, for a family not in the catalogue, not downloaded, or no FontFace', async () => {
    expect(await mod.loadFontFaces('Comic Sans MS')).toBe(false);
    expect(daemonCall).not.toHaveBeenCalled();

    daemonCall.mockResolvedValueOnce({ family: 'Lora', faces: [], errorCode: 'E_FONT_MISSING' });
    expect(await mod.loadFontFaces('Lora')).toBe(false);
    daemonCall.mockRejectedValueOnce(new Error('daemon not running'));
    expect(await mod.loadFontFaces('Lora')).toBe(false);
    // Neither was kept as loaded: a later download can still load it.
    daemonCall.mockResolvedValueOnce(faces('Lora'));
    expect(await mod.loadFontFaces('Lora')).toBe(true);

    vi.stubGlobal('FontFace', undefined);
    expect(await mod.loadFontFaces('Roboto')).toBe(false);
  });

  // The main window asks right after hydration, which can be before the
  // daemon answers: a failed first read must not leave the fallback for the
  // whole session.
  it('tries a family again when the daemon (re)connects', async () => {
    daemonCall.mockRejectedValueOnce(new Error('daemon not running'));
    expect(await mod.loadFontFaces('Lora')).toBe(false);
    daemonCall.mockResolvedValue(faces('Lora'));
    await vi.waitFor(() => expect(listeners.has('daemon-reconnected')).toBe(true));
    fire('daemon-reconnected', {});
    await vi.waitFor(() => expect(document.fonts.add).toHaveBeenCalledTimes(2));
    // Loaded now: another reconnect asks nothing.
    daemonCall.mockClear();
    fire('daemon-reconnected', {});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(daemonCall.mock.calls.filter(([m]) => m === 'fonts.read')).toEqual([]);
  });

  it('loads a family another window downloaded, once this window wanted it', async () => {
    daemonCall.mockResolvedValueOnce({ family: 'Lora', faces: [], errorCode: 'E_FONT_MISSING' });
    expect(await mod.loadFontFaces('Lora')).toBe(false);
    daemonCall.mockResolvedValue(faces('Lora'));
    fire('font-download', { family: 'Lora', state: 'ready' });
    await vi.waitFor(() => expect(document.fonts.add).toHaveBeenCalledTimes(2));
  });

  it('loads the downloaded families a piece of HTML names', async () => {
    daemonCall.mockImplementation(async (method, params) => {
      if (method === 'fonts.list') return { fonts: [{ family: 'Lora' }], downloading: [] };
      return faces(params.family);
    });
    await mod.loadFontFacesForHtml('<p><span style="font-family: Lora, Georgia, serif">a</span><span style="font-family: Roboto, Arial">b</span></p>');
    expect(daemonCall.mock.calls.filter(([m]) => m === 'fonts.read')).toEqual([['fonts.read', { family: 'Lora' }]]);
    daemonCall.mockClear();
    await mod.loadFontFacesForHtml('<p>no fonts</p>');
    expect(daemonCall).not.toHaveBeenCalled();
  });
});

describe('downloading a family', () => {
  it('follows the daemon events from downloading to ready, then loads the face', async () => {
    daemonCall.mockImplementation(async (method, params) => {
      if (method === 'fonts.download') return { family: params.family, state: 'downloading' };
      if (method === 'fonts.read') return faces(params.family);
      return { fonts: [], downloading: [] };
    });
    const done = mod.downloadFont('Lora');
    await vi.waitFor(() => expect(daemonCall).toHaveBeenCalledWith('fonts.download', { family: 'Lora' }));
    expect(mod.fontStatus(mod.useFontStore.getState(), 'Lora').state).toBe('downloading');

    fire('font-download', { family: 'Lora', state: 'downloading', done: 1, total: 2 });
    expect(mod.fontStatus(mod.useFontStore.getState(), 'Lora')).toMatchObject({ state: 'downloading', done: 1, total: 2 });
    fire('font-download', { family: 'Lora', state: 'ready', bytes: 10 });
    await done;
    expect(mod.fontStatus(mod.useFontStore.getState(), 'Lora').state).toBe('ready');
    expect(mod.useFontStore.getState().installed).toContain('Lora');
    expect(document.fonts.add).toHaveBeenCalled();
  });

  it('resolves at once for a family already installed', async () => {
    daemonCall.mockImplementation(async (method, params) => (method === 'fonts.download'
      ? { family: params.family, state: 'ready' } : faces(params.family)));
    await mod.downloadFont('Lora');
    expect(mod.fontStatus(mod.useFontStore.getState(), 'Lora').state).toBe('ready');
  });

  it('rejects with the daemon code when offline or when the download fails, and remembers the error', async () => {
    daemonCall.mockResolvedValueOnce({ family: 'Lora', state: 'failed', errorCode: 'E_FONT_OFFLINE' });
    await expect(mod.downloadFont('Lora')).rejects.toMatchObject({ code: 'E_FONT_OFFLINE' });
    expect(mod.fontStatus(mod.useFontStore.getState(), 'Lora')).toMatchObject({ state: 'failed', errorCode: 'E_FONT_OFFLINE' });

    daemonCall.mockResolvedValueOnce({ family: 'Lora', state: 'downloading' });
    const second = mod.downloadFont('Lora');
    await vi.waitFor(() => expect(mod.fontStatus(mod.useFontStore.getState(), 'Lora').state).toBe('downloading'));
    fire('font-download', { family: 'Lora', state: 'failed', errorCode: 'E_FONT_NETWORK' });
    await expect(second).rejects.toMatchObject({ code: 'E_FONT_NETWORK' });
  });

  it('refuses a family outside the catalogue without asking the daemon', async () => {
    await expect(mod.downloadFont('Comic Sans MS')).rejects.toMatchObject({ code: 'E_FONT_UNKNOWN' });
    expect(daemonCall).not.toHaveBeenCalled();
  });

  it('does not hang on a lost event: a reconnect re-reads the list', async () => {
    let installed = false;
    daemonCall.mockImplementation(async (method, params) => {
      if (method === 'fonts.download') return { family: params.family, state: 'downloading' };
      if (method === 'fonts.list') return { fonts: installed ? [{ family: 'Lora' }] : [], downloading: installed ? [] : ['Lora'] };
      return faces(params.family);
    });
    const done = mod.downloadFont('Lora');
    await answered();
    installed = true;
    fire('daemon-reconnected', {});
    await done;
    expect(mod.fontStatus(mod.useFontStore.getState(), 'Lora').state).toBe('ready');
  });

  it('fails a download the daemon no longer knows of', async () => {
    daemonCall.mockImplementation(async (method, params) => (method === 'fonts.download'
      ? { family: params.family, state: 'downloading' } : { fonts: [], downloading: [] }));
    const done = mod.downloadFont('Lora');
    await answered();
    fire('daemon-events-lagged', {});
    await expect(done).rejects.toMatchObject({ code: 'E_FONT_NETWORK' });
  });
});

describe('the list and removal', () => {
  it('reads what is installed and what is downloading', async () => {
    daemonCall.mockResolvedValue({ fonts: [{ family: 'Lora' }, { family: 'Roboto' }], downloading: ['Lato'] });
    await mod.refreshFonts();
    const state = mod.useFontStore.getState();
    expect(state.installed).toEqual(['Lora', 'Roboto']);
    expect(mod.fontStatus(state, 'Lato').state).toBe('downloading');
    expect(mod.fontStatus(state, 'Lora').state).toBe('ready');
    expect(mod.fontStatus(state, 'Pacifico').state).toBe('idle');
  });

  it('removes a family and its faces from this window', async () => {
    daemonCall.mockImplementation(async (method, params) => {
      if (method === 'fonts.read') return faces(params.family);
      if (method === 'fonts.remove') return { removed: true };
      return { fonts: [{ family: 'Lora' }], downloading: [] };
    });
    await mod.refreshFonts();
    await mod.loadFontFaces('Lora');
    expect(await mod.removeFont('Lora')).toBe(true);
    expect(daemonCall).toHaveBeenCalledWith('fonts.remove', { family: 'Lora' });
    expect(document.fonts.delete).toHaveBeenCalledTimes(2);
    expect(mod.useFontStore.getState().installed).toEqual([]);
  });
});

// Mail renders in srcdoc frames, each with its own document.fonts: a face in
// this window's never draws there.
describe('fonts a received mail is written in', () => {
  class FrameFontFace {
    constructor(family, source, descriptors) {
      Object.assign(this, { family, source, descriptors, loaded: Promise.resolve(this) });
      FrameFontFace.made.push(this);
    }
  }
  const frames = [];
  afterEach(() => { frames.splice(0).forEach(frame => frame.remove()); });

  // A real frame (jsdom does not load srcdoc): the mail's HTML written into
  // its document, FontFace and fonts stubbed in ITS realm.
  const mailFrame = (html) => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    frames.push(iframe);
    const doc = iframe.contentDocument;
    doc.body.innerHTML = html;
    iframe.contentWindow.FontFace = FrameFontFace;
    Object.defineProperty(doc, 'fonts', { configurable: true, value: { add: vi.fn() } });
    return { iframe, doc };
  };
  const loadedFrame = (html, options) => {
    const frame = mailFrame(html);
    const detach = mod.attachMailFonts(frame.iframe, options);
    frame.iframe.dispatchEvent(new Event('load'));
    return { ...frame, detach };
  };
  const daemon = ({ installed = [], download = 'ready' } = {}) => daemonCall.mockImplementation(async (method, params) => {
    if (method === 'fonts.list') return { fonts: installed.map(family => ({ family })), downloading: [] };
    if (method === 'fonts.download') return { family: params.family, state: download };
    if (method === 'fonts.read') return faces(params.family);
    return null;
  });
  const calls = method => daemonCall.mock.calls.filter(([m]) => m === method).map(([, p]) => p?.family);

  beforeEach(() => { FrameFontFace.made = []; });

  it('registers a downloaded family into the frame document, not this window', async () => {
    daemon({ installed: ['Lora'] });
    const { doc } = loadedFrame('<p style="font-family: Lora, Georgia, serif">a</p>');
    await vi.waitFor(() => expect(doc.fonts.add).toHaveBeenCalledTimes(2));
    expect(FrameFontFace.made.map(face => face.family)).toEqual(['Lora', 'Lora']);
    expect(FrameFontFace.made[1].descriptors).toEqual({ weight: '400', style: 'normal', unicodeRange: 'U+0000-00FF' });
    expect(new TextDecoder().decode(FrameFontFace.made[0].source)).toBe('wOF2 fake');
    expect(document.fonts.add).not.toHaveBeenCalled();
    expect(calls('fonts.download')).toEqual([]);
  });

  it('downloads a catalogue family the mail uses, then registers it', async () => {
    daemon({ installed: [] });
    const { doc } = loadedFrame("<style>p { font: italic 14px/1.4 'lora', serif }</style><p>a</p>");
    await vi.waitFor(() => expect(doc.fonts.add).toHaveBeenCalledTimes(2));
    expect(calls('fonts.download')).toEqual(['Lora']);
    // An ordinary downloaded font: the pickers list it.
    expect(mod.useFontStore.getState().installed).toContain('Lora');
  });

  it('downloads nothing because of a mail while blocking is on, and still draws one already here', async () => {
    daemon({ installed: ['Lora'] });
    const { doc } = loadedFrame('<p style="font-family: Pacifico">a</p><p style="font-family: Lora">b</p>', { blocking: () => true });
    await vi.waitFor(() => expect(doc.fonts.add).toHaveBeenCalledTimes(2));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls('fonts.download')).toEqual([]);
    expect(calls('fonts.read')).toEqual(['Lora']);
    expect(FrameFontFace.made.every(face => face.family === 'Lora')).toBe(true);
  });

  it('does not register into a document the frame no longer shows', async () => {
    let answer;
    daemonCall.mockImplementation(async (method, params) => {
      if (method === 'fonts.list') return new Promise(resolve => { answer = resolve; });
      return faces(params.family);
    });
    const { iframe, doc } = loadedFrame('<p style="font-family: Lora">a</p>');
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    // The srcDoc was replaced while the daemon was answering.
    const next = document.implementation.createHTMLDocument('');
    Object.defineProperty(iframe, 'contentDocument', { configurable: true, get: () => next });
    answer({ fonts: [{ family: 'Lora' }], downloading: [] });
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(doc.fonts.add).not.toHaveBeenCalled();
    expect(FrameFontFace.made).toEqual([]);
  });

  it('reads and decodes a family once for every frame that draws in it', async () => {
    daemon({ installed: ['Lora'] });
    const one = loadedFrame('<p style="font-family: Lora">a</p>');
    const two = loadedFrame('<font face="Lora, serif">b</font>');
    await vi.waitFor(() => expect(two.doc.fonts.add).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(one.doc.fonts.add).toHaveBeenCalledTimes(2));
    expect(calls('fonts.read')).toEqual(['Lora']);
    expect(calls('fonts.list')).toHaveLength(1);
    // The same decoded bytes, not a second base64 pass.
    expect(FrameFontFace.made[0].source).toBe(FrameFontFace.made[2].source);
  });

  it('asks the list again after a failed first answer, and never throws', async () => {
    daemonCall.mockRejectedValueOnce(new Error('daemon not running'));
    const first = loadedFrame('<p style="font-family: Lora">a</p>', { blocking: () => true });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(first.doc.fonts.add).not.toHaveBeenCalled();
    daemon({ installed: ['Lora'] });
    const second = loadedFrame('<p style="font-family: Lora">a</p>', { blocking: () => true });
    await vi.waitFor(() => expect(second.doc.fonts.add).toHaveBeenCalledTimes(2));
  });

  it('tells the frame when its faces are in, and stops listening when detached', async () => {
    daemon({ installed: ['Lora'] });
    const onFonts = vi.fn();
    const { iframe, detach } = loadedFrame('<p style="font-family: Lora">a</p>', { onFonts });
    await vi.waitFor(() => expect(onFonts).toHaveBeenCalledTimes(1));
    detach();
    // The frame goes on to show another mail.
    const { doc: next } = mailFrame('<p style="font-family: Lato">b</p>');
    Object.defineProperty(iframe, 'contentDocument', { configurable: true, get: () => next });
    iframe.dispatchEvent(new Event('load'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls('fonts.read')).toEqual(['Lora']);
  });
});
