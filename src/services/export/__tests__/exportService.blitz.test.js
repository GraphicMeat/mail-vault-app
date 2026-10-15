// @vitest-environment jsdom
//
// buildExport over the REAL renderMessageToCanvas with an alternative renderer
// registered: a message the renderer cannot draw (rasterize -> null, e.g. a
// document clamped at the worker's height limit) lands in `failures`, and the
// others still export (overview A10, F12).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../mirrorRemoteAssets', () => ({
  mirrorRemoteAssets: vi.fn(async (html) => ({ html, stats: { mirrored: 0, failed: 0, pixelsRemoved: 0, bytes: 0 } })),
  DEFAULT_CAPS: { perAssetBytes: 1, perDocBytes: 1, concurrency: 6 },
}));
vi.mock('../imagePacker', async (orig) => ({
  ...(await orig()),
  stitchPages: (canvases, plan) => plan.map(() => ({ toDataURL: () => 'data:image/png;base64,PAGE' })),
}));
vi.mock('modern-screenshot', () => ({ domToCanvas: vi.fn() }));
vi.mock('../../../stores/settingsStore', () => ({
  hasPremiumAccess: () => true,
  useSettingsStore: { getState: () => ({ billingProfile: { hasSubscription: true }, emailRenderer: 'blitz' }) },
}));
vi.mock('../../../stores/mailStore', () => ({
  useMailStore: { getState: () => ({ accounts: [], activeAccountId: 'acct-1', activeMailbox: 'INBOX' }) },
}));

const { buildExport } = await import('../exportService');
const { registerBodyRenderer, _resetBodyRenderersForTest } = await import('../../../components/email/bodyRendererRegistry');
const { domToCanvas } = await import('modern-screenshot');

const message = (n) => ({
  uid: n, from: `Sender ${n} <s${n}@x.test>`, to: 'r@x.test',
  date: new Date('2026-08-12T09:14:00'), subject: `S${n}`, messageId: `<${n}@x>`, html: `<p>body ${n}</p>`,
});
const thread = [message(1), message(2)];
const base = { account: 'r@x.test', mailbox: 'INBOX', mirror: true };

afterEach(() => { _resetBodyRenderersForTest(); document.querySelectorAll('iframe').forEach(f => f.remove()); });
beforeEach(() => { domToCanvas.mockReset(); });

describe('buildExport with an alternative renderer', () => {
  it('a message the renderer cannot draw (null) is a failure; the other still exports; no frame', async () => {
    const canvas = { width: 1640, height: 800, toDataURL: () => 'data:image/png;base64,PNGDATA' };
    const rasterize = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(canvas);
    registerBodyRenderer('blitz', { Body: () => null, rasterize });
    const out = await buildExport({ messages: thread, format: 'image', layout: 'separate', ...base });
    expect(out.ok).toBe(true);
    expect(out.partial).toBe(true);
    expect(out.files).toHaveLength(1);
    expect(out.failures).toEqual([expect.objectContaining({ uid: 1, subject: 'S1', error: expect.stringContaining('blitz_export_failed') })]);
    expect(domToCanvas).not.toHaveBeenCalled();
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
  });

  it('every message null: the export fails outright with the failures named', async () => {
    registerBodyRenderer('blitz', { Body: () => null, rasterize: vi.fn(async () => null) });
    const out = await buildExport({ messages: thread, format: 'image', layout: 'separate', ...base });
    expect(out).toMatchObject({ ok: false, reason: 'render' });
    expect(out.failures).toHaveLength(2);
  });
});
