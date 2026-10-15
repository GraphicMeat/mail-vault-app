// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';

// jsdom has no 2d context: a stub that records the composite's draws.
const ctx = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn() };
const fakeCanvas = () => Object.assign(document.createElement('canvas'), { width: 10, height: 10, getContext: () => ctx });
vi.mock('modern-screenshot', () => ({ domToCanvas: vi.fn(async () => fakeCanvas()) }));
import { captureAppWindow } from '../captureAppWindow';
import { EMPTY_DICTIONARY } from '../../../../utils/privacy/piiDetector';
import { registerBodyRenderer, _resetBodyRenderersForTest } from '../../../../components/email/bodyRendererRegistry';
import { useSettingsStore } from '../../../../stores/settingsStore';
import { usePrivacyStore } from '../../../../stores/privacyStore';

const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
const altBody = (busy, parent = document.getElementById('root')) => {
  const el = document.createElement('div');
  el.setAttribute('data-renderer', 'blitz');
  el.setAttribute('aria-busy', String(busy));
  parent.appendChild(el);
  return el;
};

afterEach(() => {
  document.body.innerHTML = '';
  _resetBodyRenderersForTest();
  useSettingsStore.setState({ emailRenderer: 'web' });
  Object.values(ctx).forEach(f => f?.mockClear?.());
  usePrivacyStore.setState({ captureMask: false });
  vi.restoreAllMocks();
});

describe('captureAppWindow with an alternative body renderer', () => {
  it('waits for busy alternative bodies, then composites them', async () => {
    document.body.innerHTML = '<div id="root"><p>x</p></div>';
    const compositeBodies = vi.fn(async () => 1);
    registerBodyRenderer('blitz', { Body: () => null, compositeBodies });
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    const busy = altBody(true);
    setTimeout(() => busy.setAttribute('aria-busy', 'false'), 60);
    const started = Date.now();
    await captureAppWindow({ redact: true, dict: EMPTY_DICTIONARY });
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(compositeBodies).toHaveBeenCalledTimes(1);
    expect(compositeBodies).toHaveBeenCalledWith(expect.anything(), document.getElementById('root'), { scale: 2, redact: true });
    // The body had settled by the time it was composited.
    expect(busy.getAttribute('aria-busy')).toBe('false');
  });

  it('hands the renderer redact false for a plain capture', async () => {
    document.body.innerHTML = '<div id="root"><p>x</p></div>';
    const compositeBodies = vi.fn(async () => 0);
    registerBodyRenderer('blitz', { Body: () => null, compositeBodies });
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    await captureAppWindow({ redact: false, dict: null });
    expect(compositeBodies).toHaveBeenCalledWith(expect.anything(), document.getElementById('root'), { scale: 2, redact: false });
  });

  it('does not wait on a busy body inside an excluded region', async () => {
    document.body.innerHTML = '<div id="root"><div id="dialog" data-capture-exclude=""></div></div>';
    registerBodyRenderer('blitz', { Body: () => null, compositeBodies: vi.fn(async () => 0) });
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    altBody(true, document.getElementById('dialog'));
    const started = Date.now();
    await captureAppWindow({ redact: false, dict: null });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('paints the alternative bodies before the floating overlays are put back on top', async () => {
    document.body.innerHTML = '<div id="root"><p>x</p><div data-capture-overlay=""></div></div>';
    const root = document.getElementById('root');
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(box(0, 0, 800, 600));
    vi.spyOn(root.querySelector('[data-capture-overlay]'), 'getBoundingClientRect').mockReturnValue(box(10, 10, 100, 50));
    // The overlay snapshot canvas is a plain jsdom canvas, which has no context.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    registerBodyRenderer('blitz', {
      Body: () => null,
      compositeBodies: async (canvas) => { canvas.getContext('2d').drawImage('blitz-body'); return 1; },
    });
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    await captureAppWindow({ redact: false, dict: null });
    const firsts = ctx.drawImage.mock.calls.map(c => c[0]);
    expect(firsts[0]).toBe('blitz-body');
    expect(firsts.length).toBe(2);
    expect(firsts[1]).not.toBe('blitz-body');
  });

  it('draws as before with the web renderer, and with a renderer that composites nothing', async () => {
    document.body.innerHTML = '<div id="root"><p>x</p></div>';
    const compositeBodies = vi.fn(async () => 1);
    registerBodyRenderer('blitz', { Body: () => null, compositeBodies });
    await captureAppWindow({ redact: false, dict: null }); // emailRenderer is 'web'
    expect(compositeBodies).not.toHaveBeenCalled();
    registerBodyRenderer('other', { Body: () => null });
    useSettingsStore.setState({ emailRenderer: 'other' });
    await expect(captureAppWindow({ redact: false, dict: null })).resolves.toBeTruthy();
  });

  it('a composite hook that throws or rejects does not kill the shot', async () => {
    document.body.innerHTML = '<div id="root"><p>x</p></div>';
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    for (const compositeBodies of [vi.fn(async () => { throw new Error('closed bitmap'); }), vi.fn(() => { throw new Error('sync boom'); })]) {
      registerBodyRenderer('blitz', { Body: () => null, compositeBodies });
      await expect(captureAppWindow({ redact: false, dict: null })).resolves.toBeTruthy();
      expect(compositeBodies).toHaveBeenCalledTimes(1);
    }
  });
});
