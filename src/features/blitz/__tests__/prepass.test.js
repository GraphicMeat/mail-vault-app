// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
const redact = vi.hoisted(() => ({ throws: false }));
vi.mock('../../../utils/iframePrivacyRedact', () => ({
  applyPrivacyRedaction: (doc, dict) => {
    if (redact.throws) throw new Error('boom');
    for (const name of dict?.names ?? []) doc.body.innerHTML = doc.body.innerHTML.split(name).join('█████');
  },
}));
import { runPrepass } from '../prepass';

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
  it('honours theme.tableMode like the iframe template', async () => {
    const { html } = await runPrepass(props({ theme: { dark: false, tableMode: 'clip' } }), { privacy: { active: false } });
    expect(html).toContain('table-layout: fixed');
  });
});
