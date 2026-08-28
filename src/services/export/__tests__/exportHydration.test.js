// @vitest-environment jsdom
//
// buildExport sanitizes with DOMParser; the default node environment has none,
// and vitest.config.js only maps src/components/** to jsdom.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveMessageBody = vi.fn();
vi.mock('../bodyResolver', () => ({ resolveMessageBody: (...a) => resolveMessageBody(...a) }));
vi.mock('../renderMessageToCanvas', () => ({
  renderMessageToCanvas: vi.fn(async () => ({ width: 1640, height: 800, toDataURL: () => 'data:image/png;base64,P' })),
  measureMessageHeight: vi.fn(async () => 400),
}));
vi.mock('../mirrorRemoteAssets', () => ({
  mirrorRemoteAssets: vi.fn(async (html) => ({ html, stats: { mirrored: 0, failed: 0, pixelsRemoved: 0, bytes: 0 } })),
  DEFAULT_CAPS: {},
}));
vi.mock('../imagePacker', async (orig) => ({
  ...(await orig()),
  stitchPages: (c, plan) => plan.map(() => ({ toDataURL: () => 'data:image/png;base64,PAGE' })),
}));
vi.mock('../../../stores/settingsStore', () => ({
  hasPremiumAccess: () => true,
  useSettingsStore: { getState: () => ({ billingProfile: {} }) },
}));
vi.mock('../../../stores/mailStore', () => ({ useMailStore: { getState: () => ({ accounts: [] }) } }));

const { buildExport } = await import('../exportService');

const header = (uid) => ({ uid, from: `s${uid}@x.test`, date: new Date('2026-08-12T09:14:00'), subject: 'Root', messageId: `<${uid}@x>` });
const base = { account: 'r@x.test', mailbox: 'INBOX', mirror: false, format: 'image', layout: 'separate' };

beforeEach(() => resolveMessageBody.mockReset());

describe('hydration', () => {
  it('loads a body for a header that arrived without one', async () => {
    resolveMessageBody.mockResolvedValue({ ok: true, email: { html: '<p>loaded</p>' } });
    const out = await buildExport({ ...base, messages: [header(1)] });
    expect(resolveMessageBody).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(true);
  });

  it('does not re-load a message that already carries its body', async () => {
    const out = await buildExport({ ...base, messages: [{ ...header(1), html: '<p>already here</p>' }] });
    expect(resolveMessageBody).not.toHaveBeenCalled();
    expect(out.ok).toBe(true);
  });

  it('exports the rest and names the one whose body would not load', async () => {
    resolveMessageBody
      .mockResolvedValueOnce({ ok: true, email: { html: '<p>one</p>' } })
      .mockResolvedValueOnce({ ok: false, reason: 'Message-ID mismatch' });
    const out = await buildExport({ ...base, messages: [header(1), header(2)] });
    expect(out.ok).toBe(true);
    expect(out.partial).toBe(true);
    expect(out.files).toHaveLength(1);
    expect(out.failures[0]).toMatchObject({ uid: 2 });
    expect(out.failures[0].error).toMatch(/mismatch/i);
  });
});
