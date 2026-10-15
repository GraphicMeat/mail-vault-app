import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../../services/transport', () => ({ send: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (p, proto) => `${proto}://localhost/${encodeURIComponent(p)}` }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
import { send } from '../../../services/transport';
import { onDocGone } from '../surfaces/docGone';
import { openRender, tileUrl, hitRender, closeRender, textRunsRender, serializeRender, foldRender, fontsRender, imageRender, settleRender, tileRender } from '../service';

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
  it('an op that finds its doc gone reports it, then still rejects (3b)', async () => {
    const gone = vi.fn();
    const off = onDocGone(gone);
    send.mockRejectedValue(new Error('render_unknown_doc'));
    await expect(hitRender(4, 0, 0)).rejects.toThrow('render_unknown_doc');
    await expect(textRunsRender(5, 0)).rejects.toThrow('render_unknown_doc');
    await expect(serializeRender(6, {}, {})).rejects.toThrow('render_unknown_doc');
    await expect(foldRender(7, 'q0', true)).rejects.toThrow('render_unknown_doc');
    expect(gone.mock.calls.map(c => c[0])).toEqual([4, 5, 6, 7]);
    send.mockRejectedValue(new Error('render_unavailable'));
    await expect(hitRender(8, 0, 0)).rejects.toThrow('render_unavailable');
    expect(gone).toHaveBeenCalledTimes(4);
    off();
  });
  it('imageRender asks for the whole document, and reports a doc that is gone', async () => {
    send.mockResolvedValue({ png: 'AAAA' });
    await expect(imageRender(4)).resolves.toEqual({ png: 'AAAA' });
    expect(send).toHaveBeenLastCalledWith('render.image', { docId: 4 });
    const gone = vi.fn();
    const off = onDocGone(gone);
    send.mockRejectedValue(new Error('render_unknown_doc'));
    await expect(imageRender(9)).rejects.toThrow('render_unknown_doc');
    expect(gone).toHaveBeenCalledWith(9);
    off();
  });
  it('settleRender is render.image without the paint; tileRender is one tile over the RPC; both report a doc that is gone', async () => {
    send.mockResolvedValue({ settled: true });
    await expect(settleRender(4)).resolves.toEqual({ settled: true });
    expect(send).toHaveBeenLastCalledWith('render.image', { docId: 4, settleOnly: true });
    send.mockResolvedValue({ png: 'AAAA' });
    await expect(tileRender(4, 7)).resolves.toEqual({ png: 'AAAA' });
    expect(send).toHaveBeenLastCalledWith('render.tile', { docId: 4, index: 7 });
    const gone = vi.fn();
    const off = onDocGone(gone);
    send.mockRejectedValue(new Error('render_unknown_doc'));
    await expect(settleRender(9)).rejects.toThrow('render_unknown_doc');
    await expect(tileRender(10, 0)).rejects.toThrow('render_unknown_doc');
    expect(gone.mock.calls.map(c => c[0])).toEqual([9, 10]);
    off();
  });
  it('fontsRender never throws', async () => {
    send.mockRejectedValue(new Error('render_unavailable'));
    await expect(fontsRender(['Lora'])).resolves.toEqual({ registered: [] });
  });
});
