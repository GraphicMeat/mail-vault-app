// @vitest-environment jsdom
//
// runPrepass with the REAL iframe redaction and a real name dictionary, on the
// DOMParser document the pre-pass builds.
import { describe, it, expect } from 'vitest';
import { runPrepass } from '../prepass';
import { buildNameDictionary } from '../../../utils/privacy/piiDetector';

const dict = buildNameDictionary({ names: ['Zelda Quimby'] });
const props = (over = {}) => ({
  bodyHtml: '<p>Dear Zelda Quimby,</p><p title="Zelda Quimby">mail zq@example.test or call +1 415 555 0134</p>',
  theme: { dark: false }, ...over,
});

describe('runPrepass with the real redaction', () => {
  it('masks names, addresses and numbers in text and attributes', async () => {
    const { html } = await runPrepass(props(), { privacy: { active: true, dict } });
    for (const leak of ['Zelda', 'Quimby', 'zq@example', '555 0134']) expect(html).not.toContain(leak);
    expect(html).toMatch(/x{5}/);
  });
  it('masks inside a surface-built document too', async () => {
    const documentHtml = '<html><head><style>p{margin:0}</style></head><body><p>Hi Zelda Quimby</p></body></html>';
    const { html } = await runPrepass(props({ documentHtml }), { privacy: { active: true, dict } });
    expect(html).not.toContain('Zelda');
    expect(html).toContain('p{margin:0}');
  });
  it('leaves the text alone when privacy is off', async () => {
    const { html } = await runPrepass(props(), { privacy: { active: false, dict } });
    expect(html).toContain('Zelda Quimby');
  });
  it('masked output is also byte-identical across runs', async () => {
    const a = await runPrepass(props(), { privacy: { active: true, dict } });
    const b = await runPrepass(props(), { privacy: { active: true, dict } });
    expect(b.html).toBe(a.html);
  });
});
