import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../../services/transport', () => ({ send: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (p, proto) => `${proto}://localhost/${encodeURIComponent(p)}` }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
import { send } from '../../../services/transport';
import { openRender, tileUrl, hitRender, closeRender, textRunsRender, serializeRender, foldRender, fontsRender } from '../service';

beforeEach(() => { send.mockReset(); });

describe('blitz service', () => {
  it('open forwards params', async () => {
    send.mockResolvedValue({ docId: 4, rev: 1, meta: { tileCount: 2 } });
    const theme = { mode: 'light' };
    const r = await openRender({ html: '<p>x', cssWidth: 640, scale: 2, allowRemote: true, theme });
    expect(send).toHaveBeenCalledWith('render.open', { html: '<p>x', cssWidth: 640, scale: 2, allowRemote: true, theme });
    expect(r.docId).toBe(4);
  });
  it('tileUrl encodes doc/rev/index for the mvrender scheme', () => {
    expect(tileUrl(4, 2, 0)).toBe('mvrender://localhost/4%2F2%2F0');
  });
  it('hit and close call their routes; close never throws', async () => {
    send.mockResolvedValue({ link: null });
    await hitRender(4, 1.5, 2.5);
    expect(send).toHaveBeenCalledWith('render.hit', { docId: 4, x: 1.5, y: 2.5 });
    send.mockRejectedValue(new Error('render_unavailable'));
    await expect(closeRender(4)).resolves.toBeUndefined();
  });
  it('C ops forward to their RPCs', async () => {
    send.mockResolvedValue({});
    await textRunsRender(4, 2);
    expect(send).toHaveBeenLastCalledWith('render.textRuns', { docId: 4, index: 2 });
    await serializeRender(4, { node: 1, offset: 0 }, { node: 1, offset: 3 });
    expect(send).toHaveBeenLastCalledWith('render.serialize', { docId: 4, start: { node: 1, offset: 0 }, end: { node: 1, offset: 3 } });
    await foldRender(4, 'q0', true);
    expect(send).toHaveBeenLastCalledWith('render.fold', { docId: 4, id: 'q0', open: true });
    await fontsRender(['Lora']);
    expect(send).toHaveBeenLastCalledWith('render.fonts', { families: ['Lora'] });
  });
  it('fontsRender never throws', async () => {
    send.mockRejectedValue(new Error('render_unavailable'));
    await expect(fontsRender(['Lora'])).resolves.toEqual({ registered: [] });
  });
});
