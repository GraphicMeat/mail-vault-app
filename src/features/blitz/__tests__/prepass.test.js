// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
const redact = vi.hoisted(() => ({ throws: false }));
vi.mock('../../../utils/iframePrivacyRedact', () => ({
  applyPrivacyRedaction: (doc, dict) => {
    if (redact.throws) throw new Error('boom');
    for (const name of dict?.names ?? []) doc.body.innerHTML = doc.body.innerHTML.split(name).join('█████');
  },
}));
import { runPrepass } from '../prepass';
import { buildEmailIframeHtml } from '../../../utils/emailIframeTemplate';

const props = (over = {}) => ({ bodyHtml: '<p>Hi Alice</p><script>evil()</script>', indicatorCss: 'a{outline:1px}', theme: { dark: false }, ...over });

describe('runPrepass', () => {
  it('builds the same document the iframe gets, minus viewer scripts', async () => {
    const { html } = await runPrepass(props(), { privacy: { active: false, dict: null } });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('Hi Alice');
    expect(html).toContain('a{outline:1px}');
    expect(html).toContain('box-sizing: border-box'); // the template's own CSS is kept
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('evil()');
  });
  it('strips every script, the iframe viewer scripts and the mail\'s own, plus inline handlers', async () => {
    const own = '<p onclick="steal()" ONMOUSEOVER="x()">hi</p><img src="a.png" onerror="y()"><script>one()</script>'
      + '<svg onload="z()"><script>two()</script></svg>';
    const extra = '<script nonce="n1">viewer()</script>';
    const documentHtml = `<html><head>${extra}<style>p{color:red}</style></head><body onload="boot()">${own}${extra}</body></html>`;
    for (const p of [props({ bodyHtml: own }), props({ documentHtml })]) {
      const { html, doc } = await runPrepass(p, { privacy: { active: false } });
      expect(html).not.toMatch(/<script/i);
      expect([...doc.querySelectorAll('*')].flatMap(e => [...e.attributes].map(a => a.name)).filter(n => /^on/i.test(n))).toEqual([]);
      expect(doc.querySelectorAll('script').length).toBe(0);
      for (const bad of ['one()', 'two()', 'viewer()', 'steal()', 'boot()']) expect(html).not.toContain(bad);
      expect(html).toContain('hi');
    }
  });
  it('keeps text and attributes that merely look like handlers', async () => {
    const { html } = await runPrepass(props({ bodyHtml: '<p data-on="1" title="onclick=x">one=two</p>' }), { privacy: { active: false } });
    expect(html).toContain('data-on="1"');
    expect(html).toContain('title="onclick=x"');
  });
  it('masks with the iframe redaction when privacy is active', async () => {
    const { html } = await runPrepass(props(), { privacy: { active: true, dict: { names: ['Alice'] } } });
    expect(html).toContain('█████');
    expect(html).not.toContain('Alice');
  });
  it('leaves text alone when privacy is off', async () => {
    const { html } = await runPrepass(props(), { privacy: { active: false, dict: { names: ['Alice'] } } });
    expect(html).toContain('Alice');
  });
  it('rejects when redaction throws (callers fail closed)', async () => {
    redact.throws = true;
    await expect(runPrepass(props(), { privacy: { active: true, dict: { names: [] } } })).rejects.toThrow('boom');
    redact.throws = false;
  });
  it('uses documentHtml verbatim as the build step when given', async () => {
    const { html } = await runPrepass(props({ documentHtml: '<html><body style="padding:8px"><p>own doc</p></body></html>' }), { privacy: { active: false } });
    expect(html).toContain('own doc');
    expect(html).toContain('padding:8px');
  });
  it('clamps tables to the pane exactly like the reader iframe (no tableMode passed by either)', async () => {
    // EmailViewer passes no tableMode to buildEmailIframeHtml and none in the AltBody theme,
    // so both sides take the template's 'preserve' default.
    const clamp = 'table { max-width: 100% !important; width: auto !important; }';
    const iframe = buildEmailIframeHtml({ bodyHtml: '<table width="600"><tr><td>x</td></tr></table>' });
    expect(iframe).toContain(clamp);
    for (const theme of [{ dark: false, palette: 'graphite' }, { dark: true, palette: 'graphite' }]) {
      const { html } = await runPrepass(props({ bodyHtml: '<table width="600"><tr><td>x</td></tr></table>', theme }), { privacy: { active: false } });
      expect(html).toContain(clamp);
      expect(html).not.toContain('table-layout: fixed');
    }
  });
  it('honours theme.tableMode like the iframe template', async () => {
    const { html } = await runPrepass(props({ theme: { dark: false, tableMode: 'clip' } }), { privacy: { active: false } });
    expect(html).toContain('table-layout: fixed');
  });
  it('builds the dark document when theme.dark: inline colour importants are dropped, light keeps them', async () => {
    const bodyHtml = '<h2 style="color:#000 !important; font-size:20px !important">Hi</h2>';
    const dark = await runPrepass(props({ bodyHtml, theme: { dark: true } }), { privacy: { active: false } });
    expect(dark.html).toContain('color:#000;');
    expect(dark.html).toContain('font-size:20px !important');
    expect(dark.html).toContain('data-mv-theme="dark"');
    const light = await runPrepass(props({ bodyHtml, theme: { dark: false } }), { privacy: { active: false } });
    expect(light.html).toContain('color:#000 !important');
    expect(light.html).toContain('data-mv-theme="light"');
  });
  it('is deterministic: the same inputs give byte-identical HTML (no fresh nonce per run)', async () => {
    const a = await runPrepass(props(), { privacy: { active: false } });
    const b = await runPrepass(props(), { privacy: { active: false } });
    expect(b.html).toBe(a.html);
    const c = await runPrepass(props(), { privacy: { active: true, dict: { names: ['Alice'] } } });
    const d = await runPrepass(props(), { privacy: { active: true, dict: { names: ['Alice'] } } });
    expect(d.html).toBe(c.html);
  });
  describe('parity ids (plan B)', () => {
    afterEach(() => { delete globalThis.__MV_PARITY__; });
    it('stamps data-mv-id on body descendants only under __MV_PARITY__', async () => {
      const off = await runPrepass(props({ bodyHtml: '<div><p>a</p><p>b</p></div>' }), { privacy: { active: false } });
      expect(off.doc.querySelector('[data-mv-id]')).toBeNull();
      expect(off.html).not.toContain('data-mv-id');
      globalThis.__MV_PARITY__ = true;
      const on = await runPrepass(props({ bodyHtml: '<div><p>a</p><p>b</p></div>' }), { privacy: { active: false } });
      const ids = [...on.doc.body.querySelectorAll('[data-mv-id]')].map((e) => e.getAttribute('data-mv-id'));
      expect(ids).toEqual(expect.arrayContaining(['div[1]', 'div[1]/p[1]', 'div[1]/p[2]']));
      expect(on.html).toContain('data-mv-id="div[1]/p[2]"');
    });
  });
});
