// @vitest-environment jsdom
//
// mirrorRemoteAssets walks the body with DOMParser and encodes with atob —
// neither exists in the default node environment, and vitest.config.js only
// maps src/components/** to jsdom.
import { describe, it, expect, vi } from 'vitest';
import { mirrorRemoteAssets, DEFAULT_CAPS } from '../mirrorRemoteAssets';

const okFetch = (overrides = {}) => vi.fn(async (url) => ({
  mime: 'image/png',
  base64: 'AAAA',
  bytes: 4,
  width: 600,
  height: 400,
  ...overrides,
}));

describe('mirrorRemoteAssets', () => {
  it('rewrites an img src to a data uri', async () => {
    const fetchAsset = okFetch();
    const { html, stats } = await mirrorRemoteAssets('<img src="https://x.test/a.png">', { fetchAsset });
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).not.toContain('https://x.test/a.png');
    expect(stats.mirrored).toBe(1);
    expect(stats.failed).toBe(0);
  });

  it('rewrites every srcset candidate', async () => {
    const fetchAsset = okFetch();
    const { html } = await mirrorRemoteAssets(
      '<img srcset="https://x.test/a.png 1x, https://x.test/b.png 2x">',
      { fetchAsset },
    );
    expect(html).toContain('data:image/png;base64,AAAA 1x');
    expect(html).toContain('data:image/png;base64,AAAA 2x');
    expect(fetchAsset).toHaveBeenCalledTimes(2);
  });

  it('rewrites url() inside inline styles and style blocks', async () => {
    const fetchAsset = okFetch();
    const { html } = await mirrorRemoteAssets(
      '<style>.a{background:url(https://x.test/a.png)}</style><div style="background-image:url(\'https://x.test/b.png\')"></div>',
      { fetchAsset },
    );
    expect(html).not.toContain('https://x.test');
    expect(fetchAsset).toHaveBeenCalledTimes(2);
  });

  it('inlines a remote stylesheet and recurses one level into its urls', async () => {
    const fetchAsset = vi.fn(async (url) => url.endsWith('.css')
      ? { mime: 'text/css', base64: btoa('.a{background:url(https://x.test/deep.png)}'), bytes: 40 }
      : { mime: 'image/png', base64: 'AAAA', bytes: 4, width: 10, height: 10 });
    const { html } = await mirrorRemoteAssets('<link rel="stylesheet" href="https://x.test/s.css">', { fetchAsset });
    expect(html).toContain('<style');
    expect(html).not.toContain('<link');
    expect(html).toContain('data:image/png;base64,AAAA');
  });

  it('leaves data: urls alone and does not fetch them', async () => {
    const fetchAsset = okFetch();
    const { html } = await mirrorRemoteAssets('<img src="data:image/gif;base64,R0lGOD">', { fetchAsset });
    expect(html).toContain('data:image/gif;base64,R0lGOD');
    expect(fetchAsset).not.toHaveBeenCalled();
  });

  it('drops a tracking pixel declared 1x1 without fetching it', async () => {
    const fetchAsset = okFetch();
    const { html, stats } = await mirrorRemoteAssets(
      '<img src="https://track.test/p.gif" width="1" height="1">',
      { fetchAsset },
    );
    expect(html).not.toContain('track.test');
    expect(stats.pixelsRemoved).toBe(1);
    expect(stats.mirrored).toBe(0);
    expect(fetchAsset).not.toHaveBeenCalled();
  });

  it('drops a pixel that only reveals itself as 1x1 once decoded', async () => {
    const fetchAsset = okFetch({ width: 1, height: 1 });
    const { html, stats } = await mirrorRemoteAssets('<img src="https://track.test/p.gif">', { fetchAsset });
    expect(html).not.toContain('track.test');
    expect(stats.pixelsRemoved).toBe(1);
  });

  it('keeps the original url and marks a failure when the fetch throws', async () => {
    const fetchAsset = vi.fn(async () => { throw new Error('offline'); });
    const { html, stats } = await mirrorRemoteAssets('<img src="https://x.test/a.png">', { fetchAsset });
    expect(html).toContain('data-mv-remote-src="https://x.test/a.png"');
    expect(html).toContain('x.test');
    expect(stats.failed).toBe(1);
    expect(stats.mirrored).toBe(0);
  });

  it('refuses an asset over the per-asset cap', async () => {
    const fetchAsset = okFetch({ bytes: DEFAULT_CAPS.perAssetBytes + 1 });
    const { stats } = await mirrorRemoteAssets('<img src="https://x.test/big.png">', { fetchAsset });
    expect(stats.failed).toBe(1);
    expect(stats.mirrored).toBe(0);
  });

  it('stops mirroring once the document cap is reached', async () => {
    const half = Math.ceil(DEFAULT_CAPS.perDocBytes / 2) + 1;
    const fetchAsset = okFetch({ bytes: half });
    const { stats } = await mirrorRemoteAssets(
      '<img src="https://x.test/1.png"><img src="https://x.test/2.png"><img src="https://x.test/3.png">',
      { fetchAsset, caps: { ...DEFAULT_CAPS, perAssetBytes: DEFAULT_CAPS.perDocBytes } },
    );
    expect(stats.mirrored).toBeLessThan(3);
    expect(stats.mirrored).toBeGreaterThan(0);
    expect(stats.failed).toBeGreaterThan(0);
  });

  it('reports bytes actually embedded', async () => {
    const fetchAsset = okFetch({ bytes: 100 });
    const { stats } = await mirrorRemoteAssets('<img src="https://x.test/a.png">', { fetchAsset });
    expect(stats.bytes).toBe(100);
  });

  it('fetches each distinct url once even when repeated', async () => {
    const fetchAsset = okFetch();
    await mirrorRemoteAssets(
      '<img src="https://x.test/logo.png"><img src="https://x.test/logo.png">',
      { fetchAsset },
    );
    expect(fetchAsset).toHaveBeenCalledTimes(1);
  });
});
