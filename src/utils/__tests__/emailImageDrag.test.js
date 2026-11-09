// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { stageFile, startFileDrag } = vi.hoisted(() => ({
  stageFile: vi.fn(async () => '/cache/mailvault-export/chart.png'),
  startFileDrag: vi.fn(async () => {}),
}));
vi.mock('../../services/export/exportSaver', () => ({ stageFile }));
vi.mock('../../services/fileDrag', () => ({
  DRAG_FALLBACK_PNG: 'data:image/png;base64,FALLBACK', startFileDrag,
}));

import { attachImageDrag, dragThumbnail } from '../emailImageDrag';

const png = 'data:image/png;base64,AAAA';
const dispatch = (element) => {
  const event = new Event('dragstart', { bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event;
};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
let detach;

beforeEach(() => {
  window.__TAURI__ = {};
  stageFile.mockClear();
  startFileDrag.mockClear();
  document.body.innerHTML = '';
});
afterEach(() => {
  detach?.();
  detach = null;
  delete window.__TAURI__;
  vi.restoreAllMocks();
});

describe('attachImageDrag', () => {
  it('cancels browser drag and starts a native file drag for an inline image', async () => {
    document.body.innerHTML = `<img src="${png}">`;
    detach = attachImageDrag(document, () => []);
    expect(dispatch(document.querySelector('img')).defaultPrevented).toBe(true);
    await tick();
    expect(stageFile).toHaveBeenCalledWith({ name: 'image.png', base64: 'AAAA' });
    expect(startFileDrag).toHaveBeenCalledWith('/cache/mailvault-export/chart.png', expect.stringMatching(/^data:image\/png/));
  });

  it('names the file from its matching attachment', async () => {
    document.body.innerHTML = `<img src="${png}">`;
    detach = attachImageDrag(document, () => [{ filename: 'chart.png', content: 'AAAA' }]);
    dispatch(document.querySelector('img'));
    await tick();
    expect(stageFile).toHaveBeenCalledWith({ name: 'chart.png', base64: 'AAAA' });
  });

  it('drags SVG and linked images', async () => {
    document.body.innerHTML = `<a href="https://example.test"><img src="${png}"></a><img src="data:image/svg+xml;base64,BBBB">`;
    detach = attachImageDrag(document, () => []);
    const images = document.querySelectorAll('img');
    expect(dispatch(images[0]).defaultPrevented).toBe(true);
    expect(dispatch(images[1]).defaultPrevented).toBe(true);
    await tick();
    expect(stageFile.mock.calls.map(([file]) => file.name)).toEqual(['image.png', 'image.svg']);
  });

  it('leaves remote images, text, and non-Tauri pages to the browser', async () => {
    document.body.innerHTML = `<p>text</p><img src="https://example.test/image.png"><img src="${png}">`;
    detach = attachImageDrag(document, () => []);
    expect(dispatch(document.querySelector('p')).defaultPrevented).toBe(false);
    expect(dispatch(document.querySelector('img')).defaultPrevented).toBe(false);
    delete window.__TAURI__;
    expect(dispatch(document.querySelectorAll('img')[1]).defaultPrevented).toBe(false);
    await tick();
    expect(stageFile).not.toHaveBeenCalled();
  });

  it('uses a PNG fallback when canvas cannot be drawn', async () => {
    document.body.innerHTML = `<img src="${png}">`;
    const image = document.querySelector('img');
    Object.defineProperties(image, { naturalWidth: { value: 1 }, naturalHeight: { value: 1 } });
    detach = attachImageDrag(document, () => []);
    dispatch(image);
    await tick();
    expect(startFileDrag).toHaveBeenCalledWith('/cache/mailvault-export/chart.png', 'data:image/png;base64,FALLBACK');
  });

  it('scales thumbnail longest side to 128 pixels', async () => {
    const image = document.createElement('img');
    Object.defineProperties(image, { naturalWidth: { value: 400 }, naturalHeight: { value: 200 } });
    const context = { drawImage: vi.fn() };
    const canvas = { getContext: () => context, toDataURL: () => 'data:image/png;base64,THUMB' };
    vi.spyOn(document, 'createElement').mockImplementation((name) => name === 'canvas' ? canvas : image);
    expect(dragThumbnail(image)).toBe('data:image/png;base64,THUMB');
    expect([canvas.width, canvas.height]).toEqual([128, 64]);
  });

  it('logs a failed stage without starting a drag', async () => {
    const error = new Error('disk full');
    stageFile.mockRejectedValueOnce(error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    document.body.innerHTML = `<img src="${png}">`;
    detach = attachImageDrag(document, () => []);
    dispatch(document.querySelector('img'));
    await tick();
    expect(log).toHaveBeenCalledWith('[emailImageDrag] drag failed:', error);
    expect(startFileDrag).not.toHaveBeenCalled();
  });

  it('attaches once per document and detaches both callers', async () => {
    document.body.innerHTML = `<img src="${png}">`;
    detach = attachImageDrag(document, () => []);
    expect(attachImageDrag(document, () => [])).toBe(detach);
    dispatch(document.querySelector('img'));
    await tick();
    expect(startFileDrag).toHaveBeenCalledTimes(1);
    detach();
    dispatch(document.querySelector('img'));
    await tick();
    expect(startFileDrag).toHaveBeenCalledTimes(1);
  });
});
