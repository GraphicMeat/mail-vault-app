/*
 * The homepage's "downloads on GitHub" line. Only installers count: the update
 * feed (appcast.xml, latest.json, .sig) is fetched by the app on every update
 * check and would report checks as downloads.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDownloadCounter, countInstallers } = require('../../website/api/downloads.js');

const asset = (name, download_count) => ({ name, download_count });
const release = (...assets) => ({ draft: false, assets });
const reply = (body, link) => ({ ok: true, json: async () => body, headers: { get: (h) => (h === 'link' ? link : null) } });

describe('installer download count', () => {
  it('counts installers per platform and ignores the update feed', () => {
    expect(countInstallers([
      release(asset('MailVault-v2.16.0.dmg', 7), asset('MailVault_2.16.0_x64-setup.exe', 4), asset('MailVault_2.16.0_x64-setup.exe.sig', 9),
        asset('MailVault_2.16.0_amd64.deb', 2), asset('mailvault_2.16.0_arm64.snap', 1), asset('appcast.xml', 24), asset('latest.json', 32)),
      release(asset('MailVault-v2.15.0.dmg', 100)),
      { draft: true, assets: [asset('MailVault-v9.dmg', 1000)] },
    ])).toEqual({ installers: 114, platforms: { mac: 107, windows: 4, linux: 3 } });
  });

  it('follows pagination and asks GitHub at most once an hour', async () => {
    let t = 0;
    const fetch = vi.fn()
      .mockResolvedValueOnce(reply([release(asset('a.dmg', 5))], '<https://api.github.com/x?page=2>; rel="next"'))
      .mockResolvedValueOnce(reply([release(asset('b.deb', 3))]))
      .mockResolvedValue(reply([release(asset('a.dmg', 9)), release(asset('b.deb', 3))]));
    const get = createDownloadCounter({ fetch, now: () => t });
    expect((await get()).installers).toBe(8);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toBe('https://api.github.com/x?page=2');
    t = 59 * 60_000;
    expect((await get()).installers).toBe(8);
    expect(fetch).toHaveBeenCalledTimes(2);
    t = 61 * 60_000;
    expect((await get()).installers).toBe(12);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('serves the last good count when GitHub fails or returns a shorter list', async () => {
    let t = 0;
    const fetch = vi.fn()
      .mockResolvedValueOnce(reply([release(asset('a.dmg', 50))]))
      .mockResolvedValueOnce({ ok: false, status: 403 })
      .mockResolvedValueOnce(reply([release(asset('a.dmg', 10))]));
    const get = createDownloadCounter({ fetch, now: () => t });
    await get();
    t = 2 * 60 * 60_000;
    expect(await get()).toMatchObject({ installers: 50, stale: true });
    expect(await get()).toMatchObject({ installers: 50, stale: true });
  });

  it('fails when there is no count yet, so the page keeps the line hidden', async () => {
    const get = createDownloadCounter({ fetch: vi.fn().mockRejectedValue(new Error('offline')) });
    await expect(get()).rejects.toThrow('offline');
  });

  it('shares one upstream refresh between concurrent visitors', async () => {
    const fetch = vi.fn().mockResolvedValue(reply([release(asset('a.dmg', 1))]));
    const get = createDownloadCounter({ fetch });
    await Promise.all([get(), get(), get()]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
