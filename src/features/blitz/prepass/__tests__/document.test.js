// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { buildBlitzDocument, BLITZ_NONCE } from '../document';
import { buildEmailIframeHtml } from '../../../../utils/emailIframeTemplate';
import { getDarkReaderInlineScripts } from '../../../../utils/darkReaderInject';
import { getQuoteFoldingScript, getSignatureFoldingScript } from '../../../../utils/iframeQuoteFolding';

const styles = (html) => html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) || [];

const BODY = '<style>@media (prefers-color-scheme: dark){.c{background:#171717}}</style>'
  + '<h2 style="color:#000 !important; font-size:20px !important">Hi</h2><table width="600"><tr><td>x</td></tr></table>';

describe('buildBlitzDocument', () => {
  for (const dark of [false, true]) {
    it(`styles are byte-identical to the iframe document (${dark ? 'dark' : 'light'})`, () => {
      const nonce = 'n';
      const iframe = buildEmailIframeHtml({
        bodyHtml: BODY,
        themeTag: dark ? 'dark' : 'light',
        extraHead: `${dark ? getDarkReaderInlineScripts({ palette: 'indigo', nonce }) : ''}<style>.mv-ind{outline:1px solid red}</style>`,
        extraBody: `${getQuoteFoldingScript(nonce)}${getSignatureFoldingScript('collapse', nonce)}`,
        nonce,
      });
      const blitz = buildBlitzDocument({ bodyHtml: BODY, indicatorCss: '.mv-ind{outline:1px solid red}', dark });
      expect(styles(blitz)).toEqual(styles(iframe));
    });
  }

  it('dark document strips inline colour importants, light keeps them', () => {
    expect(buildBlitzDocument({ bodyHtml: BODY, dark: true })).toContain('color:#000;');
    expect(buildBlitzDocument({ bodyHtml: BODY, dark: true })).toContain('font-size:20px !important');
    expect(buildBlitzDocument({ bodyHtml: BODY, dark: false })).toContain('color:#000 !important');
  });

  it('carries none of our scripts (only the mail\'s own, inert)', () => {
    expect(buildBlitzDocument({ bodyHtml: '<p>x</p><script>alert(1)</script>', dark: true }).match(/<script\b/gi)).toHaveLength(1);
  });

  it('a leading <style> in the body stays in <body> when the built document is parsed', () => {
    const doc = new DOMParser().parseFromString(buildBlitzDocument({ bodyHtml: '<style>.x{color:red}</style><p class="x">hi</p>' }), 'text/html');
    expect(doc.body.querySelector('style')?.textContent).toBe('.x{color:red}');
  });

  it('uses the constant prepass nonce so equal inputs give equal bytes', () => {
    expect(BLITZ_NONCE).toBe('blitz');
    const a = buildBlitzDocument({ bodyHtml: BODY, dark: true });
    expect(a).toContain(`'nonce-${BLITZ_NONCE}'`);
    expect(buildBlitzDocument({ bodyHtml: BODY, dark: true })).toBe(a);
  });

  it('honours tableMode', () => {
    expect(buildBlitzDocument({ bodyHtml: BODY, tableMode: 'clip' })).toContain('table-layout: fixed');
  });
});
