// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('../../../../utils/darkReaderInject', () => ({ getDarkReaderInlineScripts: vi.fn(() => '<!--dr-->') }));
import { getDarkReaderInlineScripts } from '../../../../utils/darkReaderInject';
import { darkUiColors, mapSwatch, domProbe, SWATCH_HTML, _resetDarkSwatchForTest } from '../darkSwatch';

// What the probe frame reads back: computed colour strings of the four swatches,
// after Dark Reader re-themed them.
const raw = (over = {}) => ({
  menu: { backgroundColor: 'rgb(24, 26, 27)', color: 'rgb(200, 195, 188)', borderTopColor: 'rgb(60, 65, 68)' },
  hover: { backgroundColor: 'rgb(30, 33, 34)' },
  sel: { backgroundColor: 'rgb(0, 77, 170)' },
  shadow: { backgroundColor: 'rgba(0, 0, 0, 0.15)' },
  ...over,
});

beforeEach(() => { vi.clearAllMocks(); _resetDarkSwatchForTest(); });
afterEach(() => { document.querySelectorAll('iframe').forEach(f => f.remove()); vi.useRealTimers(); });

describe('darkUiColors', () => {
  it('swatch carries the light menu colours and the DR selection seed', () => {
    expect(SWATCH_HTML).toContain('data-mv-id="menu"');
    expect(SWATCH_HTML).toContain('background-color:#ffffff;color:#333333;border:1px solid #d1d5db');
    expect(SWATCH_HTML).toContain('data-mv-id="hover" style="background-color:#f3f4f6"');
    expect(SWATCH_HTML).toContain('data-mv-id="sel" style="background-color:rgb(0,96,212);color:#ffffff"');
  });

  it('maps the probed colours to the menu and the selection overlay, once per palette', async () => {
    const probe = vi.fn(async () => raw());
    const a = await darkUiColors({ dark: true, palette: 'graphite' }, probe);
    const b = await darkUiColors({ dark: true, palette: 'graphite' }, probe);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith('graphite');
    expect(a).toBe(b);
    expect(a.menu).toEqual({ menuBg: 'rgb(24, 26, 27)', menuBorder: 'rgb(60, 65, 68)', itemColor: 'rgb(200, 195, 188)', itemHoverBg: 'rgb(30, 33, 34)', menuShadow: '0 4px 12px rgba(0, 0, 0, 0.15)' });
    expect(a.paper).toEqual({ r: 24, g: 26, b: 27 });
    const o = a.selection;
    const over = (c, p) => Math.round(o.a * c + (1 - o.a) * p);
    expect([over(o.r, 24), over(o.g, 26), over(o.b, 27)]).toEqual([0, 77, 170]);
  });

  it('another palette is probed on its own', async () => {
    const probe = vi.fn(async (palette) => (palette === 'teal' ? raw({ menu: { backgroundColor: 'rgb(10, 21, 23)', color: 'rgb(230, 241, 242)', borderTopColor: 'rgb(40, 60, 64)' } }) : raw()));
    const g = await darkUiColors({ dark: true, palette: 'graphite' }, probe);
    const t = await darkUiColors({ dark: true, palette: 'teal' }, probe);
    expect(probe.mock.calls.map(c => c[0])).toEqual(['graphite', 'teal']);
    expect(t.menu.menuBg).toBe('rgb(10, 21, 23)');
    expect(g.menu.menuBg).toBe('rgb(24, 26, 27)');
  });

  it('null (light fallbacks) when the probe cannot read, and the next call probes again', async () => {
    const probe = vi.fn().mockRejectedValueOnce(new Error('no frame')).mockResolvedValueOnce(null).mockResolvedValue(raw());
    expect(await darkUiColors({ dark: true, palette: 'teal' }, probe)).toBeNull();
    expect(await darkUiColors({ dark: true, palette: 'teal' }, probe)).toBeNull();
    expect((await darkUiColors({ dark: true, palette: 'teal' }, probe)).menu.menuBg).toBe('rgb(24, 26, 27)');
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('concurrent callers share one probe', async () => {
    const probe = vi.fn(() => new Promise(r => setTimeout(() => r(raw()), 5)));
    const [a, b] = await Promise.all([darkUiColors({ dark: true, palette: 'graphite' }, probe), darkUiColors({ dark: true, palette: 'graphite' }, probe)]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });
});

describe('mapSwatch', () => {
  it('opaque shadow and menu parse, a colour it cannot parse is null', () => {
    expect(mapSwatch(raw({ shadow: { backgroundColor: 'rgb(0, 0, 0)' } })).menu.menuShadow).toBe('0 4px 12px rgb(0, 0, 0)');
    expect(mapSwatch(raw({ menu: { backgroundColor: 'color(display-p3 0 0 0)', color: 'rgb(1, 1, 1)', borderTopColor: 'rgb(1, 1, 1)' } }))).toBeNull();
    expect(mapSwatch(null)).toBeNull();
  });
  it('a translucent selection swatch is not trusted', () => {
    expect(mapSwatch(raw({ sel: { backgroundColor: 'rgba(0, 77, 170, 0.5)' } }))).toBeNull();
  });
  it('a swatch Dark Reader has not touched yet (still the light menu) is not ready', () => {
    expect(mapSwatch(raw({ menu: { backgroundColor: 'rgb(255, 255, 255)', color: 'rgb(51, 51, 51)', borderTopColor: 'rgb(209, 213, 219)' } }))).toBeNull();
  });
});

describe('domProbe', () => {
  // jsdom does not load srcdoc: the swatch markup goes into the frame's document by hand.
  const frameOf = async () => {
    let f;
    await vi.waitFor(() => { f = document.querySelector('iframe'); expect(f?.contentDocument?.body).toBeTruthy(); });
    f.contentDocument.body.innerHTML = SWATCH_HTML;
    return f;
  };
  // Stand-in for Dark Reader (scripts do not run in jsdom): re-theme the swatches the way it does.
  const rethemed = (f) => {
    const d = f.contentDocument;
    const set = (id, css) => { const el = d.querySelector(`[data-mv-id="${id}"]`); el.setAttribute('style', css); el.setAttribute('data-darkreader-inline-bgcolor', ''); };
    set('menu', 'background-color:rgb(24, 26, 27);color:rgb(200, 195, 188);border:1px solid rgb(60, 65, 68)');
    set('hover', 'background-color:rgb(30, 33, 34)');
    set('sel', 'background-color:rgb(0, 77, 170);color:rgb(232, 230, 227)');
    set('shadow', 'background-color:rgba(0, 0, 0, 0.15)');
  };

  it('builds the reader frame with the reader Dark Reader scripts, offscreen, and removes it', async () => {
    const p = domProbe('teal');
    const f = await frameOf();
    expect(getDarkReaderInlineScripts).toHaveBeenCalledWith(expect.objectContaining({ palette: 'teal' }));
    expect(f.getAttribute('sandbox')).toBe('allow-same-origin allow-popups allow-scripts');
    const srcdoc = f.getAttribute('srcdoc');
    expect(srcdoc).toContain('<!--dr-->');
    expect(srcdoc).toContain('data-mv-id="menu"');
    expect(srcdoc).toContain('Content-Security-Policy');
    expect(f.style.position).toBe('fixed');
    expect(f.style.display).not.toBe('none'); // computed styles of a display:none frame are not reliable
    rethemed(f);
    const out = await p;
    expect(out.menu.backgroundColor).toBe('rgb(24, 26, 27)');
    expect(out.menu.color).toBe('rgb(200, 195, 188)');
    expect(out.menu.borderTopColor).toBe('rgb(60, 65, 68)');
    expect(out.hover.backgroundColor).toBe('rgb(30, 33, 34)');
    expect(out.sel.backgroundColor).toBe('rgb(0, 77, 170)');
    expect(out.shadow.backgroundColor).toBe('rgba(0, 0, 0, 0.15)');
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('does not read before Dark Reader has marked every swatch', async () => {
    const p = domProbe('graphite');
    const f = await frameOf();
    // Dark values on all but one swatch: the light one has no Dark Reader attribute yet.
    rethemed(f);
    f.contentDocument.querySelector('[data-mv-id="hover"]').removeAttribute('data-darkreader-inline-bgcolor');
    await new Promise(r => setTimeout(r, 120));
    expect(document.querySelector('iframe')).toBeTruthy(); // still waiting
    f.contentDocument.querySelector('[data-mv-id="hover"]').setAttribute('data-darkreader-inline-bgcolor', '');
    expect((await p).hover.backgroundColor).toBe('rgb(30, 33, 34)');
  });

  it('gives up with null when Dark Reader never runs, and removes the frame', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const p = domProbe('graphite');
    await vi.advanceTimersByTimeAsync(2500);
    expect(await p).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
  });
});
