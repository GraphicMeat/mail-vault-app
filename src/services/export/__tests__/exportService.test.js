// @vitest-environment jsdom
//
// buildExport sanitizes every body with DOMParser and encodes with btoa —
// neither exists in the default node environment, and vitest.config.js only
// maps src/components/** to jsdom.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../renderMessageToCanvas', () => ({
  renderMessageToCanvas: vi.fn(async () => ({ width: 1640, height: 800, toDataURL: () => 'data:image/png;base64,PNGDATA' })),
  measureMessageHeight: vi.fn(async () => 400),
}));
vi.mock('../mirrorRemoteAssets', () => ({
  mirrorRemoteAssets: vi.fn(async (html) => ({ html, stats: { mirrored: 0, failed: 0, pixelsRemoved: 0, bytes: 0 } })),
  DEFAULT_CAPS: { perAssetBytes: 1, perDocBytes: 1, concurrency: 6 },
}));
vi.mock('../imagePacker', async (orig) => ({
  ...(await orig()),
  stitchPages: (canvases, plan) => plan.map(() => ({ toDataURL: () => 'data:image/png;base64,PAGE' })),
}));

const hasPremiumAccess = vi.fn(() => true);
vi.mock('../../../stores/settingsStore', () => ({
  hasPremiumAccess: (...a) => hasPremiumAccess(...a),
  useSettingsStore: { getState: () => ({ billingProfile: { hasSubscription: true } }) },
}));

const { buildExport, SAMPLE } = await import('../exportService');
const { renderMessageToCanvas } = await import('../renderMessageToCanvas');
const { mirrorRemoteAssets } = await import('../mirrorRemoteAssets');

const message = (n, iso) => ({
  uid: n, from: `Sender ${n} <s${n}@x.test>`, to: 'r@x.test',
  date: new Date(iso), subject: n === 1 ? 'Root' : 'Re: Root', messageId: `<${n}@x>`, html: `<p>body ${n}</p>`,
});
const thread = [message(1, '2026-08-12T09:14:00'), message(2, '2026-08-20T11:30:00')];
const base = { account: 'r@x.test', mailbox: 'INBOX', mirror: true };

beforeEach(() => {
  hasPremiumAccess.mockReturnValue(true);
  renderMessageToCanvas.mockClear();
  renderMessageToCanvas.mockResolvedValue({ width: 1640, height: 800, toDataURL: () => 'data:image/png;base64,PNGDATA' });
  mirrorRemoteAssets.mockClear();
});

describe('the gate', () => {
  it('refuses a free user before doing any work', async () => {
    hasPremiumAccess.mockReturnValue(false);
    const out = await buildExport({ messages: thread, format: 'image', layout: 'single', ...base });
    expect(out).toMatchObject({ ok: false, reason: 'premium' });
    expect(renderMessageToCanvas).not.toHaveBeenCalled();
  });

  it('lets a premium user through', async () => {
    const out = await buildExport({ messages: thread, format: 'image', layout: 'single', ...base });
    expect(out.ok).toBe(true);
  });

  it('lets samples through while the user is free', async () => {
    hasPremiumAccess.mockReturnValue(false);
    const out = await buildExport({ messages: thread, format: 'image', layout: 'single', gate: SAMPLE, ...base });
    expect(out.ok).toBe(true);
  });
});

describe('image export', () => {
  it('produces one file for a single message', async () => {
    const out = await buildExport({ messages: [thread[0]], format: 'image', layout: 'single', ...base });
    expect(out.files).toHaveLength(1);
    expect(out.files[0].name).toMatch(/\.png$/);
    expect(out.files[0].base64).toBe('PAGE');
  });

  it('produces one file per message in separate layout', async () => {
    const out = await buildExport({ messages: thread, format: 'image', layout: 'separate', ...base });
    expect(out.files).toHaveLength(2);
    expect(out.files[0].name).toMatch(/^01 - /);
    expect(out.files[1].name).toMatch(/^02 - /);
  });

  it('stitches a thread into one file in single layout', async () => {
    const out = await buildExport({ messages: thread, format: 'image', layout: 'single', ...base });
    expect(out.files).toHaveLength(1);
    expect(out.files[0].name).toContain('2026-08-12 to 2026-08-20');
  });
});

describe('html export', () => {
  it('produces one html file for the whole thread', async () => {
    const out = await buildExport({ messages: thread, format: 'html', layout: 'single', ...base });
    expect(out.files).toHaveLength(1);
    expect(out.files[0].name).toMatch(/\.html$/);
    expect(atob(out.files[0].base64)).toContain('<details');
  });
});

describe('the mirror toggle', () => {
  it('mirrors when asked', async () => {
    await buildExport({ messages: [thread[0]], format: 'html', layout: 'single', ...base, mirror: true });
    expect(mirrorRemoteAssets).toHaveBeenCalled();
  });

  it('does not touch the network when turned off', async () => {
    await buildExport({ messages: [thread[0]], format: 'html', layout: 'single', ...base, mirror: false });
    expect(mirrorRemoteAssets).not.toHaveBeenCalled();
  });
});

describe('partial results', () => {
  it('exports the rest and names the message that failed', async () => {
    renderMessageToCanvas.mockRejectedValueOnce(new Error('rasterize failed'));
    const out = await buildExport({ messages: thread, format: 'image', layout: 'separate', ...base });
    expect(out.ok).toBe(true);
    expect(out.partial).toBe(true);
    expect(out.files).toHaveLength(1);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toMatchObject({ uid: 1 });
    expect(out.failures[0].error).toContain('rasterize failed');
  });

  it('fails outright only when nothing could be produced', async () => {
    renderMessageToCanvas.mockRejectedValue(new Error('rasterize failed'));
    const out = await buildExport({ messages: thread, format: 'image', layout: 'separate', ...base });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('render');
    expect(out.files).toHaveLength(0);
  });
});
