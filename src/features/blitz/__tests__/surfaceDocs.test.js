// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { surfaceDocs, workerTheme } from '../surfaces/surfaceDocs';

const RAW = '<html><body><p>Hello</p></body></html>';
const label = (d) => `${d.surface}${d.variant ? `-${d.variant}` : ''}-${d.width}`;

describe('surfaceDocs', () => {
  it('light: every body surface, each with an iframe document and a Blitz input', () => {
    const docs = surfaceDocs(RAW, { dark: false, palette: 'graphite' });
    expect(docs.map(label)).toEqual([
      'thread-680', 'fullView-1200', 'original-640', 'popout-800', 'exportBody-820', 'exportHead-820', 'exportCard-820', 'preview-600',
      'bubble-received-300', 'bubble-sent-300',
    ]);
    for (const d of docs) {
      expect(d.iframeHtml.length).toBeGreaterThan(0);
      expect(d.blitz.surface).toBe(d.surface);
      expect(Boolean(d.blitz.documentHtml) !== Boolean(d.blitz.bodyHtml)).toBe(true);
    }
    expect(docs.find((d) => d.surface === 'exportBody').iframeHtml).toContain('Hello');
  });

  it('dark: no preview and no whole export card; the bubble never draws dark', () => {
    const docs = surfaceDocs(RAW, { dark: true, palette: 'graphite' });
    expect(docs.map(label)).toEqual([
      'thread-680', 'fullView-1200', 'original-640', 'popout-800', 'exportBody-820', 'exportHead-820', 'bubble-received-300', 'bubble-sent-300',
    ]);
    expect(docs.find((d) => d.surface === 'thread').blitz.theme.dark).toBe(true);
    expect(docs.find((d) => d.surface === 'exportBody').blitz.theme.dark).toBe(true);
    expect(docs.find((d) => d.surface === 'exportHead').blitz.theme.dark).toBe(false);
    expect(docs.filter((d) => d.surface === 'bubble').every((d) => d.blitz.theme.dark === false)).toBe(true);
  });

  it('workerTheme is the shared rule: the bubble has no canvas colour', () => {
    const docs = surfaceDocs(RAW, { dark: true, palette: 'graphite' });
    expect(workerTheme(docs.find((d) => d.surface === 'bubble').blitz).bg).toBeNull();
    expect(workerTheme(docs.find((d) => d.surface === 'thread').blitz).bg).toMatch(/^#/);
  });
});
