// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { darkUiColors, mapSwatch, SWATCH_HTML, _resetDarkSwatchForTest } from '../darkSwatch';

// What the probe frame reads back: computed colour strings of the four swatches,
// after Dark Reader re-themed them.
const raw = (over = {}) => ({
  menu: { backgroundColor: 'rgb(24, 26, 27)', color: 'rgb(200, 195, 188)', borderTopColor: 'rgb(60, 65, 68)' },
  hover: { backgroundColor: 'rgb(30, 33, 34)' },
  sel: { backgroundColor: 'rgb(60, 80, 140)' },
  shadow: { backgroundColor: 'rgba(0, 0, 0, 0.15)' },
  ...over,
});

beforeEach(() => { vi.clearAllMocks(); _resetDarkSwatchForTest(); });

describe('darkUiColors', () => {
  it('without a probe (plan B not landed) there are no dark colours: the light ones stand', async () => {
    expect(await darkUiColors({ dark: true, palette: 'graphite' })).toBeNull();
  });

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
    expect([over(o.r, 24), over(o.g, 26), over(o.b, 27)]).toEqual([60, 80, 140]);
    expect(o.a).toBeLessThan(1); // translucent: the text layer is transparent over the tile
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
  it('an opaque selection overlay is rejected: Dark Reader\'s real blue over a near-black paper would hide the glyphs', () => {
    // overlayFor can only return a = 1 here; plan B must not hand the text layer an opaque highlight.
    expect(mapSwatch(raw({ sel: { backgroundColor: 'rgb(0, 77, 170)' } }))).toBeNull();
  });
  it('a translucent selection swatch is not trusted', () => {
    expect(mapSwatch(raw({ sel: { backgroundColor: 'rgba(0, 77, 170, 0.5)' } }))).toBeNull();
  });
  it('a swatch Dark Reader has not touched yet (still the light menu) is not ready', () => {
    expect(mapSwatch(raw({ menu: { backgroundColor: 'rgb(255, 255, 255)', color: 'rgb(51, 51, 51)', borderTopColor: 'rgb(209, 213, 219)' } }))).toBeNull();
  });
});

describe('no probe frame', () => {
  it('nothing under src/features/blitz creates an iframe or injects Dark Reader', () => {
    const root = resolve(process.cwd(), 'src/features/blitz');
    const files = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const f = join(dir, name);
        if (name === '__tests__') continue;
        if (statSync(f).isDirectory()) walk(f); else if (/\.(jsx?|css)$/.test(name)) files.push(f);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/<iframe|createElement\(\s*['"]iframe|getDarkReaderInlineScripts|darkReaderInject/);
    }
  });
});
