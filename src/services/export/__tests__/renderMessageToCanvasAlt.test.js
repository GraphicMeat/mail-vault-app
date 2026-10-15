// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const domToCanvas = vi.fn();
vi.mock('modern-screenshot', () => ({ domToCanvas: (...a) => domToCanvas(...a) }));
const { renderMessageToCanvas } = await import('../renderMessageToCanvas');
const { registerBodyRenderer, _resetBodyRenderersForTest } = await import('../../../components/email/bodyRendererRegistry');
const { useSettingsStore } = await import('../../../stores/settingsStore');

const message = { from: 'A <a@x.test>', to: 'B <b@x.test>', date: new Date('2026-08-28T09:14:00'), subject: 'S', messageId: '<m@x>' };
let getContext;
beforeEach(() => {
  domToCanvas.mockReset(); domToCanvas.mockResolvedValue({ width: 1640, height: 100 });
  getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() });
});
afterEach(() => { getContext.mockRestore(); _resetBodyRenderersForTest(); useSettingsStore.setState({ emailRenderer: 'web' }); document.querySelectorAll('iframe').forEach(f => f.remove()); });

describe('renderMessageToCanvas with an alternative renderer', () => {
  it('uses rasterize and mounts no frame', async () => {
    const canvas = { width: 1640, height: 900 };
    const rasterize = vi.fn(async () => canvas);
    registerBodyRenderer('blitz', { Body: () => null, rasterize });
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    const out = await renderMessageToCanvas({ message, bodyHtml: '<p>B</p>', part: 'body', theme: 'dark', palette: 'indigo', backgroundColor: '#111', loadTimeoutMs: 10 });
    expect(out).toBe(canvas);
    expect(domToCanvas).not.toHaveBeenCalled();
    expect(rasterize).toHaveBeenCalledWith(expect.objectContaining({ width: 820, scale: 2, dark: true, palette: 'indigo', backgroundColor: '#111' }));
    expect(rasterize.mock.calls[0][0].html).toContain('<p>B</p>');
  });

  it('a dark header is CSS-only: not dark for the renderer', async () => {
    const rasterize = vi.fn(async () => ({ width: 1, height: 1 }));
    registerBodyRenderer('blitz', { Body: () => null, rasterize });
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    await renderMessageToCanvas({ message, part: 'head', theme: 'dark', loadTimeoutMs: 10 });
    expect(rasterize.mock.calls[0][0].dark).toBe(false);
  });

  it('null from rasterize fails this message and mounts no frame (A10)', async () => {
    registerBodyRenderer('blitz', { Body: () => null, rasterize: vi.fn(async () => null) });
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    await expect(renderMessageToCanvas({ message, bodyHtml: '<p>B</p>', loadTimeoutMs: 10 })).rejects.toThrow('blitz_export_failed');
    expect(domToCanvas).not.toHaveBeenCalled();
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
  });

  it('a renderer without rasterize leaves the frame path alone', async () => {
    registerBodyRenderer('blitz', { Body: () => null });
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    await renderMessageToCanvas({ message, bodyHtml: '<p>B</p>', loadTimeoutMs: 10 });
    expect(domToCanvas).toHaveBeenCalled();
  });
});
